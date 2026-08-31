import type { EvalRequest } from "./evals.js";
import type { Sha256 } from "./ids.js";

export type EvalControlStateV1 =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface EvalSubmissionV1 {
  schema_version: "1";
  eval_id: string;
  request: EvalRequest;
  submission_digest: Sha256;
  idempotency_key_hash?: Sha256;
  submitted_at: string;
}

export interface EvalControlV1 {
  schema_version: "1";
  eval_id: string;
  generation: number;
  state: EvalControlStateV1;
  requested_parallelism: number;
  admitted_parallelism: number;
  allocation_id?: string;
  cancel_requested_at?: string;
  error?: { code: string; message: string };
  created_at: string;
  updated_at: string;
}
