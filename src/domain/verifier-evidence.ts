import type { Sha256 } from "./ids.js";

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
