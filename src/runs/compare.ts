import type { HarnessIdentityV1, ModelIdentityV1, RunRecordV1 } from "../domain/index.js";
import { canonicalJSON } from "./records.js";
import type { RunRecordLoadResult } from "./records.js";
import { queryRuns } from "./query.js";
import type { RunQuery } from "./query.js";

export type ComparisonDimension = "model" | "harness";

export interface ComparisonExclusion {
  run_id: string;
  reasons: string[];
}

export interface ComparisonGroup {
  identity: HarnessIdentityV1 | ModelIdentityV1;
  run_ids: string[];
  valid_observations: number;
  rewards: { count: number; mean: number | null; min: number | null; max: number | null };
  agent_failures: number;
  invalid_run_ids: string[];
}

export interface StrictComparisonResult {
  schema_version: "1";
  dimension: ComparisonDimension;
  strict: boolean;
  reference_run_id: string | null;
  groups: ComparisonGroup[];
  excluded: ComparisonExclusion[];
  unresolved_identities: Array<{ run_id: string; identity: "model" | "harness" }>;
}

export function compareRunRecords(
  loadedRecords: RunRecordLoadResult[],
  { dimension, referenceRunId }: { dimension: ComparisonDimension; referenceRunId?: string },
): StrictComparisonResult {
  const candidateReference = referenceRunId
    ? loadedRecords.find(({ record }) => record.run_id === referenceRunId)
    : loadedRecords.find(({ record }) => record.context.kind === "benchmark_task");
  const reference = candidateReference?.record;
  const excluded: ComparisonExclusion[] = [];
  const unresolved: Array<{ run_id: string; identity: "model" | "harness" }> = [];
  const groups = new Map<string, ComparisonGroup>();

  for (const loaded of loadedRecords) {
    const record = loaded.record;
    const reasons: string[] = [];
    if (record.context.kind !== "benchmark_task") reasons.push("not_benchmark_task");
    if (!reference || reference.context.kind !== "benchmark_task") {
      if (!reasons.includes("not_benchmark_task")) reasons.push("benchmark_reference_missing");
    } else if (record.context.kind === "benchmark_task") {
      reasons.push(...comparisonIdentityMismatches(reference, record, dimension));
    }
    if (record.harness.revision_identity === null) {
      reasons.push("harness_identity_unresolved");
      unresolved.push({ run_id: record.run_id, identity: "harness" });
    }
    if (record.model.identity_resolved !== true || !record.model.provider || !record.model.effective_id) {
      reasons.push("model_identity_unresolved");
      unresolved.push({ run_id: record.run_id, identity: "model" });
    }
    if (loaded.trajectory_status !== "valid") reasons.push("trajectory_missing_or_corrupt");
    if (loaded.record_status !== "valid") reasons.push("infrastructure_failure");
    if (record.observation?.status === "invalid") reasons.push(record.observation.invalid_reason || "infrastructure_failure");
    else if (record.context.kind === "benchmark_task" && !record.observation) reasons.push("verifier_result_missing");
    else if (record.context.kind === "benchmark_task" && loaded.verifier_status !== "valid") reasons.push("verifier_result_missing");
    if (record.status === "cancelled" && !reasons.includes("cancelled")) reasons.push("cancelled");

    const identityReasons = reasons.filter((reason) => isIdentityExclusion(reason));
    const canGroup = identityReasons.length === 0 && reference !== undefined && record.context.kind === "benchmark_task";
    if (canGroup) {
      const identity = dimension === "model" ? record.model : record.harness;
      const key = canonicalJSON(identity);
      let group = groups.get(key);
      if (!group) {
        group = {
          identity,
          run_ids: [],
          valid_observations: 0,
          rewards: { count: 0, mean: null, min: null, max: null },
          agent_failures: 0,
          invalid_run_ids: [],
        };
        groups.set(key, group);
      }
      if (record.status !== "succeeded") group.agent_failures += 1;
      if (
        record.observation?.status === "valid"
        && loaded.trajectory_status === "valid"
        && loaded.verifier_status === "valid"
        && loaded.record_status === "valid"
      ) {
        group.run_ids.push(record.run_id);
        group.valid_observations += 1;
        addReward(group, record.observation.reward as number);
      } else {
        group.invalid_run_ids.push(record.run_id);
      }
    }
    if (reasons.length > 0) excluded.push({ run_id: record.run_id, reasons: [...new Set(reasons)] });
  }

  const resultGroups = [...groups.values()].sort((left, right) => canonicalJSON(left.identity).localeCompare(canonicalJSON(right.identity)));
  const hasUnresolvedVariable = unresolved.some(({ identity }) => identity === dimension);
  return {
    schema_version: "1",
    dimension,
    strict: Boolean(reference) && resultGroups.length >= 2 && !hasUnresolvedVariable,
    reference_run_id: reference?.run_id ?? null,
    groups: resultGroups,
    excluded,
    unresolved_identities: unresolved,
  };
}

function comparisonIdentityMismatches(reference: RunRecordV1, record: RunRecordV1, dimension: ComparisonDimension): string[] {
  const left = reference.context;
  const right = record.context;
  if (left.kind !== "benchmark_task" || right.kind !== "benchmark_task") return [];
  const reasons: string[] = [];
  if (left.benchmark_id !== right.benchmark_id || left.benchmark_revision !== right.benchmark_revision || left.task_id !== right.task_id) {
    reasons.push("benchmark_revision_mismatch");
  }
  if (left.task_digest !== right.task_digest) reasons.push("task_digest_mismatch");
  if (left.verifier_identity !== right.verifier_identity) reasons.push("verifier_identity_mismatch");
  if (canonicalJSON(reference.protocol) !== canonicalJSON(record.protocol)) reasons.push("protocol_identity_mismatch");
  if (dimension === "model" && canonicalJSON(reference.harness) !== canonicalJSON(record.harness)) reasons.push("harness_identity_mismatch");
  if (dimension === "harness" && canonicalJSON(reference.model) !== canonicalJSON(record.model)) reasons.push("model_identity_mismatch");
  return reasons;
}

function isIdentityExclusion(reason: string): boolean {
  return [
    "not_benchmark_task", "benchmark_reference_missing", "benchmark_revision_mismatch",
    "task_digest_mismatch", "verifier_identity_mismatch", "protocol_identity_mismatch",
    "harness_identity_mismatch", "model_identity_mismatch", "harness_identity_unresolved",
    "model_identity_unresolved",
  ].includes(reason);
}

function addReward(group: ComparisonGroup, reward: number): void {
  const previousCount = group.rewards.count;
  const previousTotal = (group.rewards.mean ?? 0) * previousCount;
  group.rewards.count += 1;
  group.rewards.mean = (previousTotal + reward) / group.rewards.count;
  group.rewards.min = group.rewards.min === null ? reward : Math.min(group.rewards.min, reward);
  group.rewards.max = group.rewards.max === null ? reward : Math.max(group.rewards.max, reward);
}

export async function compareRuns({ root, dimension, query = {}, referenceRunId }: {
  root: string;
  dimension: ComparisonDimension;
  query?: RunQuery;
  referenceRunId?: string;
}): Promise<StrictComparisonResult> {
  return compareRunRecords(await queryRuns({ root, query, verifyTrajectory: true }), {
    dimension,
    ...(referenceRunId ? { referenceRunId } : {}),
  });
}
