import { fileURLToPath } from "node:url";
import { DaemonServer, daemonClient, probeDaemonHealth, readDaemonLogs, startDetachedDaemon } from "../../daemon/index.js";
import type { DaemonResourcePolicy } from "../../daemon/index.js";
import { discoverAgents } from "../../adapters/index.js";
import { DEFAULT_MAX_CONCURRENT, DEFAULT_PORT, HitchError, SCHEMA_VERSION, delay, invalidInput, positiveInteger, runCommand } from "../../foundation/index.js";
import { assertNoArgs, parseRunRequest, takeFlag, takeOption } from "../arguments.js";
import { waitForDaemonRun } from "../output.js";

const executable = fileURLToPath(new URL("../../../bin/hitch.js", import.meta.url));

export async function ensureLocalInferenceDaemon(root: string): Promise<void> {
  if ((await probeDaemonHealth(root))?.status === "running") return;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (env.HITCH_CAPACITY_GPUS === undefined) {
    try {
      const observed = await runCommand(env.HITCH_NVIDIA_SMI_PATH || "nvidia-smi", ["-L"], {
        env, timeoutMs: 5_000, failureCode: "gpu_detection_failed",
      });
      if (observed.stdout.trim()) env.HITCH_CAPACITY_GPUS = "1";
    } catch { /* CPU-only daemon capacity remains valid. */ }
  }
  const resourcePolicy = await parseDaemonResourcePolicy([], DEFAULT_MAX_CONCURRENT, { env });
  const child = await startDetachedDaemon({ root, executable, port: 0, maxConcurrent: DEFAULT_MAX_CONCURRENT, resourcePolicy });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await delay(100);
    const current = await probeDaemonHealth(root);
    if (current?.status === "running") return;
  }
  throw new HitchError(`local inference daemon did not become ready; see ${child.errorLog}`, {
    code: "daemon_start_failed", exitCode: 12,
  });
}

export async function daemonCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  switch (action) {
    case "serve": return daemonServe(args, root);
    case "start": return daemonStart(args, root);
    case "stop": return daemonStop(args, root);
    case "status": return daemonStatus(args, root);
    case "submit": return daemonSubmit(args, root);
    case "cancel": return daemonCancel(args, root);
    case "logs": return daemonLogs(args, root);
    default: throw invalidInput("daemon requires start, serve, stop, status, submit, cancel, or logs");
  }
}

async function daemonServe(args: string[], root: string): Promise<void> {
  const port = Number(takeOption(args, "--port") || DEFAULT_PORT);
  const maxConcurrent = positiveInteger(takeOption(args, "--max-concurrent") || DEFAULT_MAX_CONCURRENT, "--max-concurrent");
  validatePort(port);
  const resourcePolicy = await parseDaemonResourcePolicy(args, maxConcurrent);
  assertNoArgs(args);
  return serveDaemon(root, port, maxConcurrent, resourcePolicy);
}

async function serveDaemon(root: string, port: number, maxConcurrent: number, resourcePolicy: DaemonResourcePolicy): Promise<void> {
  const server = new DaemonServer({
    root,
    port,
    maxConcurrent,
    discoverHarnesses: discoverAgents,
    resourceCapacity: resourcePolicy.capacity,
    runResources: resourcePolicy.run,
    evalTrialResources: resourcePolicy.eval_trial,
  });
  await server.start();
  const shutdown = () => server.close().catch((error) => process.stderr.write(`shutdown error: ${(error as Error).message}\n`));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.closed;
}

