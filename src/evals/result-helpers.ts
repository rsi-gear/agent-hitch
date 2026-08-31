import type { HarborPreparedArtifactUse, LocalGitTransportUse } from "../backends/index.js";
import type { EvalTrialRefV1 } from "../domain/index.js";

export function assertBackendTrialSet(rawResult: Record<string, unknown> | null, refs: readonly EvalTrialRefV1[]): void {
  const trials = Array.isArray(rawResult?.trial_results) ? rawResult.trial_results as Record<string, unknown>[] : [];
  const backendIds = new Set(trials.map((trial) => typeof trial.trial_name === "string" ? trial.trial_name : null).filter((value): value is string => value !== null));
  const refIds = new Set(refs.map((ref) => ref.trial_id));
  if (backendIds.size !== trials.length || backendIds.size !== refIds.size || [...backendIds].some((id) => !refIds.has(id))) {
    throw new Error("Harbor terminal trial set does not match published eval progress");
  }
}

export function attemptDirectoryName(attempt: number): string {
  return `attempt-${String(attempt).padStart(4, "0")}`;
}

export function summarizeTrialRefs(trials: EvalTrialRefV1[]): Record<string, unknown> {
  const valid = trials.filter((trial) => trial.observation_status === "valid" && typeof trial.reward === "number");
  const rewards = valid.map((trial) => trial.reward as number);
  const aggregate = rewards.length
    ? {
        count: rewards.length,
        mean: rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length,
        min: Math.min(...rewards),
        max: Math.max(...rewards),
      }
    : null;
  return {
    n_trials: trials.length,
    n_completed: valid.length,
    n_invalid: trials.length - valid.length,
    primary_reward: aggregate?.mean ?? null,
    rewards: aggregate ? { reward: aggregate } : {},
  };
}

export function localSourceBackendFailure(rawResult: Record<string, unknown> | null): boolean {
  if (!rawResult) return false;
  // The bridge uses this fixed, non-secret marker when setup cannot verify or
  // materialize the uploaded source. Do not surface provider exception text in
  // the durable Hitch error, because it may contain backend diagnostics.
  return JSON.stringify(rawResult).includes("hitch-local-source-materialize:");
}

export function transportSummary(transport: LocalGitTransportUse): Record<string, unknown> {
  const manifest = transport.manifest;
  return {
    kind: manifest.kind,
    resolution_identity: manifest.resolution_identity,
    commit: manifest.commit,
    tree: manifest.tree,
    payload_sha256: manifest.payload_sha256,
    payload_bytes: manifest.payload_bytes,
    object_count: manifest.object_count,
    file_count: manifest.file_count,
  };
}

export function preparedArtifactSummary(artifact: HarborPreparedArtifactUse): Record<string, unknown> {
  return {
    artifact_id: artifact.artifact_id,
    artifact_integrity: artifact.artifact_integrity,
    entrypoint_integrity: artifact.entrypoint_integrity,
    harness_id: artifact.harness_id,
    revision_identity: artifact.revision_identity,
    platform: artifact.platform,
    source_type: artifact.source_type,
  };
}
