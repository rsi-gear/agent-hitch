import type { ExecutionEvidenceV1, MemoryObservationV1, ResourceProfileIdentityV1, Sha256 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";
import { parseExecutionEvidence } from "./execution-evidence.js";

export const RESOURCE_PROFILE_PHASES = ["cold-start", "agent", "artifact-collection", "verifier", "exit"] as const;
export interface ResourceProfileTrialV1 {
  sample_id: string;
  task_id: string;
  identity_digest?: Sha256;
  source: { path: string; digest: Sha256; trust: "frozen-eval-evidence" | "operator-import" | "provider-lifecycle-attestation" };
  additional_sources?: Array<ResourceProfileTrialV1["source"]>;
  input_case: { id: string; kind: "representative" | "stress" | "unspecified" };
  lifecycle: { complete: boolean; covered_phases: string[] };
  roles: Array<{ component_id: string; container_id: string; memory_peak_bytes?: number;
    peak_kind: "terminal-kernel-peak" | "sampled-peak" | "legacy-peak" | "unavailable"; peak_semantics: string;
    oom_killed?: boolean; exit_code?: number; complete_lifetime: boolean }>;
  memory_observation?: Pick<MemoryObservationV1, "lifecycle_coverage" | "max_container_sampled_peak_bytes" | "sum_container_sampled_peaks_bytes" | "group_peaks" | "gap_count" | "dropped_group_samples">;
  blocked_reasons: string[];
}
export interface ResourceProfileV1 {
  schema_version: "1";
  kind: "resource-observation-profile";
  identity: ResourceProfileIdentityV1 | null;
  identity_digest: Sha256 | null;
  trials: ResourceProfileTrialV1[];
  blocked_reasons: string[];
  coverage: { task_ids: string[]; input_cases: string[]; uncovered: string[] };
  profile_digest: Sha256;
}

/** Current polling evidence deliberately stays partial, even when one sample
 * exposes memory.peak. Only a future terminal lifecycle collector may attest
 * complete lifetime peaks; importing a hand-written JSON does not do so. */
export function resourceProfileTrialFromExecution(input: {
  evidence: unknown; source: ResourceProfileTrialV1["source"]; identityDigest?: Sha256;
  inputCase?: ResourceProfileTrialV1["input_case"];
}): ResourceProfileTrialV1 {
  const evidence: ExecutionEvidenceV1 = parseExecutionEvidence(input.evidence);
  const blocked = ["complete_lifecycle_not_proven", "terminal_kernel_peaks_not_proven"];
  if (evidence.observed.status !== "partial" || !evidence.observed.containers.length) blocked.push("memory_observation_unavailable");
  if (!input.identityDigest) blocked.push("frozen_profile_identity_unavailable");
  if (input.source.trust === "operator-import") blocked.push("imported_evidence_is_not_provider_attestation");
  const roles = evidence.observed.containers.map(container => {
    const peak = container.memory?.sampled_peak_bytes ?? container.peak_memory_bytes;
    const semantics = [...new Set(container.memory?.samples.map(sample => sample.semantics) ?? [])];
    return { component_id: container.memory?.attribution?.component_id ?? `unattributed:${container.container_id}`, container_id: container.container_id,
      ...(peak === undefined ? {} : { memory_peak_bytes: peak }),
      peak_kind: peak === undefined ? "unavailable" as const : container.memory ? "sampled-peak" as const : "legacy-peak" as const,
      peak_semantics: container.memory?.sampled_peak_semantics ?? (semantics.length === 1 ? semantics[0]! : semantics.length ? "mixed" : "legacy-unspecified"),
      ...(container.oom_killed === undefined ? {} : { oom_killed: container.oom_killed }),
      ...(container.exit_code === undefined ? {} : { exit_code: container.exit_code }), complete_lifetime: false };
  });
  if (roles.some(role => role.oom_killed)) blocked.push("oom_observed");
  if (roles.some(role => role.exit_code !== undefined && role.exit_code !== 0)) blocked.push("nonzero_container_exit");
  return { sample_id: `${evidence.lease_id}:${evidence.lease_epoch}`, task_id: evidence.task_id,
    ...(input.identityDigest ? { identity_digest: input.identityDigest } : {}), source: input.source,
    input_case: input.inputCase ?? { id: evidence.task_id, kind: "unspecified" }, lifecycle: { complete: false, covered_phases: [] }, roles,
    ...(evidence.observed.memory ? { memory_observation: {
      lifecycle_coverage: evidence.observed.memory.lifecycle_coverage, group_peaks: structuredClone(evidence.observed.memory.group_peaks),
      gap_count: evidence.observed.memory.gap_count, dropped_group_samples: evidence.observed.memory.dropped_group_samples,
      ...(evidence.observed.memory.max_container_sampled_peak_bytes === undefined ? {} : { max_container_sampled_peak_bytes: evidence.observed.memory.max_container_sampled_peak_bytes }),
      ...(evidence.observed.memory.sum_container_sampled_peaks_bytes === undefined ? {} : { sum_container_sampled_peaks_bytes: evidence.observed.memory.sum_container_sampled_peaks_bytes }),
    } } : {}), blocked_reasons: blocked };
}

export function makeResourceProfile(input: { identity: ResourceProfileIdentityV1 | null; trials: ResourceProfileTrialV1[]; blockedReasons?: string[] }): ResourceProfileV1 {
  const seen = new Set<string>();
  if (input.trials.some(trial => { if (seen.has(trial.sample_id)) return true; seen.add(trial.sample_id); return false; })) throw new TypeError("duplicate physical trials cannot increase profile coverage");
  const body = { schema_version: "1" as const, kind: "resource-observation-profile" as const, identity: input.identity,
    identity_digest: input.identity ? sha256JSON(input.identity) : null, trials: input.trials,
    blocked_reasons: [...new Set(input.blockedReasons ?? [])], coverage: {
      task_ids: [...new Set(input.trials.map(trial => trial.task_id))].sort(), input_cases: [...new Set(input.trials.map(trial => trial.input_case.id))].sort(),
      uncovered: ["unseen input sizes and workload tails", "unobserved cold-start, collection, and terminal intervals"] } };
  return { ...body, profile_digest: sha256JSON(body) };
}
