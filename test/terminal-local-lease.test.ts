import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteJSON, hitchRootId } from "../src/foundation/index.js";
import { buildEvalExecutionPlan, createExecutionLease, createEvalProgress, markExecutionLeaseLost, readExecutionLeases,
  readLocalDockerProcessRecordByLease, recordLocalDockerProcessExit, recordLocalDockerProcessStart, recoverLocalDockerEvalLeases,
  releaseLocalDockerProcessRecord, validateEvalId, validateEvalRequest } from "../src/evals/index.js";
import { bindPhaseDockerBackend, preparePhaseDockerExecution } from "../src/evals/phase-docker-backend.js";
import { reapStartupDockerResources } from "../src/control-plane/startup-docker-cleanup.js";
import { installEmptyDockerBackendForTest } from "../test-support/empty-docker-backend.js";

async function fixture(t: TestContext, resultPresent = true) {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-terminal-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evalId = validateEvalId(`eval_${"a".repeat(32)}`);
  const request = await validateEvalRequest({ dataset: "demo@1.0", harness_ref: "pi@version:1.2.3", max_concurrent: 1 });
  const plan = buildEvalExecutionPlan({ evalId, request,
    candidate: { revisionIdentity: `sha256:${"b".repeat(64)}`, artifactId: `sha256:${"c".repeat(64)}` },
    tasks: ["one"], maxParallelism: 1, workItemMode: "task-slots", resourceProfiling: {
      schema_version: "1", unknown_max_parallelism: 1, requested_parallelism: 1, scope: "worker", approvals: [],
    } });
  const work = plan.work_items[0]!, evalDirectory = path.join(root, "evals", evalId);
  const backendDirectory = path.join(evalDirectory, "harbor", "work-items", work.work_id, "epoch-000001");
  await atomicWriteJSON(path.join(evalDirectory, "execution-plan.json"), plan);
  await atomicWriteJSON(path.join(evalDirectory, "plan.json"), {});
  await atomicWriteJSON(path.join(evalDirectory, "resolution.json"), { identity: `sha256:${"b".repeat(64)}` });
  await atomicWriteJSON(path.join(evalDirectory, "request.json"), request);
  await atomicWriteJSON(path.join(evalDirectory, "progress.json"), createEvalProgress({ evalId,
    benchmarkId: plan.benchmark.id, benchmarkRevision: plan.benchmark.revision, plannedTasks: 1, plannedTrials: 1, startedAt: new Date().toISOString() }));
  // A setup failure can leave an aggregate with no trial directories.
  if (resultPresent) await atomicWriteJSON(path.join(backendDirectory, "job", "result.json"), { trial_results: [] });
  const worker = { workerId: "local", provider: "local-docker", collisionDomainId: "local" };
  const lease = await createExecutionLease({ evalDirectory, evalId, workId: work.work_id, worker, reservation: work.reservation, ttlMs: 45000 });
  const env: NodeJS.ProcessEnv = { ...process.env }; await installEmptyDockerBackendForTest(root, env);
  await preparePhaseDockerExecution({ root, lease: lease.current() });
  await bindPhaseDockerBackend({ root, lease: lease.current(), env });
  await lease.markRunning();
  const child = spawn(process.execPath, ["-e", "process.on('message', () => process.exit(42))"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await exited; });
  assert.ok(child.pid);
  await recordLocalDockerProcessStart({ root, workerId: worker.workerId, evalDirectory, lease: lease.current(), backendDirectory, pid: child.pid });
  const finish = async () => {
    child.send("finish"); const exit = await exited; assert.equal(exit.code, 42);
    await recordLocalDockerProcessExit({ root, leaseId: lease.leaseId, epoch: 1, ...exit });
  };
  const clean = { schema_version: "1" as const, root_id: hitchRootId(root), scanned: 0, deleted: [], retained: [], issues: [] };
  const startup = { root, env, emit: () => {}, reaper: async () => clean };
  const provider = () => readLocalDockerProcessRecordByLease({ root, evalId, leaseId: lease.leaseId });
  return { root, evalId, evalDirectory, lease, env, finish, clean, startup, provider };
}