async function daemonStart(args: string[], root: string): Promise<void> {
  const foreground = takeFlag(args, "--foreground");
  const port = Number(takeOption(args, "--port") || DEFAULT_PORT);
  const maxConcurrent = positiveInteger(takeOption(args, "--max-concurrent") || DEFAULT_MAX_CONCURRENT, "--max-concurrent");
  validatePort(port);
  const resourcePolicy = await parseDaemonResourcePolicy(args, maxConcurrent);
  assertNoArgs(args);
  const health = await probeDaemonHealth(root);
  if (health?.status === "running") throw new HitchError(`daemon is already running (pid ${health.pid})`, { code: "already_running", exitCode: 2 });
  if (foreground) return serveDaemon(root, port, maxConcurrent, resourcePolicy);

  const child = await startDetachedDaemon({ root, executable, port, maxConcurrent, resourcePolicy });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await delay(100);
    const current = await probeDaemonHealth(root);
    if (current?.status === "running" && current.pid === child.pid) {
      process.stdout.write(`Hitch daemon started (pid ${current.pid}, port ${current.port})\n`);
      return;
    }
  }
  throw new HitchError(`daemon did not become ready; see ${child.errorLog}`, { code: "daemon_start_failed", exitCode: 12 });
}

export async function parseDaemonResourcePolicy(
  args: string[],
  maxConcurrent: number,
  options: {
    env?: NodeJS.ProcessEnv;
    detect?: (env: NodeJS.ProcessEnv) => Promise<{ cpu_millis?: number; memory_bytes?: number }>;
  } = {},
): Promise<DaemonResourcePolicy> {
  const env = options.env ?? process.env;
  const capacityCpuOption = policyOption(takeOption(args, "--capacity-cpu-millis"), env.HITCH_CAPACITY_CPU_MILLIS);
  const capacityMemoryOption = policyOption(takeOption(args, "--capacity-memory-mib"), env.HITCH_CAPACITY_MEMORY_MIB);
  const containerSlotsOption = policyOption(takeOption(args, "--container-slots"), env.HITCH_CONTAINER_SLOTS);
  const buildSlotsOption = policyOption(takeOption(args, "--build-slots"), env.HITCH_BUILD_SLOTS);
  const capacityGpuOption = policyOption(takeOption(args, "--capacity-gpus"), env.HITCH_CAPACITY_GPUS);
  const capacityGpus = parseNonNegative(capacityGpuOption, 0, "--capacity-gpus");
  const capacityDiskOption = policyOption(takeOption(args, "--capacity-ephemeral-disk-mib"), env.HITCH_CAPACITY_EPHEMERAL_DISK_MIB);
  const capacityDisk = mib(parseNonNegative(capacityDiskOption, 0, "--capacity-ephemeral-disk-mib"), "--capacity-ephemeral-disk-mib");
  const runCpu = parsePositive(policyOption(takeOption(args, "--run-cpu-millis"), env.HITCH_RUN_CPU_MILLIS), 1_000, "--run-cpu-millis");
  const runMemory = mib(parsePositive(policyOption(takeOption(args, "--run-memory-mib"), env.HITCH_RUN_MEMORY_MIB), 512, "--run-memory-mib"), "--run-memory-mib");
  const evalCpu = parsePositive(policyOption(takeOption(args, "--eval-cpu-millis"), env.HITCH_EVAL_CPU_MILLIS), 1_000, "--eval-cpu-millis");
  const evalMemory = mib(parsePositive(policyOption(takeOption(args, "--eval-memory-mib"), env.HITCH_EVAL_MEMORY_MIB), 1_024, "--eval-memory-mib"), "--eval-memory-mib");
  const evalGpuOption = policyOption(takeOption(args, "--eval-gpus"), env.HITCH_EVAL_GPUS);
  const evalGpus = parseNonNegative(evalGpuOption, 0, "--eval-gpus");
  const evalDiskOption = policyOption(takeOption(args, "--eval-ephemeral-disk-mib"), env.HITCH_EVAL_EPHEMERAL_DISK_MIB);
  const evalDisk = mib(parseNonNegative(evalDiskOption, 0, "--eval-ephemeral-disk-mib"), "--eval-ephemeral-disk-mib");
  if (evalGpus > capacityGpus) throw invalidInput("--eval-gpus cannot exceed --capacity-gpus");
  if (evalDisk > capacityDisk) throw invalidInput("--eval-ephemeral-disk-mib cannot exceed --capacity-ephemeral-disk-mib");
  const detected = capacityCpuOption === undefined || capacityMemoryOption === undefined || containerSlotsOption === undefined
    ? await (options.detect ?? detectDockerResourceCapacity)(env)
    : {};
  const capacityCpu = parsePositive(capacityCpuOption, detected.cpu_millis ?? 1_000, "--capacity-cpu-millis");
  const capacityMemory = mib(parsePositive(capacityMemoryOption, detected.memory_bytes === undefined ? 1_024 : bytesToWholeMib(detected.memory_bytes), "--capacity-memory-mib"), "--capacity-memory-mib");
  const derivedSlots = capacityMemoryOption === undefined && detected.memory_bytes === undefined
    ? 1
    : Math.min(maxConcurrent, Math.floor(capacityCpu / evalCpu), Math.floor(capacityMemory / evalMemory));
  const containerSlots = parseNonNegative(containerSlotsOption, derivedSlots, "--container-slots");
  const buildSlots = parseNonNegative(buildSlotsOption, 1, "--build-slots");
  return {
    capacity: { cpu_millis: capacityCpu, memory_bytes: capacityMemory, container_slots: containerSlots, build_slots: buildSlots, ...(capacityGpuOption === undefined ? {} : { gpu_count: capacityGpus }), ...(capacityDiskOption === undefined ? {} : { ephemeral_disk_bytes: capacityDisk }) },
    run: { cpu_millis: runCpu, memory_bytes: runMemory, container_slots: 0, build_slots: 0 },
    eval_trial: { cpu_millis: evalCpu, memory_bytes: evalMemory, container_slots: 1, build_slots: 0, ...(evalGpuOption === undefined ? {} : { gpu_count: evalGpus }), ...(evalDiskOption === undefined ? {} : { ephemeral_disk_bytes: evalDisk }) },
  };
}

