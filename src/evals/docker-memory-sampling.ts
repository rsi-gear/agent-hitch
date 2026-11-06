import type { ContainerMemoryObservationV1, ContainerMemorySampleV1, MemoryAttributionV1, MemoryGroupSampleV1,
  MemoryObservationV1, MemorySamplingGapV1, ObservedContainerResourcesV1 } from "../domain/index.js";
import type { DockerEngineContainerStatsV1 } from "./docker-engine-stats.js";
import { readDockerCgroupMemoryPeak } from "./docker-cgroup-memory.js";

export interface DockerResourceObserverTopology {
  components: Array<{ component_id: string; service: string; environment_role: "agent" | "verifier" | "shared";
    role: MemoryAttributionV1["role"]; phase_ids: string[]; replicas: number }>;
}
export interface MemorySamplingOptions {
  topology?: DockerResourceObserverTopology;
  resolvePhase?: (groupId: "agent" | "verifier" | "shared") => Promise<string | undefined>;
  kernelMemoryPeak?: (containerId: string, pid: number) => Promise<number | undefined>;
}
type Command = (args: string[]) => Promise<{ stdout: string; stderr?: string }>;
export interface MemoryCycleRow { container: ObservedContainerResourcesV1; running: boolean; sample?: ContainerMemorySampleV1 }

export function newMemoryObservation(intervalMs: number): MemoryObservationV1 {
  return { sampling_version: "1", lifecycle_coverage: "partial", interval_ms: intervalMs,
    approximation_threshold_ms: Math.min(intervalMs, 250), attempted_cycles: 0, groups: [], group_peaks: [], dropped_group_samples: 0, gap_count: 0, gaps: [] };
}
export function memoryGap(target: { gap_count: number; gaps: MemorySamplingGapV1[] }, startedAt: string, reason: MemorySamplingGapV1["reason"], endedAt = new Date().toISOString()): void {
  target.gap_count += 1; target.gaps.push({ started_at: startedAt, ended_at: endedAt, reason });
  if (target.gaps.length > 32) target.gaps.shift();
}