test("failed terminal recovery releases its lease even when result collection fails", async t => {
  for (const resultPresent of [true, false]) await t.test(String(resultPresent), async t => {
    const f = await fixture(t, resultPresent); await f.finish();
    const recovered = await recoverLocalDockerEvalLeases({ root: f.root, evalId: f.evalId, evalDirectory: f.evalDirectory,
      leases: await readExecutionLeases(f.evalDirectory), env: f.env });
    assert.equal(recovered.status, "ambiguous");
    assert.equal(recovered.code, resultPresent ? "harbor_failed" : "recovery_collection_missing");
    assert.equal((await readExecutionLeases(f.evalDirectory))[0]!.state, "released");
    assert.equal((await f.provider()).state, "released");
    assert.equal((await f.provider()).process_exit_code, 42);
    await reapStartupDockerResources(f.startup);
    await reapStartupDockerResources(f.startup);
  });
});

test("startup reconciles old lost leases with terminal provider evidence but still requires Docker cleanup", async t => {
  for (const providerReleased of [false, true]) await t.test(String(providerReleased), async t => {
    const f = await fixture(t); await f.finish();
    if (providerReleased) await releaseLocalDockerProcessRecord({ root: f.root, leaseId: f.lease.leaseId, epoch: 1 });
    const lost = await markExecutionLeaseLost({ evalDirectory: f.evalDirectory, leaseId: f.lease.leaseId, expectedEpoch: 1 });
    assert.equal(lost.state, "lost"); assert.equal(lost.epoch, 2);
    await atomicWriteJSON(path.join(f.evalDirectory, "result.json"), { status: "failed" });
    await assert.rejects(reapStartupDockerResources({ ...f.startup, reaper: async () => ({ ...f.clean,
      issues: [{ kind: "container", stage: "delete", message: "unconfirmed" }] }) }), { code: "phase_cleanup_unconfirmed" });
    const reconciled = (await readExecutionLeases(f.evalDirectory))[0]!;
    assert.equal(reconciled.state, "released"); assert.equal(reconciled.epoch, lost.epoch);
    assert.deepEqual(reconciled.resource_epochs, lost.resource_epochs);
    assert.equal((await f.provider()).state, "released");
    await reapStartupDockerResources(f.startup);
    await reapStartupDockerResources(f.startup);
  });
});

test("lost leases with a running host process or mismatched provider epoch stay fenced", async t => {
  const f = await fixture(t);
  await markExecutionLeaseLost({ evalDirectory: f.evalDirectory, leaseId: f.lease.leaseId, expectedEpoch: 1 });
  await assert.rejects(reapStartupDockerResources(f.startup), { code: "phase_cleanup_unconfirmed" });
  assert.equal((await readExecutionLeases(f.evalDirectory))[0]!.state, "lost");
  const providerFile = path.join(f.evalDirectory, "provider", "leases", `${f.lease.leaseId}.json`);
  const running = await f.provider();
  for (const state of ["terminal", "released"]) {
    await atomicWriteJSON(providerFile, { ...running, state, completed_at: new Date().toISOString(), process_exit_code: 42 });
    await assert.rejects(reapStartupDockerResources(f.startup), { code: "phase_cleanup_unconfirmed" });
    assert.equal((await readExecutionLeases(f.evalDirectory))[0]!.state, "lost");
  }
  await atomicWriteJSON(providerFile, running);
  await f.finish();
  const provider = await f.provider();
  await atomicWriteJSON(providerFile, { ...provider, lease_epoch: 7 });
  await assert.rejects(reapStartupDockerResources(f.startup), { code: "phase_cleanup_unconfirmed" });
  assert.equal((await readExecutionLeases(f.evalDirectory))[0]!.state, "lost");
});
