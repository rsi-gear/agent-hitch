import type { DockerResourceOwnershipV1, ExecutionEvidenceV1, ObservedContainerResourcesV1, ResourceVectorV1, Sha256 } from "../domain/index.js";
import { runCommand } from "../foundation/index.js";
import { DOCKER_OWNERSHIP_LABELS, dockerOwnershipLabelMap, validateDockerResourceOwnership } from "./docker-ownership.js";
import { parseExecutionEvidence } from "./execution-evidence.js";
import { readDockerEngineContainerStats } from "./docker-engine-stats.js";

export interface DockerResourceObserverOptions {
  ownership: DockerResourceOwnershipV1;
  workerId: string;
  collisionDomainId: string;
  reservation: ResourceVectorV1;
  mainLimits: ResourceVectorV1;
  sidecarLimits: Record<string, { cpu_millis: number; memory_bytes: number }>;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  intervalMs?: number;
  run?: (args: string[]) => Promise<{ stdout: string; stderr?: string }>;
  engineStats?: (containerId: string) => Promise<{ cpu_time_ns?: number; memory_bytes?: number }>;
}

export interface DockerResourceObserver {
  capture(): Promise<ExecutionEvidenceV1>;
  stop(): Promise<ExecutionEvidenceV1>;
}

interface MutableContainer {
  container_id: string;
  name?: string;
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
  const env = options.env ?? process.env;
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
  let sampleCount = 0;
  let tail = Promise.resolve();
  let pending = false;
  let unavailable = false;
  let stopped = false;
  const enqueue = (): Promise<void> => {
    if (pending || unavailable) return tail;
    pending = true;
    tail = tail.then(async () => {
      if (options.signal?.aborted) return;
      try {
        await poll(ownership, command, engineStats, containers, issues);
        sampleCount += 1;
      } catch (error) {
        addIssue(issues, (error as Error)?.message || String(error));
        unavailable = true;
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
    observed: observation(startedAt, sampleCount, containers, issues),
  });
  return {
    capture: async () => { await enqueue(); return evidence(); },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await enqueue();
      return evidence();
    },
  };
}

async function poll(
  ownership: DockerResourceOwnershipV1,
  command: (args: string[]) => Promise<{ stdout: string; stderr?: string }>,
  engineStats: ((containerId: string) => Promise<{ cpu_time_ns?: number; memory_bytes?: number }>) | undefined,
  containers: Map<string, MutableContainer>,
  issues: string[],
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
  for (const id of ids) {
    try { await observeContainer(id, ownership, command, engineStats, containers); }
    catch (error) { addIssue(issues, (error as Error)?.message || String(error)); }
  }
}

async function observeContainer(
  id: string,
  ownership: DockerResourceOwnershipV1,
  command: (args: string[]) => Promise<{ stdout: string; stderr?: string }>,
  engineStats: ((containerId: string) => Promise<{ cpu_time_ns?: number; memory_bytes?: number }>) | undefined,
  containers: Map<string, MutableContainer>,
): Promise<void> {
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
  if (state.Running === true) {
    if (engineStats) {
      try {
        const stats = await engineStats(item.Id);
        if (stats.cpu_time_ns !== undefined) observed.cpu_time_ns = Math.max(observed.cpu_time_ns ?? 0, stats.cpu_time_ns);
        if (stats.memory_bytes !== undefined) observed.peak_memory_bytes = Math.max(observed.peak_memory_bytes ?? 0, stats.memory_bytes);
      } catch { /* CLI evidence remains useful when the Engine stats API is unavailable. */ }
    }
    if (observed.peak_memory_bytes === undefined) try {
      const stats = await command(["container", "stats", "--no-stream", "--format", "{{json .}}", item.Id]);
      const line = stats.stdout.split(/\r?\n/).find((entry) => entry.trim());
      const parsed = line ? JSON.parse(line) as unknown : null;
      const memory = record(parsed) ? parseDockerMemoryBytes(parsed.MemUsage) : null;
      if (memory !== null) observed.peak_memory_bytes = Math.max(observed.peak_memory_bytes ?? 0, memory);
    } catch { /* Inspect evidence remains useful when stats is unavailable. */ }
  }
  containers.set(item.Id, observed);
}

function observation(
  startedAt: string,
  sampleCount: number,
  values: Map<string, MutableContainer>,
  issues: string[],
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
    unavailable_fields: unavailable,
    issues: [...issues],
  };
}

export function parseDockerMemoryBytes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const first = value.split("/", 1)[0]?.trim() ?? "";
  const match = first.match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB|TB|TiB)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] as string;
  const powers: Record<string, number> = { B: 1, kB: 1_000, KB: 1_000, KiB: 1024, MB: 1_000_000, MiB: 1024 ** 2, GB: 1_000_000_000, GiB: 1024 ** 3, TB: 1_000_000_000_000, TiB: 1024 ** 4 };
  const bytes = amount * (powers[unit] as number);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

function addIssue(issues: string[], message: string): void {
  const bounded = message.replace(/[\0\r\n]/g, " ").slice(0, 512) || "Docker resource observation failed";
  if (!issues.includes(bounded) && issues.length < 32) issues.push(bounded);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
