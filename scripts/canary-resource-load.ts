import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResourceLedger, WorkItemDispatcher } from "../src/control-plane/index.js";
import type { ResourceVectorV1 } from "../src/domain/index.js";
import {
  createExecutionLease,
  dockerOwnershipLabelMap,
  dockerResourceOwnership,
  reapOwnedDockerResources,
} from "../src/evals/index.js";
import { runCommand } from "../src/foundation/index.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const docker = process.env.HITCH_DOCKER_PATH || "docker";
const base = process.env.HITCH_DOCKER_CANARY_BASE || "ubuntu:24.04";
const expectedCpus = integerEnv("HITCH_LOAD_CANARY_EXPECT_CPUS", 10);
const expectedMemoryMib = integerEnv("HITCH_LOAD_CANARY_EXPECT_MEMORY_MIB", 8 * 1024);
const trials = integerEnv("HITCH_LOAD_CANARY_TRIALS", 20);
const nonce = randomBytes(6).toString("hex");
const root = await mkdtemp(path.join(tmpdir(), "hitch-resource-load-canary-"));
const evalId = `eval_${randomBytes(16).toString("hex")}`;
const evalDirectory = path.join(root, "evals", evalId);
const capacity: ResourceVectorV1 = { cpu_millis: 10_000, memory_bytes: 8 * GIB, container_slots: 8, build_slots: 1 };
const reservation: ResourceVectorV1 = { cpu_millis: 2_000, memory_bytes: 4 * GIB, container_slots: 1, build_slots: 0 };
const dispatcher = new WorkItemDispatcher({ resources: new ResourceLedger(capacity) });
const handles: Array<Awaited<ReturnType<typeof createExecutionLease>>> = [];
const containerIds: string[] = [];
const networkNames: string[] = [];
let activePermits = 0;
let maximumActivePermits = 0;
let maximumRunningContainers = 0;
let oomKilled = 0;
let cleanupDeleted = 0;
const startedAt = Date.now();

