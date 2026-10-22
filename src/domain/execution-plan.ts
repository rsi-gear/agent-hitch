import type { Sha256 } from "./ids.js";
import type { ResourceVectorV1 } from "./resources.js";
import type { EnvironmentImageFallbackV1, EnvironmentImageUseV1 } from "./images.js";
import type { ModelCapturePlanV1 } from "./interactions.js";
import type { TrainingExternalBindingV1 } from "./training.js";
import type { EvalResourceProfilingV1, WorkResourceProfilingV1 } from "./resource-profiling.js";

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

/** Runtime ABI selected by the planner for the task environment that will
 * consume a prepared harness artifact. */
export interface TrialRuntimeContractV1 {
  docker_platform: string;
  artifact_platform: string;
  node_version: string;
}

export interface SchedulingHintV1 {
  policy: "critical-path-lpt-v1";
  estimated_duration_ms: number;
  remaining_path_ms: number;
  estimate_source: "evolution-baseline" | "history-p75" | "task-budget" | "default";
  estimate_sample_count: number;
}

export interface BackendWorkItemV1 {
  resource_profiling?: WorkResourceProfilingV1;
  /** V1 remains readable byte-for-byte; V2 requires the resource binding below. */
  schema_version: "1" | "2";
  resource_contract_version?: "2";
  resource_contract_digest?: Sha256;
  required_capabilities?: string[];
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
  /** New plans pin the exact artifact and ABI per schedulable work item.
   * Optional only so pre-contract persisted plans remain readable. */
  artifact_id?: Sha256;
  runtime_contract?: TrialRuntimeContractV1;
  /** Planning-time throughput hint. It affects dispatch order only and is not
   * part of the Candidate or work identity. */
  scheduling?: SchedulingHintV1;
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
    ephemeral_disk_bytes?: ResourceRequirementFieldV1;
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
    ephemeral_disk_bytes?: ResourceRequirementFieldV1;
  };
  components: TaskResourceComponentV1[];
  diagnostics: string[];
  /** Present only inside a resource_contract_version=2 plan. Components remain
   * the effective per-role totals, preserving the execution overlay interface. */
  resource_model?: "phase-envelope-v1";
  declared_limits?: Array<{ component: string; fields: TaskResourceComponentV1["fields"] }>;
  lifecycle?: TaskResourceLifecycleV2;
}

export interface TaskResourceLifecycleV2 {
  capability_identity: "phase-exclusive-teardown-v1";
  backend_contract: "harbor-native-docker-single-step-v1";
  verifier_inputs: "artifacts-only" | "shared";
  retained_services: string[];
  artifacts: Array<{ service: string; path: string }>;
  phases: Array<{ id: string; live_components: string[]; demand: ResourceVectorV1 }>;
  transitions: Array<{ from: string; to: string; requires_stop: string[] }>;
}

export interface TaskResourceRequirementV2 extends TaskResourceRequirementV1 {
  resource_model: "phase-envelope-v1";
  declared_limits: NonNullable<TaskResourceRequirementV1["declared_limits"]>;
  lifecycle: TaskResourceLifecycleV2;
}

/** Trusted controller input; never supplied by candidate code. */
export interface HarborPhaseResourceContractV1 {
  schema_version: "1";
  capability: "phase-exclusive-teardown-v1";
  verifier_mode: "separate";
  plan_digest: Sha256;
  task_id: string;
  attempt: number;
  agent_services: Array<{ name: string; replicas: number }>;
  verifier_services: Array<{ name: string; replicas: number }>;
  artifacts: Array<{ service: string; path: string }>;
}

export interface EvalExecutionPlanV1 {
  resource_profiling?: EvalResourceProfilingV1;
  schema_version: "1";
  resource_contract_version?: "2";
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
  endpoint_binding?: import("./endpoints.js").ExternalEndpointBindingV1;
  training_binding?: TrainingExternalBindingV1;
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
