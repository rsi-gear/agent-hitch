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
  provenance: {
    harness_revision?: Sha256 | null;
    artifact_id?: Sha256;
    benchmark_id?: string;
    benchmark_revision?: string;
    verifier_identity?: Sha256;
  };
  bundle_digest: Sha256;
  created_at: string;
}
