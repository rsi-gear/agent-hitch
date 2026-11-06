import type { DockerResourceOwnershipV1, ExecutionEvidenceV1, ObservedContainerResourcesV1, ResourceVectorV1, Sha256 } from "../domain/index.js";
import { setTimeout as delay } from "node:timers/promises";
import { credentialValuesFromEnv, isSensitiveFieldName, runCommand, safeDiagnosticMessage } from "../foundation/index.js";
import { DOCKER_OWNERSHIP_LABELS, dockerOwnershipLabelMap, validateDockerResourceOwnership } from "./docker-ownership.js";
import { parseExecutionEvidence } from "./execution-evidence.js";
import { readDockerEngineContainerStats } from "./docker-engine-stats.js";
import type { DockerEngineContainerStatsV1 } from "./docker-engine-stats.js";
import type { MemoryObservationV1 } from "../domain/index.js";
import { memoryGap, newMemoryObservation, recordMemoryCycle, sampleContainerMemory, summarizeMemory } from "./docker-memory-sampling.js";
import type { MemoryCycleRow, MemorySamplingOptions } from "./docker-memory-sampling.js";
export { parseDockerMemoryBytes } from "./docker-memory-sampling.js";
export type { DockerResourceObserverTopology } from "./docker-memory-sampling.js";

export interface DockerResourceObserverOptions extends MemorySamplingOptions {
  ownership: DockerResourceOwnershipV1;
  workerId: string;
  collisionDomainId: string;
  reservation: ResourceVectorV1;
  mainLimits: ResourceVectorV1;
  sidecarLimits: Record<string, { cpu_millis: number; memory_bytes: number; gpu_count?: number }>;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  intervalMs?: number;
  run?: (args: string[]) => Promise<{ stdout: string; stderr?: string }>;
  engineStats?: (containerId: string) => Promise<DockerEngineContainerStatsV1>;
}

export interface DockerResourceObserver {
  capture(): Promise<ExecutionEvidenceV1>;
  stop(): Promise<ExecutionEvidenceV1>;
}

interface MutableContainer extends ObservedContainerResourcesV1 {
  container_id: string;
  name?: string;
  service?: string;
  role?: "candidate" | "verifier";
  image_reference?: string;
  image_config_digest?: Sha256;
  first_observed_at: string;
  last_observed_at: string;
  peak_memory_bytes?: number;
  cpu_time_ns?: number;
  oom_killed?: boolean;
  exit_code?: number;
  exit_reason?: string;
}

export function startDockerResourceObserver(options: DockerResourceObserverOptions): DockerResourceObserver {
  const ownership = validateDockerResourceOwnership(options.ownership);
  const intervalMs = options.intervalMs ?? 250;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 50 || intervalMs > 60_000) throw new TypeError("Docker resource observer interval is invalid");
  if (new Set(options.topology?.components.flatMap(c => c.phase_ids)).size > 32) throw new TypeError("Docker resource observer topology has too many phases");
  const env = options.env ?? process.env;
  const credentials = credentialValuesFromEnv(Object.keys(env).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && isSensitiveFieldName(name)), env);
  const command = options.run ?? ((args: string[]) => runCommand(
    env.HITCH_DOCKER_PATH || "docker",
    args,
    {
      env,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: 2_000,
      failureCode: "docker_resource_observation_failed",
    },
  ));
  const engineStats = options.engineStats ?? (options.run ? undefined : (containerId: string) => readDockerEngineContainerStats(containerId, {
    env,
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: 2_000,
  }));
  const startedAt = new Date().toISOString();
  const containers = new Map<string, MutableContainer>();
  const issues: string[] = [];
  const memory = newMemoryObservation(intervalMs);
  const missing = new Set<string>();
  let sampleCount = 0;
  let tail = Promise.resolve();
  let pending = false;
  let previousCycleAt: string | undefined;
  let stopped = false;
  let stopping: Promise<ExecutionEvidenceV1> | undefined;
  const recordIssue = (error: unknown): void => addIssue(issues, safeDiagnosticMessage(error, credentials, 512));
  const enqueue = (): Promise<void> => {
    if (pending) return tail;
    pending = true;
    tail = tail.then(async () => {
      // Keep transient retries bounded while accounting for every attempted sampling cycle.
      for (let attempt = 0; attempt < 3 && !options.signal?.aborted; attempt += 1) {
        const cycleAt = new Date().toISOString();
        if (previousCycleAt && Date.parse(cycleAt) - Date.parse(previousCycleAt) > intervalMs * 1.5) memoryGap(memory, previousCycleAt, "interval-overrun", cycleAt);
        previousCycleAt = cycleAt;
        memory.attempted_cycles += 1;
        try {
          await poll(ownership, command, engineStats, containers, recordIssue, memory, options, missing, cycleAt);
          sampleCount += 1;
          break;
        } catch (error) {
          recordIssue(error);
          memoryGap(memory, cycleAt, "poll-failed");
          if (attempt < 2) await delay(100 * (attempt + 1), undefined, {
            ...(options.signal ? { signal: options.signal } : {}),
          }).catch(() => {});
        }
      }
    }).finally(() => { pending = false; });
    return tail;
  };
  const timer = setInterval(() => { if (!stopped) void enqueue(); }, intervalMs);
  timer.unref();
  void enqueue();
  const evidence = (): ExecutionEvidenceV1 => parseExecutionEvidence({
    schema_version: "1",
    provider: ownership.provider,
    worker_id: options.workerId,
    collision_domain_id: options.collisionDomainId,
    eval_id: ownership.eval_id,
    work_id: ownership.work_id,
    lease_id: ownership.lease_id,
    lease_epoch: ownership.lease_epoch,
    task_id: ownership.task_id,
    reservation: options.reservation,
    enforced: { main_limits: options.mainLimits, sidecar_limits: options.sidecarLimits },
    observed: observation(startedAt, sampleCount, containers, issues, memory),
  });
  return {
    capture: async () => { await (stopped ? tail : enqueue()); return evidence(); },
    stop: () => stopping ??= (async () => {
      stopped = true;
      clearInterval(timer);
      await enqueue();
      return evidence();
    })(),
  };
}

