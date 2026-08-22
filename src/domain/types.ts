/**
 * Hitch domain layer: branded identifiers and public wire types.
 *
 * Pure types only — this module must not import CLI, daemon, backend, or
 * filesystem orchestration modules (spec §8.4).
 */

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type Sha256 = `sha256:${string}`;
export type RunId = Brand<string, "RunId">;
export type EvalId = Brand<string, "EvalId">;
export type HarnessId = Brand<string, "HarnessId">;
export type ArtifactId = Brand<Sha256, "ArtifactId">;
export type RevisionIdentity = Brand<Sha256, "RevisionIdentity">;
export type PreparationKey = Brand<Sha256, "PreparationKey">;
export type SessionId = Brand<string, "SessionId">;
export type MessageId = Brand<string, "MessageId">;
export type ControllerRuntimeId = Brand<Sha256, "ControllerRuntimeId">;

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
export type TrajectoryFidelity = "native" | "provider_native" | "normalized" | "minimal";

export interface TrajectoryFormatRef {
  family: "dsh-session";
  version: 0;
  contract_commit: string;
  compression: "none";
  pack_chunks: false;
}

export interface TrajectoryRefV1 {
  schema_version: "1";
  run_id: string;
  session_id: string;
  provider_session_id?: string;
  format: TrajectoryFormatRef;
  fidelity: TrajectoryFidelity;
  path: string;
  sha256?: Sha256;
}

export type TrajectoryFileRole =
  | "provider_events"
  | "provider_transcript"
  | "provider_artifact"
  | "canonical_session";

export interface TrajectoryFileRefV1 {
  role: TrajectoryFileRole;
  path: string;
  media_type: string;
  sha256: Sha256;
  bytes: number;
}

export interface TrajectoryRefV2 {
  schema_version: "2";
  run_id: string;
  fidelity: "provider_native" | "normalized" | "minimal";
  provider?: string;
  provider_session_id?: string;
  files: TrajectoryFileRefV1[];
  redactions?: Array<{ rule_id: string; count: number }>;
}

export type TrajectoryRef = TrajectoryRefV1 | TrajectoryRefV2;

export interface EvalTrialRefV1 {
  trial_id: string;
  run_id: string;
  task_id: string;
  attempt: number;
  observation_status: "valid" | "invalid";
  reward?: number;
  verifier_result_ref?: string;
  invalid_reason?: string;
}

export interface EvalResultV1 {
  schema_version: "1";
  eval_id: string;
  benchmark_id: string;
  benchmark_revision: string;
  status: "succeeded" | "failed" | "cancelled";
  trials: EvalTrialRefV1[];
  started_at: string;
  completed_at: string;
}

export interface SessionHeaderLine {
  type: "session";
  version: number;
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  seedLength?: number;
  origin?: "subagent";
  delegationDepth: number;
  agentPreset?: string;
}

export interface SessionEvent<T = unknown> {
  type: string;
  seq: number;
  time: number;
  data: T;
  ignorable?: true;
  sourceEventSeqs?: number[];
  surfaceOp?: "append" | { op: "replace"; start: number; end: number };
}

export type MessageFeedbackRating = "positive" | "negative";
export type MessageFeedbackVersion = string;

export interface MessageFeedbackItem {
  messageId: string;
  rating: MessageFeedbackRating;
  note?: string;
  version: MessageFeedbackVersion;
  createdAt: number;
  updatedAt: number;
}

export interface MessageFeedbackRow {
  session: {
    /** Session id binding: prevents a reused id from inheriting stale feedback. */
    sessionId?: string;
    createdAt: number;
    cwd?: string;
  };
  items: MessageFeedbackItem[];
}

export interface ControllerRuntimeFile {
  path: string;
  size: number;
  executable: boolean;
  sha256: Sha256;
}

/**
 * Declared entrypoints of a controller runtime bundle. The entrypoint path is
 * relative to the upload root (`/opt/hitch`) and MUST be one of the declared
 * payload files; the Harbor bridge reads this manifest instead of hardcoding
 * the TypeScript build layout (spec §4.3, §8.5).
 */
export interface ControllerRuntimeEntrypoints {
  cli: {
    path: string;
    launcher: "node";
  };
}

export interface ControllerRuntimeManifest {
  schema_version: "2";
  runtime_id: Sha256;
  node_range: ">=22";
  entrypoints: ControllerRuntimeEntrypoints;
  files: ControllerRuntimeFile[];
  created_at: string;
}

export function brand<T, B extends string>(value: T): Brand<T, B> {
  return value as Brand<T, B>;
}
