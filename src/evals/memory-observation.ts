import type { ContainerMemoryObservationV1, MemoryAttributionV1, MemoryObservationV1 } from "../domain/index.js";

export function parseContainerMemory(value: unknown): ContainerMemoryObservationV1 {
  const r = fields(value, ["sampling_version", "status", "lifecycle_coverage", "sample_count", "samples", "dropped_samples", "gap_count", "gaps"],
    ["attribution", "sampled_peak_bytes", "sampled_peak_source", "sampled_peak_semantics", "sampled_peak_at", "max_interval_ms"]);
  version(r); numbers(r, ["sample_count", "dropped_samples", "gap_count"], ["sampled_peak_bytes", "max_interval_ms"]);
  if (!["partial", "unavailable"].includes(String(r.status))) fail();
  if (["sampled_peak_source", "sampled_peak_semantics", "sampled_peak_at"].some(key => (r.sampled_peak_bytes === undefined) !== (r[key] === undefined))
    || r.sampled_peak_bytes !== undefined && (!["docker-engine", "docker-cli", "cgroup"].includes(String(r.sampled_peak_source))
      || !["cgroup-usage", "cli-working-set"].includes(String(r.sampled_peak_semantics)) || !timestamp(r.sampled_peak_at))) fail();
  const samples = array(r.samples, 256).map(value => {
    const s = fields(value, ["cycle", "started_at", "collected_at", "source", "semantics", "reset_boundary"],
      ["memory_bytes", "source_read_at", "kernel_peak_bytes", "kernel_peak_source", "lifecycle_started_at", "phase_id"]);
    numbers(s, ["cycle"], ["memory_bytes", "kernel_peak_bytes"]); timeRange(s.started_at, s.collected_at);
    if (!s.cycle || !["docker-engine", "docker-cli", "cgroup"].includes(String(s.source))
      || !["cgroup-usage", "cli-working-set"].includes(String(s.semantics))
      || !["container-start", "restart", "counter-decrease", "unknown"].includes(String(s.reset_boundary))
      || (s.source === "docker-cli" ? s.semantics !== "cli-working-set" : s.semantics !== "cgroup-usage")
      || (s.memory_bytes === undefined && s.kernel_peak_bytes === undefined)
      || (s.kernel_peak_bytes === undefined) !== (s.kernel_peak_source === undefined)
      || s.kernel_peak_source !== undefined && !["cgroup-v2-memory.peak", "docker-engine-max-usage"].includes(String(s.kernel_peak_source))) fail();
    for (const key of ["source_read_at", "lifecycle_started_at"]) if (s[key] !== undefined && !timestamp(s[key])) fail();
    if (s.phase_id !== undefined && !text(s.phase_id)) fail();
    return s;
  });
  if ((r.sample_count as number) < samples.filter(s => s.memory_bytes !== undefined).length
    || (r.sample_count === 0) !== (r.sampled_peak_bytes === undefined)
    || samples.some(s => s.memory_bytes !== undefined && (s.memory_bytes as number) > (r.sampled_peak_bytes as number))
    || r.status === "unavailable" && samples.length > 0) fail();
  if (r.attribution !== undefined) attribution(r.attribution);
  gaps(r);
  return structuredClone(r) as unknown as ContainerMemoryObservationV1;
}

