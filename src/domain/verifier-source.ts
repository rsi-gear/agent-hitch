interface VerifierSourceIdentityV2 {
  schema_version: "2";
  task_id: string;
  trial_id: string;
  run_id: string;
  controller_runtime_id: string;
  source_result_digest: string;
  original_result_digest?: string;
}

export type RemoteVerifierSourceManifestV2 = VerifierSourceIdentityV2 & (
  | { status: "unavailable"; reason: "unsupported-task" | "source-unavailable" | "source-too-large" }
  | { status: "available"; source_bundle_digest: string; source_config_digest: string;
      task_digest: string; artifacts_digest: string; snapshot_digest: string; regrade_config_digest?: string }
);

/** Portable immutable inputs for scoring an existing candidate. No worker/controller paths or model credentials. */
export interface RemoteVerifierWorkV2 {
  schema_version: "2";
  kind: "verifier-only";
  assessment_id: string;
  source_ref: import("./eval-records.js").EvalTrialRefV1;
  source_manifest: RemoteVerifierSourceManifestV2;
  source_trial: Record<string, unknown>;
  candidate_result: Record<string, unknown>;
  candidate_result_digest: string;
  canonical_bundle_digest: string;
  verifier_runtime_id: string;
}

/** Scoring evidence; worker-local config and log paths are deliberately absent. */
export interface RemoteVerifierOutcomeV2 {
  trial: Record<string, unknown>;
  backend: { process_exit_code: number | null; signal: string | null };
  execution: import("./execution-evidence.js").ExecutionEvidenceV1;
  config_digest: string;
  controller_runtime_id: string;
  runtime_repair?: Record<string, unknown>;
}
