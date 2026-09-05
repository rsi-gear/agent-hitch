import { readdir } from "node:fs/promises";
import path from "node:path";
import type { RunContextV1, RunRecordV1, RunStatus } from "../domain/index.js";
import { atomicWriteJSON, ensureDir, statePaths } from "../foundation/index.js";
import { loadRunRecord } from "./records.js";
import type { RunRecordLoadResult } from "./records.js";

export interface RunQuery {
  run_id?: string;
  context_kind?: RunContextV1["kind"];
  benchmark_id?: string;
  benchmark_revision?: string;
  task_id?: string;
  task_digest?: string;
  seed_task_id?: string;
  seed_task_digest?: string;
  iteration_id?: string;
  harness_id?: string;
  revision_identity?: string;
  model_provider?: string;
  requested_model?: string;
  effective_model?: string;
  eval_id?: string;
  status?: RunStatus | RunStatus[];
  created_from?: string;
  created_to?: string;
}

export async function queryRuns({ root, query = {}, verifyTrajectory = false }: {
  root: string;
  query?: RunQuery;
  verifyTrajectory?: boolean;
}): Promise<RunRecordLoadResult[]> {
  const runsRoot = statePaths(root).runs;
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: RunRecordLoadResult[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !entry.name.startsWith("run_")) continue;
    try {
      const loaded = await loadRunRecord(path.join(runsRoot, entry.name), { verifyTrajectory });
      if (matchesQuery(loaded.record, query)) records.push(loaded);
    } catch {
      // A corrupt manifest is not a query result; rebuild remains best effort.
    }
  }
  return records;
}

function matchesQuery(record: RunRecordV1, query: RunQuery): boolean {
  if (query.run_id !== undefined && record.run_id !== query.run_id) return false;
  if (query.context_kind !== undefined && record.context.kind !== query.context_kind) return false;
  if (query.harness_id !== undefined && record.harness.harness_id !== query.harness_id) return false;
  if (query.revision_identity !== undefined && record.harness.revision_identity !== query.revision_identity) return false;
  if (query.model_provider !== undefined && record.model.provider !== query.model_provider) return false;
  if (query.requested_model !== undefined && record.model.requested_id !== query.requested_model) return false;
  if (query.effective_model !== undefined && record.model.effective_id !== query.effective_model) return false;
  if (query.eval_id !== undefined && record.parent?.eval_id !== query.eval_id) return false;
  const statuses = query.status === undefined ? null : Array.isArray(query.status) ? query.status : [query.status];
  if (statuses && !statuses.includes(record.status)) return false;
  if (query.created_from !== undefined && record.created_at < query.created_from) return false;
  if (query.created_to !== undefined && record.created_at > query.created_to) return false;
  if (record.context.kind === "benchmark_task" || record.context.kind === "benchmark_phase") {
    if (query.benchmark_id !== undefined && record.context.benchmark_id !== query.benchmark_id) return false;
    if (query.benchmark_revision !== undefined && record.context.benchmark_revision !== query.benchmark_revision) return false;
    if (query.task_id !== undefined && record.context.task_id !== query.task_id) return false;
    if (query.task_digest !== undefined && record.context.task_digest !== query.task_digest) return false;
  } else if ([query.benchmark_id, query.benchmark_revision, query.task_id, query.task_digest].some((value) => value !== undefined)) {
    return false;
  }
  if (record.context.kind === "seed_task") {
    if (query.seed_task_id !== undefined && record.context.seed_task_id !== query.seed_task_id) return false;
    if (query.seed_task_digest !== undefined && record.context.seed_task_digest !== query.seed_task_digest) return false;
    if (query.iteration_id !== undefined && record.context.iteration_id !== query.iteration_id) return false;
  } else if ([query.seed_task_id, query.seed_task_digest, query.iteration_id].some((value) => value !== undefined)) {
    return false;
  }
  return true;
}

export interface RebuiltRunIndex {
  schema_version: "1";
  generated_at: string;
  runs: Array<Record<string, unknown>>;
}

export async function rebuildRunIndexes({ root }: { root: string }): Promise<RebuiltRunIndex> {
  const records = await queryRuns({ root });
  const index: RebuiltRunIndex = {
    schema_version: "1",
    generated_at: new Date().toISOString(),
    runs: records.map(({ record }) => ({
      run_id: record.run_id,
      context: record.context,
      harness_id: record.harness.harness_id,
      revision_identity: record.harness.revision_identity,
      model_provider: record.model.provider ?? null,
      requested_model: record.model.requested_id,
      effective_model: record.model.effective_id,
      eval_id: record.parent?.eval_id ?? null,
      status: record.status,
      created_at: record.created_at,
      completed_at: record.completed_at ?? null,
    })),
  };
  const directory = await ensureDir(statePaths(root).indexes);
  await atomicWriteJSON(path.join(directory, "runs.v1.json"), index);
  return index;
}
