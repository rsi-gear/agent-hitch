import type { ResourceVectorV1 } from "./resources.js";

export interface ObservedContainerResourcesV1 {
  container_id: string;
  name?: string;
  first_observed_at: string;
  last_observed_at: string;
  peak_memory_bytes?: number;
  oom_killed?: boolean;
  exit_code?: number;
  exit_reason?: string;
}

export interface ExecutionEvidenceV1 {
  schema_version: "1";
  provider: string;
  worker_id: string;
  collision_domain_id: string;
  eval_id: string;
  work_id: string;
  lease_id: string;
  lease_epoch: number;
  task_id: string;
  reservation: ResourceVectorV1;
  enforced: {
    main_limits: ResourceVectorV1;
    sidecar_limits: Record<string, { cpu_millis: number; memory_bytes: number }>;
  };
  observed: {
    status: "partial" | "unavailable";
    started_at: string;
    collected_at: string;
    sample_count: number;
    containers: ObservedContainerResourcesV1[];
    unavailable_fields: Array<"cpu_time_ns" | "peak_memory_bytes" | "exit_status">;
    issues: string[];
  };
}
