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
}

export type TrajectoryFidelity = "native" | "normalized" | "minimal";

export interface TrajectoryFormatRef {
  family: "dsh-session";
  version: 0;
  contract_commit: string;
  compression: "none";
  pack_chunks: false;
}

export interface TrajectoryRef {
  schema_version: "1";
  run_id: string;
  session_id: string;
  provider_session_id?: string;
  format: TrajectoryFormatRef;
  fidelity: TrajectoryFidelity;
  path: string;
  sha256?: Sha256;
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

export interface ControllerRuntimeManifest {
  schema_version: "1";
  runtime_id: Sha256;
  node_range: ">=22";
  files: ControllerRuntimeFile[];
  created_at: string;
}

export function brand<T, B extends string>(value: T): Brand<T, B> {
  return value as Brand<T, B>;
}
