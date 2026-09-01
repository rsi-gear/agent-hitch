import type { Sha256 } from "./ids.js";
import type { ResourceVectorV1 } from "./resources.js";
import type { EnvironmentImageFallbackV1, EnvironmentImageUseV1 } from "./images.js";
import type { ModelCapturePlanV1 } from "./interactions.js";

export type TrialSlotStateV1 =
  | "pending"
  | "blocked"
  | "ready"
  | "leased"
  | "running"
  | "collecting"
  | "succeeded"
  | "invalid"
  | "failed"
  | "cancelled";

export interface TrialSlotV1 {
  schema_version: "1";
  slot_id: string;
  eval_id: string;
  task_id: string;
  task_digest?: Sha256;
  attempt: number;
  candidate_identity: Sha256;
  state: TrialSlotStateV1;
  physical_execution: number;
  authoritative_run_id?: string;
  invalid_reason?: string;
}

export interface BackendWorkItemV1 {
  schema_version: "1";
  work_id: string;
  eval_id: string;
  backend: "harbor";
  logical_attempt: number | null;
  task_ids: string[];
  slots: string[];
  opaque_membership: boolean;
  requested_parallelism: number;
  reservation: ResourceVectorV1;
  provider: string;
  image_refs?: EnvironmentImageUseV1[];
}

export type ResourceRequirementSourceV1 =
  | "task"
  | "compose"
  | "submission-default"
  | "operator-default"
  | "provider-policy"
  | "derived-components";

export interface ResourceRequirementFieldV1 {
  value: number;
  source: ResourceRequirementSourceV1;
  estimated: boolean;
}

export interface TaskResourceComponentV1 {
  name: string;
  role: "main" | "task-sidecar" | "verifier" | "provider-sidecar";
  replicas: number;
  resources: ResourceVectorV1;
  fields: {
    cpu_millis: ResourceRequirementFieldV1;
    memory_bytes: ResourceRequirementFieldV1;
    gpu_count?: ResourceRequirementFieldV1;
  };
}

export interface TaskResourceRequirementV1 {
  task_id: string;
  reservation: ResourceVectorV1;
  main_limits: ResourceVectorV1;
  fields: {
    cpu_millis: ResourceRequirementFieldV1;
    memory_bytes: ResourceRequirementFieldV1;
    container_slots: ResourceRequirementFieldV1;
    build_slots: ResourceRequirementFieldV1;
    gpu_count?: ResourceRequirementFieldV1;
  };
  components: TaskResourceComponentV1[];
  diagnostics: string[];
}

export interface EvalExecutionPlanV1 {
  schema_version: "1";
  planner: "hitch-local-v1";
  eval_id: string;
  membership: "known" | "opaque";
  candidate_identity: Sha256;
  benchmark: {
    id: string;
    revision: string;
    verifier_identity: Sha256;
  };
  provider: string;
  model_capture?: ModelCapturePlanV1;
  max_parallelism: number;
  default_trial_resources: ResourceVectorV1;
  task_resources?: TaskResourceRequirementV1[];
  image_fallbacks?: EnvironmentImageFallbackV1[];
  slots: TrialSlotV1[];
  work_items: BackendWorkItemV1[];
  retry_policy: {
    infrastructure_retries: number;
    infrastructure_retry_backoff_ms: number;
    verifier_execution: "same-trial-verifier-only";
    candidate_rerun_on_verifier_failure: false;
  };
  created_at: string;
}