export function parseMemoryObservation(value: unknown): MemoryObservationV1 {
  const r = fields(value, ["sampling_version", "lifecycle_coverage", "interval_ms", "approximation_threshold_ms", "attempted_cycles",
    "groups", "group_peaks", "dropped_group_samples", "gap_count", "gaps"], ["max_container_sampled_peak_bytes", "sum_container_sampled_peaks_bytes"]);
  version(r); numbers(r, ["interval_ms", "approximation_threshold_ms", "attempted_cycles", "dropped_group_samples", "gap_count"],
    ["max_container_sampled_peak_bytes", "sum_container_sampled_peaks_bytes"]);
  if (!r.interval_ms || (r.max_container_sampled_peak_bytes === undefined) !== (r.sum_container_sampled_peaks_bytes === undefined)
    || (r.max_container_sampled_peak_bytes as number) > (r.sum_container_sampled_peaks_bytes as number)) fail();
  const peaks = new Map<string, Record<string, unknown>>();
  for (const { value, peak } of [...array(r.groups, 1024).map(value => ({ value, peak: false })),
    ...array(r.group_peaks, 2048).map(value => ({ value, peak: true }))]) {
    const g = fields(value, ["cycle", "group_id", "started_at", "collected_at", "span_ms", "approximate", "complete", "running_container_count",
      "sampled_container_count", "semantics", ...(peak ? ["sample_count", "first_sample_at", "last_sample_at", "max_span_ms"] : [])],
    ["phase_id", "memory_bytes", "source_span_ms", ...(peak ? ["max_source_span_ms"] : [])]);
    numbers(g, ["cycle", "span_ms", "running_container_count", "sampled_container_count"], ["memory_bytes", "source_span_ms"]);
    timeRange(g.started_at, g.collected_at);
    if (!g.cycle || (g.cycle as number) > (r.attempted_cycles as number)
      || g.span_ms !== Date.parse(g.collected_at as string) - Date.parse(g.started_at as string)
      || !["task", "agent", "verifier", "shared"].includes(String(g.group_id))
      || !["cgroup-usage", "cli-working-set", "mixed", "unavailable"].includes(String(g.semantics))
      || typeof g.approximate !== "boolean" || typeof g.complete !== "boolean"
      || (g.sampled_container_count as number) > (g.running_container_count as number)
      || (g.sampled_container_count === 0) !== (g.memory_bytes === undefined)
      || (g.semantics === "unavailable") !== (g.sampled_container_count === 0)
      || g.complete && (!g.running_container_count || g.sampled_container_count !== g.running_container_count)
      || (!g.complete || g.semantics === "mixed" || Math.max(g.span_ms as number, (g.source_span_ms as number | undefined) ?? 0) > (r.approximation_threshold_ms as number)) && !g.approximate
      || g.phase_id !== undefined && !text(g.phase_id)) fail();
    if (peak) {
      numbers(g, ["sample_count", "max_span_ms"], ["max_source_span_ms"]);
      timeRange(g.first_sample_at, g.started_at); timeRange(g.collected_at, g.last_sample_at);
      const key = groupKey(g);
      if (peaks.has(key) || g.memory_bytes === undefined || !g.sample_count || (g.sample_count as number) > (r.attempted_cycles as number)
        || (g.max_span_ms as number) < (g.span_ms as number)
        || g.source_span_ms !== undefined && (g.max_source_span_ms === undefined || (g.max_source_span_ms as number) < (g.source_span_ms as number))) fail();
      peaks.set(key, g);
    }
  }
  const retainedCounts = new Map<string, number>();
  for (const g of r.groups as Array<Record<string, unknown>>) {
    if (g.memory_bytes === undefined) continue;
    const key = groupKey(g), peak = peaks.get(key), count = (retainedCounts.get(key) ?? 0) + 1;
    if (!peak || (peak.memory_bytes as number) < (g.memory_bytes as number) || (peak.max_span_ms as number) < (g.span_ms as number)
      || (peak.sample_count as number) < count) fail();
    retainedCounts.set(key, count);
  }
  gaps(r);
  return structuredClone(r) as unknown as MemoryObservationV1;
}

function groupKey(g: Record<string, unknown>): string { return JSON.stringify([g.group_id, g.phase_id ?? null, g.semantics, g.complete, g.approximate]); }

function attribution(value: unknown): MemoryAttributionV1 {
  const a = fields(value, ["source", "component_id", "role", "group_id", "phase_ids"]);
  if (a.source !== "frozen-topology" || !text(a.component_id)
    || !["main", "verifier", "task-sidecar", "provider-sidecar"].includes(String(a.role))
    || !["agent", "verifier", "shared"].includes(String(a.group_id))) fail();
  const phases = array(a.phase_ids, 32);
  if (phases.some(value => !text(value)) || new Set(phases).size !== phases.length) fail();
  return a as unknown as MemoryAttributionV1;
}

function gaps(r: Record<string, unknown>): void {
  const values = array(r.gaps, 32);
  if ((r.gap_count as number) < values.length) fail();
  for (const value of values) {
    const g = fields(value, ["started_at", "ended_at", "reason"]); timeRange(g.started_at, g.ended_at);
    if (!["poll-failed", "inspect-failed", "stats-unavailable", "interval-overrun", "container-disappeared"].includes(String(g.reason))) fail();
  }
}
function version(r: Record<string, unknown>): void {
  if (r.sampling_version !== "1" || r.lifecycle_coverage !== "partial") fail();
}
function numbers(r: Record<string, unknown>, required: string[], optional: string[] = []): void {
  for (const name of [...required, ...optional.filter(name => r[name] !== undefined)]) if (!Number.isSafeInteger(r[name]) || (r[name] as number) < 0) fail();
}
function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const r = value as Record<string, unknown>;
  if (required.some(k => !Object.hasOwn(r, k)) || Object.keys(r).some(k => !required.includes(k) && !optional.includes(k))) fail();
  return r;
}
function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) fail(); return value; }
function timestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function timeRange(start: unknown, end: unknown): void { if (!timestamp(start) || !timestamp(end) || Date.parse(start) > Date.parse(end)) fail(); }
function text(value: unknown): boolean { return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value); }
function fail(): never { throw new TypeError("execution evidence memory sampling is invalid"); }