export async function detectDockerResourceCapacity(env: NodeJS.ProcessEnv = process.env): Promise<{ cpu_millis?: number; memory_bytes?: number }> {
  try {
    const docker = env.HITCH_DOCKER_PATH?.trim() || "docker";
    const output = await runCommand(docker, ["info", "--format", "{{json .}}"], {
      env,
      timeoutMs: 5_000,
      failureCode: "docker_capacity_detection_failed",
    });
    const info = JSON.parse(output.stdout) as { NCPU?: unknown; MemTotal?: unknown };
    const cpus = Number(info.NCPU);
    const memory = Number(info.MemTotal);
    const cpuMillis = Number.isSafeInteger(cpus) && cpus > 0 ? Math.max(1_000, (cpus - 1) * 1_000) : undefined;
    const memoryBytes = Number.isSafeInteger(memory) && memory > 0
      ? Math.max(1024 * 1024, Math.floor((memory - 1024 ** 3) / (1024 * 1024)) * 1024 * 1024)
      : undefined;
    return {
      ...(cpuMillis === undefined ? {} : { cpu_millis: cpuMillis }),
      ...(memoryBytes === undefined ? {} : { memory_bytes: memoryBytes }),
    };
  } catch {
    return {};
  }
}

function policyOption(cli: string | undefined, environment: string | undefined): string | undefined {
  if (cli !== undefined) return cli;
  const value = environment?.trim();
  return value ? value : undefined;
}

function bytesToWholeMib(value: number): number {
  const result = Math.floor(value / (1024 * 1024));
  if (!Number.isSafeInteger(result) || result <= 0) throw invalidInput("detected Docker memory capacity is invalid");
  return result;
}

function parsePositive(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value === undefined ? fallback : value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw invalidInput(`${name} must be a positive integer`);
  return parsed;
}

function parseNonNegative(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value === undefined ? fallback : value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalidInput(`${name} must be a non-negative integer`);
  return parsed;
}