try {
  const info = (await command(["info", "--format", "{{.NCPU}} {{.MemTotal}} {{.ServerVersion}}"])).stdout.trim().split(/\s+/);
  const hostCpus = Number(info[0]);
  const hostMemory = Number(info[1]);
  const serverVersion = info[2] || "unknown";
  if (hostCpus !== expectedCpus) throw new Error(`load canary requires ${expectedCpus} Docker CPUs, observed ${hostCpus}`);
  const expectedBytes = expectedMemoryMib * MIB;
  if (!Number.isSafeInteger(hostMemory) || hostMemory < expectedBytes - 512 * MIB || hostMemory > expectedBytes + 128 * MIB) {
    throw new Error(`load canary requires a nominal ${expectedMemoryMib} MiB Docker VM, observed ${Math.round(hostMemory / MIB)} MiB`);
  }
  await command(["image", "inspect", base]);

  const outcomes = await Promise.allSettled(Array.from({ length: trials }, (_, index) => runTrial(index)));
  const failed = outcomes.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
  if (failed.length > 0) throw new Error(`${failed.length} load trial(s) failed: ${failed.map((entry) => String(entry.reason)).join("; ")}`);
  if (maximumActivePermits !== 2) throw new Error(`resource admission reached ${maximumActivePermits} concurrent trials instead of exactly 2`);
  if (maximumRunningContainers !== 2) throw new Error(`Docker reached ${maximumRunningContainers} concurrent canary containers instead of exactly 2`);
  if (oomKilled !== 0) throw new Error(`${oomKilled} canary containers were OOM-killed`);
  if (handles.length !== trials || Object.values(dispatcher.resources.snapshot().allocated).some((value) => value !== 0)) {
    throw new Error("load canary leaked a resource reservation");
  }

  const cleanupStartedAt = Date.now();
  const report = await reapOwnedDockerResources({ root, dockerExecutable: docker, leaseIds: handles.map((handle) => handle.leaseId) });
  cleanupDeleted = report.deleted.length;
  if (report.issues.length > 0 || report.retained.length > 0) throw new Error(`fenced Docker cleanup was incomplete: ${JSON.stringify(report)}`);
  if (cleanupDeleted !== trials * 2) throw new Error(`fenced Docker cleanup deleted ${cleanupDeleted} resources instead of ${trials * 2}`);
  if (Date.now() - cleanupStartedAt > 60_000) throw new Error("fenced Docker cleanup exceeded 60 seconds");
  const remainingContainers = (await command(["container", "ls", "--all", "--filter", `label=io.hitch.eval-id=${evalId}`, "--format", "{{.ID}}"]))
    .stdout.trim();
  const remainingNetworks = (await command(["network", "ls", "--filter", `label=io.hitch.eval-id=${evalId}`, "--format", "{{.ID}}"]))
    .stdout.trim();
  if (remainingContainers || remainingNetworks) throw new Error("fenced Docker cleanup left eval resources behind");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    docker: serverVersion,
    docker_cpus: hostCpus,
    docker_memory_bytes: hostMemory,
    requested_max_concurrent: 8,
    trial_reservation: reservation,
    trials,
    maximum_admitted_trials: maximumActivePermits,
    maximum_running_containers: maximumRunningContainers,
    oom_killed: oomKilled,
    cleanup_deleted_resources: cleanupDeleted,
    duration_ms: Date.now() - startedAt,
  }, null, 2)}\n`);
} finally {
  dispatcher.close();
  await Promise.allSettled(handles.map((handle) => handle.release()));
  for (const id of containerIds) await command(["container", "rm", "--force", id]).catch(() => {});
  for (const name of networkNames) await command(["network", "rm", name]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}

async function runTrial(index: number): Promise<void> {
  const suffix = index.toString(16).padStart(32, "0");
  const workId = `work_${suffix}`;
  const permit = await dispatcher.acquire({
    evalId,
    workId,
    maxParallelism: 8,
    reservation,
    collisionKeys: [`load-task-${index}`],
  });
  activePermits += 1;
  maximumActivePermits = Math.max(maximumActivePermits, activePermits);
  try {
    const handle = await createExecutionLease({
      evalDirectory,
      evalId,
      workId,
      worker: {
        workerId: "worker_load_canary",
        provider: "local-docker",
        collisionDomainId: "docker:load-canary",
        parentAllocationId: permit.allocation.allocation_id,
      },
      reservation,
      ttlMs: 60_000,
    });
    handles.push(handle);
    await handle.markRunning();
    const ownership = dockerResourceOwnership(root, handle.current(), `load-task-${index}`);
    const labels = dockerOwnershipLabelMap(ownership);
    const networkName = `hitch-load-${nonce}-${index}`;
    const labelArgs = Object.entries(labels).flatMap(([name, value]) => ["--label", `${name}=${value}`]);
    await command(["network", "create", ...labelArgs, networkName]);
    networkNames.push(networkName);
    const container = (await command([
      "container", "run", "--detach", "--name", `hitch-load-${nonce}-${index}`,
      "--cpus", "2", "--memory", "4g", "--memory-swap", "4g", "--network", networkName,
      ...labelArgs,
      base,
      "/bin/sh", "-c", "i=0; while [ \"$i\" -lt 200000 ]; do i=$((i+1)); done; sleep 0.5",
    ])).stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(container)) throw new Error(`Docker returned an invalid container id for trial ${index}`);
    containerIds.push(container);
    const running = (await command(["container", "ls", "--filter", `label=io.hitch.eval-id=${evalId}`, "--format", "{{.ID}}"]))
      .stdout.split(/\r?\n/).filter(Boolean).length;
    maximumRunningContainers = Math.max(maximumRunningContainers, running);
    const exitCode = Number((await command(["container", "wait", container], 30_000)).stdout.trim());
    const inspected = JSON.parse((await command(["container", "inspect", "--format", "{{json .}}", container])).stdout) as {
      State?: { OOMKilled?: unknown };
      HostConfig?: { NanoCpus?: unknown; Memory?: unknown; MemorySwap?: unknown };
    };
    if (inspected.State?.OOMKilled === true) oomKilled += 1;
    if (inspected.HostConfig?.NanoCpus !== 2_000_000_000 || inspected.HostConfig.Memory !== 4 * GIB || inspected.HostConfig.MemorySwap !== 4 * GIB) {
      throw new Error(`load trial ${index} did not receive the requested Docker hard limits`);
    }
    if (exitCode !== 0) throw new Error(`load trial ${index} exited with ${exitCode}`);
    await handle.release();
  } finally {
    activePermits -= 1;
    permit.release();
  }
}

async function command(args: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
  return runCommand(docker, args, { env: process.env, timeoutMs, failureCode: "resource_load_canary_failed" });
}

function integerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}