async function poll(
  ownership: DockerResourceOwnershipV1,
  command: (args: string[]) => Promise<{ stdout: string; stderr?: string }>,
  engineStats: ((containerId: string) => Promise<DockerEngineContainerStatsV1>) | undefined,
  containers: Map<string, MutableContainer>,
  recordIssue: (error: unknown) => void,
  memory: MemoryObservationV1,
  options: MemorySamplingOptions,
  missing: Set<string>,
  cycleAt: string,
): Promise<void> {
  const labels = dockerOwnershipLabelMap(ownership);
  const listed = await command([
    "container", "ls", "--all",
    "--filter", `label=${DOCKER_OWNERSHIP_LABELS.rootId}=${labels[DOCKER_OWNERSHIP_LABELS.rootId]}`,
    "--filter", `label=${DOCKER_OWNERSHIP_LABELS.leaseId}=${labels[DOCKER_OWNERSHIP_LABELS.leaseId]}`,
    "--filter", `label=${DOCKER_OWNERSHIP_LABELS.leaseEpoch}=${labels[DOCKER_OWNERSHIP_LABELS.leaseEpoch]}`,
    "--format", "{{.ID}}",
  ]);
  const ids = [...new Set(listed.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))].sort();
  if (ids.length > 256 || ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id))) throw new TypeError("Docker resource observation returned invalid container IDs");
  const rows: MemoryCycleRow[] = [];
  let complete = true;
  for (const id of ids) {
    try { rows.push(await observeContainer(id, ownership, command, engineStats, containers, memory, options)); }
    catch (error) { complete = false; recordIssue(error); memoryGap(memory, cycleAt, "inspect-failed"); }
  }
  for (const container of containers.values()) {
    if (ids.some(id => container.container_id.startsWith(id))) { missing.delete(container.container_id); continue; }
    if (!missing.has(container.container_id)) {
      missing.add(container.container_id); memoryGap(memory, container.last_observed_at, "container-disappeared");
      if (container.memory) memoryGap(container.memory, container.last_observed_at, "container-disappeared");
    }
  }
  recordMemoryCycle(memory, rows, cycleAt, complete);
}