function mib(value: number, name: string): number {
  const bytes = value * 1024 * 1024;
  if (!Number.isSafeInteger(bytes)) throw invalidInput(`${name} is too large`);
  return bytes;
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw invalidInput("--port must be between 0 and 65535");
}

async function daemonStop(args: string[], root: string): Promise<void> {
  assertNoArgs(args);
  const client = await daemonClient(root);
  const response = await client.request("/shutdown", { method: "POST" });
  process.stdout.write(`${response.status as string}\n`);
}

async function daemonStatus(args: string[], root: string): Promise<void> {
  const json = takeFlag(args, "--json");
  assertNoArgs(args);
  const health = await probeDaemonHealth(root);
  if (!health) {
    if (json) process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, status: "stopped" })}\n`);
    else process.stdout.write("Hitch daemon is stopped\n");
    process.exitCode = 3;
    return;
  }
  if (json) process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
  else {
    const scheduler = health.scheduler as Record<string, unknown>;
    const evalScheduler = health.eval_scheduler as Record<string, unknown>;
    const resourceUsage = formatResourceUsage(health.resources);
    process.stdout.write(`Hitch daemon is ${health.status} (pid ${health.pid}, port ${health.port}, ${scheduler?.running} runs/${evalScheduler?.running} evals running, ${scheduler?.queued} runs/${evalScheduler?.queued} evals queued${resourceUsage})\n`);
  }
}

function formatResourceUsage(value: unknown): string {
  const snapshot = value as { allocated?: Record<string, unknown>; capacity?: Record<string, unknown> } | null;
  if (!snapshot?.allocated || !snapshot.capacity) return "";
  const allocated = snapshot.allocated;
  const capacity = snapshot.capacity;
  const memory = `${toMib(allocated.memory_bytes)}/${toMib(capacity.memory_bytes)} MiB`;
  const gpu = capacity.gpu_count === undefined ? "" : `, ${Number(allocated.gpu_count ?? 0)}/${Number(capacity.gpu_count)} GPUs`;
  const disk = capacity.ephemeral_disk_bytes === undefined ? "" : `, ${toMib(allocated.ephemeral_disk_bytes)}/${toMib(capacity.ephemeral_disk_bytes)} MiB ephemeral disk`;
  return `, resources ${allocated.cpu_millis}/${capacity.cpu_millis}m CPU, ${memory}, ${allocated.container_slots}/${capacity.container_slots} containers, ${allocated.build_slots}/${capacity.build_slots} builds${gpu}${disk}`;
}

function toMib(value: unknown): number {
  return Math.round(Number(value) / (1024 * 1024));
}

async function daemonSubmit(args: string[], root: string): Promise<void> {
  const wait = takeFlag(args, "--wait");
  const output = takeOption(args, "--output") || "json";
  const request = await parseRunRequest(args);
  assertNoArgs(args);
  const client = await daemonClient(root);
  const accepted = await client.request("/v1/runs", { method: "POST", body: JSON.stringify(request) });
  if (!wait) {
    process.stdout.write(`${JSON.stringify(accepted, null, 2)}\n`);
    return;
  }
  const result = await waitForDaemonRun(client, accepted.run_id as string, output);
  process.exitCode = (result as { exit_code?: unknown }).exit_code as number;
}

async function daemonCancel(args: string[], root: string): Promise<void> {
  const runId = args.shift();
  if (!runId) throw invalidInput("daemon cancel requires a run ID");
  assertNoArgs(args);
  const client = await daemonClient(root);
  const response = await client.request(`/v1/runs/${runId}/cancel`, { method: "POST" });
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

async function daemonLogs(args: string[], root: string): Promise<void> {
  const lines = positiveInteger(takeOption(args, "-n") || 50, "-n");
  assertNoArgs(args);
  process.stdout.write(`${await readDaemonLogs(root, lines)}\n`);
}
