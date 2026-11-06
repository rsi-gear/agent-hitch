/** Sampling evidence is a lower bound, never an automatic resource limit. */
export interface MemoryAttributionV1 {
  source: "frozen-topology";
  component_id: string;
  role: "main" | "verifier" | "task-sidecar" | "provider-sidecar";
  group_id: "agent" | "verifier" | "shared";
  phase_ids: string[];
}

export interface ContainerMemorySampleV1 {
  cycle: number;
  started_at: string;
  collected_at: string;
  source: "docker-engine" | "docker-cli" | "cgroup";
  semantics: "cgroup-usage" | "cli-working-set";
  memory_bytes?: number;
  source_read_at?: string;
  kernel_peak_bytes?: number;
  kernel_peak_source?: "cgroup-v2-memory.peak" | "docker-engine-max-usage";
  lifecycle_started_at?: string;
  reset_boundary: "container-start" | "restart" | "counter-decrease" | "unknown";
  phase_id?: string;
}

export interface MemorySamplingGapV1 {
  started_at: string;
  ended_at: string;
  reason: "poll-failed" | "inspect-failed" | "stats-unavailable" | "interval-overrun" | "container-disappeared";
}

export interface ContainerMemoryObservationV1 {
  sampling_version: "1";
  status: "partial" | "unavailable";
  lifecycle_coverage: "partial";
  attribution?: MemoryAttributionV1;
  sample_count: number;
  sampled_peak_bytes?: number;
  sampled_peak_source?: ContainerMemorySampleV1["source"];
  sampled_peak_semantics?: ContainerMemorySampleV1["semantics"];
  sampled_peak_at?: string;
  max_interval_ms?: number;
  samples: ContainerMemorySampleV1[];
  dropped_samples: number;
  gap_count: number;
  gaps: MemorySamplingGapV1[];
}

export interface MemoryGroupSampleV1 {
  cycle: number;
  group_id: "task" | "agent" | "verifier" | "shared";
  phase_id?: string;
  started_at: string;
  collected_at: string;
  span_ms: number;
  source_span_ms?: number;
  approximate: boolean;
  /** All containers found running in this inventory cycle were sampled;
   * this does not assert complete task or cold-start lifecycle coverage. */
  complete: boolean;
  running_container_count: number;
  sampled_container_count: number;
  memory_bytes?: number;
  semantics: "cgroup-usage" | "cli-working-set" | "mixed" | "unavailable";
}

/** Lifetime maximum for one group/phase/semantics/quality classification. */
export interface MemoryGroupPeakV1 extends MemoryGroupSampleV1 {
  sample_count: number;
  first_sample_at: string;
  last_sample_at: string;
  max_span_ms: number;
  max_source_span_ms?: number;
}

export interface MemoryObservationV1 {
  sampling_version: "1";
  lifecycle_coverage: "partial";
  interval_ms: number;
  approximation_threshold_ms: number;
  attempted_cycles: number;
  max_container_sampled_peak_bytes?: number;
  sum_container_sampled_peaks_bytes?: number;
  groups: MemoryGroupSampleV1[];
  group_peaks: MemoryGroupPeakV1[];
  dropped_group_samples: number;
  gap_count: number;
  gaps: MemorySamplingGapV1[];
}
