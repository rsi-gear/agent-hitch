import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BackendWorkItemV1, ExecutionProviderStatusV1 } from "../src/domain/index.js";
import { adoptLocalDockerLeaseEpoch, createExecutionLease, LocalDockerExecutionProvider, parseExecutionProviderStatus, parseLocalProviderExecutionRecord, readLocalDockerProcessRecord, recordLocalDockerProcessStart, releaseLocalDockerProcessRecord, waitForLocalDockerProcessTerminal } from "../src/evals/index.js";
import { captureProcessIdentity, inspectProcessIdentity } from "../src/foundation/index.js";

const evalId = "eval_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const workId = "work_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const reservation = { cpu_millis: 1_000, memory_bytes: 1024, container_slots: 1, build_slots: 0 };

test("process start identity detects a live process and PID identity mismatch", async () => {
  if (process.platform === "win32") return;
  const identity = await captureProcessIdentity(process.pid);
  assert.ok(identity);
  assert.equal(await inspectProcessIdentity(identity), "running");
  const forged = { ...identity, start_identity: `sha256:${"f".repeat(64)}` as const };
  assert.equal(await inspectProcessIdentity(forged), "identity-mismatch");
});

test("provider records reject unknown status fields and escaping backend paths", () => {
  assert.throws(() => parseExecutionProviderStatus({ ...providerStatus("worker_test"), surprise: true }), /identity is invalid/);
  const now = new Date().toISOString();
  assert.throws(() => parseLocalProviderExecutionRecord({
    schema_version: "1",
    provider: "local-docker",
    worker_id: "worker_test",
    eval_id: evalId,
    work_id: workId,
    lease_id: "lease_cccccccccccccccccccccccccccccccc",
    lease_epoch: 1,
    backend_directory: "../other-eval",
    process: { pid: 1, start_identity: `sha256:${"a".repeat(64)}`, observed_at: now },
    state: "running",
    started_at: now,
  }), /identity is invalid/);
});

test("local Docker provider records process identity and classifies recovery without replay", async (t) => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "hitch-local-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evalDirectory = path.join(root, "evals", evalId);
  const backendDirectory = path.join(evalDirectory, "harbor", "work-items", workId, "epoch-000001");
  await mkdir(backendDirectory, { recursive: true });
  const workerId = "worker_local_test";
  const lease = await createExecutionLease({
    evalDirectory,
    evalId,
    workId,
    worker: { workerId, provider: "local-docker", collisionDomainId: "docker:test" },
    reservation,
    ttlMs: 60_000,
  });
  const activeLease = await lease.markRunning(1);
  const provider = new LocalDockerExecutionProvider({ root, workerId, status: () => providerStatus(workerId) });
  const work: BackendWorkItemV1 = {
    schema_version: "1",
    work_id: workId,
    eval_id: evalId,
    backend: "harbor",
    logical_attempt: 1,
    task_ids: ["task-a"],
    slots: ["slot_a"],
    opaque_membership: false,
    requested_parallelism: 1,
    reservation,
    provider: "local-docker",
  };
  assert.equal((await provider.offer(activeLease, work)).accepted, true);
  assert.equal((await provider.plan({
    work,
    platform: `${process.platform}-${process.arch}`,
    adapter_requirements: { harness_id: "pi", needs_docker: true, needs_model_proxy: false },
  })).supported, true);

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  assert.ok(child.pid);
  const record = await provider.processStarted({ evalDirectory, lease: activeLease, backendDirectory, pid: child.pid });
  assert.equal(record.state, "running");
  assert.equal((await provider.recover(activeLease)).state, "running");
  await assert.rejects(provider.release(lease.leaseId, 1), (error: unknown) => (error as { code?: string }).code === "provider_release_active");
  const adopted = await provider.adoptLeaseEpoch(lease.leaseId, 1, 2);
  const recoveredLease = { ...activeLease, epoch: 2 };
  assert.equal(adopted.lease_epoch, 2);
  assert.equal((await provider.recover(recoveredLease)).state, "running");
  await assert.rejects(provider.release(lease.leaseId, 1), (error: unknown) => (error as { code?: string }).code === "lease_epoch_mismatch");

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  await provider.cancel(lease.leaseId, 2);
  const result = await exited;
  await provider.processExited({ leaseId: lease.leaseId, epoch: 2, ...result });
  assert.equal((await provider.recover(recoveredLease)).state, "terminal-uncollected");
  await assert.rejects(provider.release(lease.leaseId, 3), (error: unknown) => (error as { code?: string }).code === "lease_epoch_mismatch");
  await provider.release(lease.leaseId, 2);
  assert.equal((await provider.recover(recoveredLease)).state, "released");
  await assert.rejects(provider.adoptLeaseEpoch(lease.leaseId, 2, 3), (error: unknown) => (error as { code?: string }).code === "provider_process_released");
});

test("local Docker provider reconciles an orphaned terminal process without inventing an exit code", async (t) => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "hitch-local-provider-reconcile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evalDirectory = path.join(root, "evals", evalId);
  const backendDirectory = path.join(evalDirectory, "harbor", "work-items", workId, "epoch-000001");
  await mkdir(backendDirectory, { recursive: true });
  const workerId = "worker_local_reconcile";
  const lease = await createExecutionLease({
    evalDirectory,
    evalId,
    workId,
    worker: { workerId, provider: "local-docker", collisionDomainId: "docker:test" },
    reservation,
    ttlMs: 60_000,
  });
  const activeLease = await lease.markRunning(1);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 25)"], { stdio: "ignore", detached: true });
  assert.ok(child.pid);
  await recordLocalDockerProcessStart({ root, workerId, evalDirectory, lease: activeLease, backendDirectory, pid: child.pid });
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  const terminal = await waitForLocalDockerProcessTerminal({ root, leaseId: lease.leaseId, epoch: 1, pollIntervalMs: 5 });
  assert.equal(terminal.state, "terminal");
  assert.equal(terminal.process_exit_code, null);
  assert.equal(terminal.signal, null);
  assert.deepEqual(await readLocalDockerProcessRecord({ root, leaseId: lease.leaseId, epoch: 1 }), terminal);
  const adopted = await adoptLocalDockerLeaseEpoch({ root, leaseId: lease.leaseId, expectedEpoch: 1, nextEpoch: 2 });
  assert.equal(adopted.state, "terminal");
  await releaseLocalDockerProcessRecord({ root, leaseId: lease.leaseId, epoch: 2 });
});

function providerStatus(workerId: string): ExecutionProviderStatusV1 {
  return {
    schema_version: "1",
    provider: "local-docker",
    worker_id: workerId,
    collision_domain_id: "docker:test",
    health: "healthy",
    platforms: [`${process.platform}-${process.arch}`],
    backends: [{ id: "harbor", version: "0.21.0" }],
    features: { docker: true, buildkit: true, model_proxy: false, isolated_same_task_attempts: false },
    capacity: { total: reservation, allocatable: reservation, allocated: { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 } },
    heartbeat_at: new Date().toISOString(),
  };
}
