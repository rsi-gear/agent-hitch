import type { Sha256 } from "./ids.js";

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
