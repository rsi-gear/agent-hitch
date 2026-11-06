import type { Sha256 } from "./ids.js";

export interface ResourceProfilingPolicyV1 {
  unknown_max_parallelism: number;
}

export interface WorkResourceProfilingV1 {
  schema_version: "1";
  unknown: boolean;
  unknown_max_parallelism: number;
  unknown_slots: number;
  reason: "missing-resource-size" | "explicit-resource-limits" | "approved-resource-config" | "unknown-task-membership";
  approval_digests: Sha256[];
}

export interface EvalResourceProfilingV1 {
  schema_version: "1";
  unknown_max_parallelism: number;
  requested_parallelism: number;
  scope: "worker" | "process";
  approvals: Array<{ task_id: string; approval_digest: Sha256; identity_digest: Sha256 }>;
  identity_manifest_digest?: Sha256;
}