async function observeContainer(
  id: string,
  ownership: DockerResourceOwnershipV1,
  command: (args: string[]) => Promise<{ stdout: string; stderr?: string }>,
  engineStats: ((containerId: string) => Promise<DockerEngineContainerStatsV1>) | undefined,
  containers: Map<string, MutableContainer>,
  memory: MemoryObservationV1,
  options: MemorySamplingOptions,
): Promise<MemoryCycleRow> {
  const inspected = JSON.parse((await command(["container", "inspect", id])).stdout) as unknown;
  if (!Array.isArray(inspected) || inspected.length !== 1 || !record(inspected[0])) throw new TypeError("Docker resource observation inspect response is invalid");
  const item = inspected[0];
  if (typeof item.Id !== "string" || !/^[a-f0-9]{12,64}$/.test(item.Id) || (!item.Id.startsWith(id) && !id.startsWith(item.Id))) {
    throw new TypeError("Docker resource observation container identity changed");
  }
  const config = record(item.Config) ? item.Config : {};
  const rawLabels = record(config.Labels) ? config.Labels as Record<string, unknown> : {};
  const epoch = Number(rawLabels[DOCKER_OWNERSHIP_LABELS.leaseEpoch]);
  const actual = validateDockerResourceOwnership({
    root_id: String(rawLabels[DOCKER_OWNERSHIP_LABELS.rootId] ?? ""),
    provider: String(rawLabels[DOCKER_OWNERSHIP_LABELS.provider] ?? ""),
    eval_id: String(rawLabels[DOCKER_OWNERSHIP_LABELS.evalId] ?? ""),
    work_id: String(rawLabels[DOCKER_OWNERSHIP_LABELS.workId] ?? ""),
    lease_id: String(rawLabels[DOCKER_OWNERSHIP_LABELS.leaseId] ?? ""),
    lease_epoch: epoch,
    ...(rawLabels[DOCKER_OWNERSHIP_LABELS.taskId] === undefined ? {} : { task_id: String(rawLabels[DOCKER_OWNERSHIP_LABELS.taskId]) }),
  });
  const expectedLabels = dockerOwnershipLabelMap(ownership);
  const actualLabels = dockerOwnershipLabelMap(actual);
  if (Object.keys(expectedLabels).some((key) => actualLabels[key] !== expectedLabels[key])) throw new TypeError("Docker resource observation ownership changed");
  const now = new Date().toISOString();
  const previous = containers.get(item.Id);
  const observed: MutableContainer = previous ?? { container_id: item.Id, first_observed_at: now, last_observed_at: now };
  observed.last_observed_at = now;
  const service = rawLabels["com.docker.compose.service"];
  if (typeof service === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(service)) observed.service = service;
  const role = rawLabels["io.hitch.environment-role"];
  if (role === "candidate" || role === "verifier") observed.role = role;
  // The detailed phase topology uses agent/shared; legacy image attestation groups both as candidate.
  else if (role === "agent" || role === "shared") observed.role = "candidate";
  if (typeof item.Name === "string" && item.Name.replace(/^\//, "")) observed.name = item.Name.replace(/^\//, "").replace(/[\0\r\n]/g, " ").slice(0, 256);
  if (typeof config.Image === "string" && config.Image && config.Image.length <= 1_024 && !/[\0\r\n]/.test(config.Image)) observed.image_reference = config.Image;
  if (typeof item.Image === "string" && /^sha256:[a-f0-9]{64}$/.test(item.Image)) observed.image_config_digest = item.Image as Sha256;
  const state = record(item.State) ? item.State : {};
  if (typeof state.OOMKilled === "boolean") observed.oom_killed = Boolean(observed.oom_killed || state.OOMKilled);
  if (state.Running === false && Number.isSafeInteger(state.ExitCode) && (state.ExitCode as number) >= 0 && (state.ExitCode as number) <= 255) {
    observed.exit_code = state.ExitCode as number;
    const rawReason = typeof state.Error === "string" && state.Error.trim()
      ? state.Error.trim()
      : state.OOMKilled === true ? "oom-killed" : `exit-code-${state.ExitCode}`;
    observed.exit_reason = rawReason.replace(/[\0\r\n]/g, " ").slice(0, 512);
  }
  containers.set(item.Id, observed);
  return sampleContainerMemory({ container: observed, state, labels: rawLabels, cycle: memory.attempted_cycles,
    command, ...(engineStats ? { engineStats } : {}), observation: memory, options });
}

function observation(
  startedAt: string,
  sampleCount: number,
  values: Map<string, MutableContainer>,
  issues: string[],
  memory: MemoryObservationV1,
): ExecutionEvidenceV1["observed"] {
  const containers = [...values.values()].sort((left, right) => left.container_id.localeCompare(right.container_id)) as ObservedContainerResourcesV1[];
  const unavailable: ExecutionEvidenceV1["observed"]["unavailable_fields"] = [];
  if (!containers.some((entry) => entry.cpu_time_ns !== undefined)) unavailable.push("cpu_time_ns");
  if (!containers.some((entry) => entry.peak_memory_bytes !== undefined)) unavailable.push("peak_memory_bytes");
  if (!containers.some((entry) => entry.exit_code !== undefined || entry.oom_killed !== undefined)) unavailable.push("exit_status");
  if (!containers.some((entry) => entry.image_reference !== undefined || entry.image_config_digest !== undefined)) unavailable.push("image_identity");
  return {
    status: containers.length > 0 ? "partial" : "unavailable",
    started_at: startedAt,
    collected_at: new Date().toISOString(),
    sample_count: sampleCount,
    containers,
    memory: summarizeMemory(memory, containers),
    unavailable_fields: unavailable,
    issues: [...issues],
  };
}

function addIssue(issues: string[], message: string): void {
  const bounded = message.replace(/[\0\r\n]/g, " ").slice(0, 512) || "Docker resource observation failed";
  if (!issues.includes(bounded) && issues.length < 32) issues.push(bounded);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
