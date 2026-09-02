import type { RunId, Sha256 } from "./ids.js";
import type { TrajectoryFidelity } from "./trajectories.js";

export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";

/** The task identity attached to one physical execution (run storage V1). */
export type RunContextV1 =
  | { kind: "ad_hoc" }
  | {
      kind: "seed_task";
      seed_task_id: string;
      seed_task_digest: Sha256;
      seed_set_id?: string;
      seed_set_revision?: string;
      iteration_id?: string;
    }
  | {
      kind: "benchmark_task";
      benchmark_id: string;
      benchmark_revision: string;
      task_id: string;
      task_digest: Sha256;
      verifier_identity: Sha256;
    }
  | {
      /** One conversation within a task; the whole-task score belongs to its trial assessment. */
      kind: "benchmark_phase";
      benchmark_id: string;
      benchmark_revision: string;
      task_id: string;
      task_digest: Sha256;
      verifier_identity: Sha256;
      run_group_id: string;
      phase_index: number;
    };

export interface EvalRunParentV1 {
  kind: "eval";
  eval_id: string;
  trial_id: string;
  attempt: number;
}

export interface RunObservationV1 {
  status: "valid" | "invalid";
  reward?: number;
  verifier_result_ref?: string;
  invalid_reason?: string;
}

export interface HarnessIdentityV1 {
  harness_id: string;
  requested_ref: string;
  revision_identity: Sha256 | null;
  artifact_id?: Sha256;
  agent_args_sha256?: Sha256;
}

export interface ModelIdentityV1 {
  provider?: string;
  requested_id: string;
  effective_id: string;
  parameters_sha256?: Sha256;
  /** False when effective_id is only a provider alias rather than a snapshot. */
  identity_resolved?: boolean;
}

export interface ProtocolIdentityV1 {
  timeout_ms: number;
  workspace_mode: string;
  initial_workspace_digest?: Sha256;
  environment_identity?: Sha256;
  tool_policy_sha256?: Sha256;
}

/** Candidate evidence only; native completion and grading belong to the trial. */
export interface BenchmarkPhaseGroupV1 {
  schema_version: "1";
  kind: "benchmark-phase-group";
  scope: "candidate-evidence-only";
  run_group_id: string;
  eval_id: string;
  trial_id: string;
  attempt: number;
  benchmark_id: string;
  benchmark_revision: string;
  task_id: string;
  task_digest: Sha256;
  verifier_identity: Sha256;
  harness: HarnessIdentityV1;
  model: ModelIdentityV1;
  phases: Array<{
    phase_index: number;
    run_id: string;
    process_status: RunStatus;
    provider_session_id: string;
    bundle_digest: Sha256;
    bundle_index_digest: Sha256;
  }>;
}

export interface BenchmarkPhaseGroupRefV1 {
  run_group_id: string;
  digest: Sha256;
}

/** Logical projection of runs/<run-id>/{request,resolution,manifest,result,...}. */
export interface RunRecordV1 {
  run_id: string;
  context: RunContextV1;
  parent?: EvalRunParentV1;
  status: RunStatus;
  harness: HarnessIdentityV1;
  model: ModelIdentityV1;
  protocol: ProtocolIdentityV1;
  observation?: RunObservationV1;
  request_ref: string;
  resolution_ref: string;
  result_ref?: string;
  trajectory_ref?: string;
  created_at: string;
  completed_at?: string;
}

export type PlatformTriple = `${string}-${string}`;

export interface RunRequest {
  schema_version?: string;
  harness_ref: string;
  model: string;
  cwd: string;
  workspace_mode: string;
  prompt: string;
  timeout_ms: number;
  agent_args: string[];
  context?: RunContextV1;
  parent?: EvalRunParentV1;
  model_identity?: ModelIdentityV1;
  protocol_identity?: Pick<ProtocolIdentityV1, "environment_identity" | "tool_policy_sha256">;
}

export interface RunResult {
  schema_version: string;
  run_id: RunId;
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  exit_code: number;
  process_exit_code?: number | null;
  signal?: string | null;
  output?: string | null;
  harness_id?: string | null;
  revision_identity?: string | null;
  artifact_id?: string | null;
  error?: { code: string; message: string } | null;
  workspace?: {
    mode: string;
    source: string;
    execution: string;
    retained: boolean;
    changed: boolean | null;
  } | null;
  workspace_warning?: { code: string; message: string } | null;
  started_at?: string;
  completed_at?: string;
  trajectory?: {
    session_id: string;
    path: string;
    fidelity: TrajectoryFidelity;
    sha256?: string | null;
  } | null;
  trajectory_warning?: { code: string; message: string } | null;
}

/** `native` is retained only for trajectory.ref.json V1 compatibility. */
