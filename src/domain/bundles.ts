import type { Sha256 } from "./ids.js";
import type { ResourceVectorV1 } from "./resources.js";

export type ResultBundleFileRoleV1 =
  | "request"
  | "resolution"
  | "manifest"
  | "result"
  | "runtime-ref"
  | "environment-manifest"
  | "execution-evidence"
  | "control-events"
  | "process-log"
  | "workspace-evidence"
  | "trajectory"
  | "provider-evidence"
  | "verifier-evidence"
  | "interaction-capture"
  | "diagnostic";

export interface ResultBundleFileV1 {
  role: ResultBundleFileRoleV1;
  path: string;
  size: number;
  sha256: Sha256;
}

export interface ResultBundleIndexV1 {
  schema_version: "1";
  run_id: string;
  sealed: true;
  context_identity: Sha256;
  files: ResultBundleFileV1[];
  environment?: {
    images: Array<{ image_id: Sha256; image_digest: Sha256; reference: string }>;
    provider: string;
    worker_id?: string;
    lease_id?: string;
  };
  resources?: {
    requested: ResourceVectorV1;
    observed?: Record<string, number>;
  };
  interaction_ref?: string;
  capture?: {
    mode: "off" | "native" | "proxy" | "hybrid";
    required: boolean;
    completeness: "complete" | "partial" | "none";
    interaction_count: number;
    redaction: {
      policy: string;
      status: "applied" | "not-needed" | "failed";
      rules: Array<{ rule_id: string; count: number }>;
    };
  };
  provenance: {
    harness_revision?: Sha256 | null;
    artifact_id?: Sha256;
    controller_runtime_id?: Sha256;
    benchmark_id?: string;
    benchmark_revision?: string;
    verifier_identity?: Sha256;
  };
  bundle_digest: Sha256;
  created_at: string;
}

export interface TrainingDataCandidateV1 {
  schema_version: "1";
  candidate_id: Sha256;
  source_bundle_digest: Sha256;
  run_id: string;
  eligibility: "eligible" | "ineligible" | "review-required";
  reasons: string[];
  context_ref: string;
  trajectory_ref: string;
  verifier_ref: string;
  metadata: {
    benchmark_id: string;
    benchmark_revision: string;
    harness_revision: Sha256;
    model_identity_resolved: boolean;
    capture_completeness: "complete" | "partial" | "none";
    redaction_policy: string;
  };
  provenance_digest: Sha256;
}
