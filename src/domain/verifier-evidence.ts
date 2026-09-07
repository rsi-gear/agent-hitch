import type { Sha256 } from "./ids.js";

export const MAX_VERIFIER_PROCESS_BYTES = 4 * 1024 * 1024;
export const MAX_VERIFIER_FEEDBACK_BYTES = 1024 * 1024;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type VerifierEvidenceStatus = "complete" | "result_only" | "missing" | "corrupt";

export interface VerifierArtifactExcerptV1 {
  name: "ctrf.json" | "test-stdout.txt" | "test-stderr.txt" | "stdout.txt" | "stderr.txt";
  media_type: "application/json" | "text/plain";
  /** Size and digest of the sanitized content available to this inspector before output excerpting. */
  bytes: number;
  sha256: Sha256;
  truncated: boolean;
  /** Present for complete, valid JSON artifacts. */
  json?: JsonValue;
  /** Present for text artifacts and truncated JSON artifacts. */
  text?: string;
}

export interface VerifierScoresV1 {
  total_score: number;
  process_score?: number;
  /** `legacy-reward` means a pre-contract Harbor task exposed only `reward`. */
  normalization: "standard" | "legacy-reward";
}

export interface VerifierTrajectoryRefV1 {
  run_id: string;
  seq_start?: number;
  seq_end?: number;
}

export interface VerifierProcessComponentV1 {
  id: string;
  category: string;
  status: "passed" | "failed" | "excluded";
  weight: number;
  code?: string;
  public_details?: { [key: string]: JsonValue };
  private_details_ref?: string;
  trajectory_refs?: VerifierTrajectoryRefV1[];
}

export interface VerifierProcessEvidenceV1 {
  schema_version: "1";
  metric: string;
  score: number;
  detail_status: "components" | "aggregate-only";
  passed?: number;
  total?: number;
  excluded?: number;
  components?: VerifierProcessComponentV1[];
}

export interface VerifierFeedbackV1 {
  schema_version: "1";
  items: Array<{
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
    component_ids?: string[];
    trajectory_refs?: VerifierTrajectoryRefV1[];
  }>;
}

export interface VerifierStructuredArtifactV1 {
  ref: "verifier/process.json" | "verifier/feedback.json";
  bytes: number;
  sha256: Sha256;
}

export interface HitchVerifierEvidenceV1 {
  schema_version: "1";
  kind: "verifier-evidence";
  run_id: string;
  parent?: {
    eval_id: string;
    trial_id: string;
    attempt: number;
  };
  observation?: {
    status: "valid" | "invalid";
    reward?: number;
    invalid_reason?: string;
    verifier_result_ref?: string;
  };
  verifier: {
    status: VerifierEvidenceStatus;
    result?: JsonValue;
    result_sha256?: Sha256;
    scores?: VerifierScoresV1;
    process?: VerifierProcessEvidenceV1;
    feedback?: VerifierFeedbackV1;
    structured_artifacts?: {
      process?: VerifierStructuredArtifactV1;
      feedback?: VerifierStructuredArtifactV1;
    };
    diagnostics?: {
      ctrf?: VerifierArtifactExcerptV1;
      stdout?: VerifierArtifactExcerptV1[];
      stderr?: VerifierArtifactExcerptV1[];
      infrastructure_error?: JsonValue;
      retry_history?: JsonValue[];
    };
    issues?: string[];
  };
  redactions?: Array<{
    rule_id: string;
    count: number;
  }>;
}
