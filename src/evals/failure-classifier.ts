import type { EvalTrialRefV1 } from "../domain/index.js";

export interface FailureClassificationV1 {
  schema_version: "1";
  phase: "admission" | "setup" | "provider" | "agent" | "verifier" | "collection" | "cleanup";
  code: string;
  candidate_started: boolean | "unknown";
  retryability: "never" | "transient" | "other-worker" | "verifier-only" | "collect-only" | "operator-required";
  source: "typed-provider" | "bridge-evidence" | "verifier-evidence" | "controller";
}

/** Convert a published invalid observation into scheduler-safe, bounded fields.
 * Provider/bridge adapters should publish the stable codes handled here; the
 * scheduler deliberately never inspects free-form stderr. */
export function classifyTrialFailure(trial: EvalTrialRefV1): FailureClassificationV1 | null {
  if (trial.observation_status !== "invalid" || !trial.invalid_reason) return null;
  switch (trial.invalid_reason) {
    case "provider_quota_exhausted":
      return classification("provider", trial.invalid_reason, true, "never", "bridge-evidence");
    case "provider_auth_failed":
      return classification("provider", trial.invalid_reason, "unknown", "operator-required", "bridge-evidence");
    case "provider_configuration_invalid":
      return classification("provider", trial.invalid_reason, "unknown", "never", "bridge-evidence");
    case "provider_rate_limited":
    case "provider_transport_transient":
      return classification("provider", trial.invalid_reason, true, "transient", "bridge-evidence");
    case "worker_lost_before_candidate":
      return classification("provider", trial.invalid_reason, false, "other-worker", "controller");
    case "sandbox_setup_failed":
      return classification("setup", trial.invalid_reason, false, "transient", "controller");
    case "agent_failed":
    case "agent_timed_out":
      return classification("agent", trial.invalid_reason, true, "never", "bridge-evidence");
    case "verifier_infrastructure_failure":
      return classification("verifier", trial.invalid_reason, true, "verifier-only", "verifier-evidence");
    case "verifier_result_missing":
    case "result_collection_pending":
      return classification("collection", trial.invalid_reason, true, "collect-only", "controller");
    case "candidate_evidence_unavailable":
      return classification("collection", trial.invalid_reason, "unknown", "never", "controller");
    case "execution_state_ambiguous":
      return classification("provider", trial.invalid_reason, "unknown", "operator-required", "controller");
    case "infrastructure_failure":
      return classification("provider", trial.invalid_reason, "unknown", "transient", "controller");
    default:
      return classification("collection", trial.invalid_reason, "unknown", "never", "controller");
  }
}

export function physicalRetryAllowed(classification: FailureClassificationV1 | null): boolean {
  return classification?.retryability === "transient" || classification?.retryability === "other-worker";
}

export function parseFailureClassification(value: unknown): FailureClassificationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("failure classification must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schema_version", "phase", "code", "candidate_started", "retryability", "source"].includes(key))
    || record.schema_version !== "1" || !isOneOf(record.phase, ["admission", "setup", "provider", "agent", "verifier", "collection", "cleanup"])
    || typeof record.code !== "string" || !/^[a-z0-9_-]+$/.test(record.code)
    || record.candidate_started !== true && record.candidate_started !== false && record.candidate_started !== "unknown"
    || !isOneOf(record.retryability, ["never", "transient", "other-worker", "verifier-only", "collect-only", "operator-required"])
    || !isOneOf(record.source, ["typed-provider", "bridge-evidence", "verifier-evidence", "controller"])) throw new TypeError("failure classification is invalid");
  return record as unknown as FailureClassificationV1;
}

function classification(
  phase: FailureClassificationV1["phase"],
  code: string,
  candidateStarted: FailureClassificationV1["candidate_started"],
  retryability: FailureClassificationV1["retryability"],
  source: FailureClassificationV1["source"],
): FailureClassificationV1 {
  return { schema_version: "1", phase, code, candidate_started: candidateStarted, retryability, source };
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.includes(value as T);
}