export async function sampleContainerMemory(input: {
  container: ObservedContainerResourcesV1; state: Record<string, unknown>; labels: Record<string, unknown>;
  cycle: number; command: Command; engineStats?: (id: string) => Promise<DockerEngineContainerStatsV1>;
  observation: MemoryObservationV1; options: MemorySamplingOptions;
}): Promise<MemoryCycleRow> {
  const { container, state, observation, options } = input;
  const memory = container.memory ??= { sampling_version: "1", status: "unavailable", lifecycle_coverage: "partial",
    sample_count: 0, samples: [], dropped_samples: 0, gap_count: 0, gaps: [] };
  const attribution = resolveAttribution(input.labels, options.topology);
  if (attribution) {
    if (memory.attribution && JSON.stringify(memory.attribution) !== JSON.stringify(attribution)) throw new TypeError("observed container topology changed");
    memory.attribution = attribution;
  }
  if (state.Running !== true) return { container, running: false };
  const phaseBefore = attribution && options.resolvePhase ? await options.resolvePhase(attribution.group_id).catch(() => undefined) : undefined;
  const startedAt = new Date().toISOString();
  let stats: DockerEngineContainerStatsV1 = {};
  let source: ContainerMemorySampleV1["source"] = "docker-engine";
  if (input.engineStats) try { stats = await input.engineStats(container.container_id); } catch { /* Retry next cycle; CLI can still sample this cycle. */ }
  if (stats.cpu_time_ns !== undefined) container.cpu_time_ns = Math.max(container.cpu_time_ns ?? 0, stats.cpu_time_ns);
  if (stats.memory_bytes === undefined) {
    source = "docker-cli";
    try {
      const result = await input.command(["container", "stats", "--no-stream", "--format", "{{json .}}", container.container_id]);
      const line = result.stdout.split(/\r?\n/).find(line => line.trim());
      const payload = line ? JSON.parse(line) as { MemUsage?: unknown } : undefined;
      const bytes = parseDockerMemoryBytes(payload?.MemUsage);
      if (bytes !== null) stats.memory_bytes = bytes;
    } catch { /* A missed usage sample remains a recorded gap, not a zero. */ }
  }
  let kernelSource: ContainerMemorySampleV1["kernel_peak_source"] = stats.kernel_peak_bytes === undefined ? undefined : "docker-engine-max-usage";
  const peak = await (options.kernelMemoryPeak ?? readDockerCgroupMemoryPeak)(container.container_id, Number(state.Pid)).catch(() => undefined);
  if (peak !== undefined) { stats.kernel_peak_bytes = peak; kernelSource = "cgroup-v2-memory.peak"; }
  if (stats.memory_bytes === undefined) {
    memoryGap(memory, startedAt, "stats-unavailable"); memoryGap(observation, startedAt, "stats-unavailable");
    if (stats.kernel_peak_bytes === undefined) return { container, running: true };
    source = "cgroup";
  }
  const collectedAt = new Date().toISOString();
  const previous = memory.samples.at(-1);
  const lifecycleStartedAt = typeof state.StartedAt === "string" && validTime(state.StartedAt) && !state.StartedAt.startsWith("0001-") ? state.StartedAt : undefined;
  const reset = lifecycleStartedAt && previous?.lifecycle_started_at && previous.lifecycle_started_at !== lifecycleStartedAt ? "restart"
    : stats.kernel_peak_bytes !== undefined && previous?.kernel_peak_bytes !== undefined && stats.kernel_peak_bytes < previous.kernel_peak_bytes ? "counter-decrease"
    : !previous && lifecycleStartedAt ? "container-start" : "unknown";
  let phaseId: string | undefined;
  if (attribution && options.resolvePhase) try {
    const phase = await options.resolvePhase(attribution.group_id);
    if (phase && phase === phaseBefore && attribution.phase_ids.includes(phase)) phaseId = phase;
  } catch { /* Lifecycle phase is unknown when its trusted receipt is unavailable. */ }
  const sample: ContainerMemorySampleV1 = { cycle: input.cycle, started_at: startedAt, collected_at: collectedAt, source,
    semantics: source === "docker-cli" ? "cli-working-set" : "cgroup-usage", reset_boundary: reset,
    ...(stats.memory_bytes === undefined ? {} : { memory_bytes: stats.memory_bytes }),
    ...(stats.read_at === undefined || source !== "docker-engine" ? {} : { source_read_at: stats.read_at }),
    ...(stats.kernel_peak_bytes === undefined ? {} : { kernel_peak_bytes: stats.kernel_peak_bytes, kernel_peak_source: kernelSource! }),
    ...(lifecycleStartedAt ? { lifecycle_started_at: lifecycleStartedAt } : {}), ...(phaseId ? { phase_id: phaseId } : {}) };
  if (previous) {
    const interval = Date.parse(collectedAt) - Date.parse(previous.collected_at);
    memory.max_interval_ms = Math.max(memory.max_interval_ms ?? 0, interval);
    if (interval > observation.interval_ms * 1.5) memoryGap(memory, previous.collected_at, "interval-overrun", collectedAt);
  }
  if (stats.memory_bytes !== undefined) {
    memory.sample_count += 1;
    if (memory.sampled_peak_bytes === undefined || stats.memory_bytes >= memory.sampled_peak_bytes) {
      memory.sampled_peak_source = sample.source; memory.sampled_peak_semantics = sample.semantics; memory.sampled_peak_at = sample.collected_at;
    }
    memory.sampled_peak_bytes = Math.max(memory.sampled_peak_bytes ?? 0, stats.memory_bytes);
    container.peak_memory_bytes = memory.sampled_peak_bytes; // Legacy per-container sampled maximum.
  }
  memory.status = "partial"; memory.samples.push(sample);
  if (memory.samples.length > 256) { memory.samples.shift(); memory.dropped_samples += 1; }
  return { container, running: true, sample };
}

