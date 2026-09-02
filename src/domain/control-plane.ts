import type { EvalRequest } from "./evals.js";
import type { Sha256 } from "./ids.js";
import type { ResourceVectorV1 } from "./resources.js";

export type EvalControlStateV1 =
  | "queued"
  | "planning"
  | "preparing"
  | "running"
  | "finalizing"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface EvalExecutionPolicyV1 {
  provider: string;
  max_parallelism: number;
  resources: {
    default_trial: ResourceVectorV1;
    setup?: ResourceVectorV1;
  };
  build: {
    mode: "backend" | "prebuild-preferred" | "prebuild-required";
    remote_cache?: string;
  };
  model_capture: {
    mode: "off" | "native" | "proxy" | "hybrid";
    required: boolean;
  };
}

export interface EvalSubmissionV1 {
  schema_version: "1";
  eval_id: string;
  request: EvalRequest;
  execution?: EvalExecutionPolicyV1;
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
  active_leases: string[];
  queued_work_items: string[];
  terminal_work_items: string[];
  allocation_id?: string;
  cancel_requested_at?: string;
  error?: { code: string; message: string };
  created_at: string;
  updated_at: string;
}