export function recordMemoryCycle(observation: MemoryObservationV1, rows: MemoryCycleRow[], startedAt: string, completeInventory: boolean): void {
  const running = rows.filter(row => row.running);
  const groups: Array<MemoryGroupSampleV1["group_id"]> = ["task", ...new Set(running.flatMap(row => row.container.memory?.attribution?.group_id ?? []))];
  for (const group of groups) {
    const members = group === "task" ? running : running.filter(row => row.container.memory?.attribution?.group_id === group);
    if (!members.length) continue;
    const sampled = members.filter(row => row.sample?.memory_bytes !== undefined);
    const sources = new Set(sampled.map(row => row.sample!.semantics));
    const samples = sampled.map(row => row.sample!);
    const start = samples.length ? samples.map(s => s.started_at).sort()[0]! : startedAt;
    const end = samples.length ? samples.map(s => s.collected_at).sort().at(-1)! : new Date().toISOString();
    const span = Date.parse(end) - Date.parse(start);
    const sourceTimes = samples.flatMap(s => s.source_read_at === undefined ? [] : [Date.parse(s.source_read_at)]);
    const sourceSpan = sourceTimes.length && sourceTimes.length === samples.length ? Math.max(...sourceTimes) - Math.min(...sourceTimes) : undefined;
    const complete = completeInventory && members.length === sampled.length;
    const phases = new Set(samples.map(s => s.phase_id));
    const total = sampled.reduce((sum, row) => sum + row.sample!.memory_bytes!, 0);
    if (!Number.isSafeInteger(total)) throw new TypeError("observed group memory exceeds safe integer range");
    const phase = phases.size === 1 ? samples[0]?.phase_id : undefined;
    const groupSample: MemoryGroupSampleV1 = { cycle: observation.attempted_cycles, group_id: group, started_at: start, collected_at: end, span_ms: span,
      ...(sourceSpan === undefined ? {} : { source_span_ms: sourceSpan }),
      approximate: !complete || Math.max(span, sourceSpan ?? 0) > observation.approximation_threshold_ms || sources.size > 1,
      complete, running_container_count: members.length, sampled_container_count: sampled.length,
      ...(sampled.length ? { memory_bytes: total } : {}), ...(phase ? { phase_id: phase } : {}),
      semantics: !sources.size ? "unavailable" : sources.size > 1 ? "mixed" : samples[0]!.semantics };
    observation.groups.push(groupSample);
    recordGroupPeak(observation, groupSample);
    if (observation.groups.length > 1024) { observation.groups.shift(); observation.dropped_group_samples += 1; }
  }
}

function recordGroupPeak(observation: MemoryObservationV1, sample: MemoryGroupSampleV1): void {
  if (sample.memory_bytes === undefined) return;
  const previous = observation.group_peaks.find(p => p.group_id === sample.group_id && p.phase_id === sample.phase_id
    && p.semantics === sample.semantics && p.complete === sample.complete && p.approximate === sample.approximate);
  if (!previous) {
    observation.group_peaks.push({ ...sample, sample_count: 1, first_sample_at: sample.started_at, last_sample_at: sample.collected_at,
      max_span_ms: sample.span_ms, ...(sample.source_span_ms === undefined ? {} : { max_source_span_ms: sample.source_span_ms }) });
    return;
  }
  const summary = { sample_count: previous.sample_count + 1, first_sample_at: previous.first_sample_at,
    last_sample_at: sample.collected_at, max_span_ms: Math.max(previous.max_span_ms, sample.span_ms),
    ...(sample.source_span_ms === undefined && previous.max_source_span_ms === undefined ? {}
      : { max_source_span_ms: Math.max(previous.max_source_span_ms ?? 0, sample.source_span_ms ?? 0) }) };
  if (sample.memory_bytes > previous.memory_bytes!) {
    delete previous.source_span_ms; delete previous.phase_id;
    Object.assign(previous, sample);
  }
  Object.assign(previous, summary);
}

export function summarizeMemory(observation: MemoryObservationV1, containers: ObservedContainerResourcesV1[]): MemoryObservationV1 {
  const peaks = containers.flatMap(container => container.memory?.sampled_peak_bytes === undefined ? [] : [container.memory.sampled_peak_bytes]);
  const sum = peaks.reduce((a, b) => a + b, 0);
  return { ...observation, ...(peaks.length ? { max_container_sampled_peak_bytes: Math.max(...peaks),
    ...(Number.isSafeInteger(sum) ? { sum_container_sampled_peaks_bytes: sum } : {}) } : {}) };
}

function resolveAttribution(labels: Record<string, unknown>, topology?: DockerResourceObserverTopology): MemoryAttributionV1 | undefined {
  const matches = topology?.components.filter(c => c.service === labels["com.docker.compose.service"] && c.environment_role === labels["io.hitch.environment-role"]);
  if (matches?.length !== 1) return undefined;
  const c = matches[0]!;
  return { source: "frozen-topology", component_id: c.component_id, role: c.role, group_id: c.environment_role, phase_ids: [...c.phase_ids] };
}
function validTime(value: string): boolean { return Number.isFinite(Date.parse(value)); }

export function parseDockerMemoryBytes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.split("/")[0]?.trim().match(/^(\d+(?:\.\d+)?)\s*(B|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/);
  if (!match) return null;
  const scales: Record<string, number> = { B: 1, kB: 1000, KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
  const bytes = Math.round(Number(match[1]) * scales[match[2]!]!);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}
