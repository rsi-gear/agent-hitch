import path from "node:path";
import type { EvalExecutionPlanV1, SchedulingHintV1 } from "../domain/index.js";
import { atomicWriteJSON, ensureDir, readJSON, sha256JSON, withFileLock } from "../foundation/index.js";
import { benchmarkTaskDigest } from "../runs/index.js";

const MAX_SAMPLES = 20;
const DEFAULT_ESTIMATED_DURATION_MS = 15 * 60 * 1_000;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

interface DurationSampleV1 {
  duration_ms: number;
  retryable_infrastructure_failure: boolean;
}

interface TaskDurationStatsV1 {
  schema_version: "1";
  key: string;
  benchmark_id: string;
  benchmark_revision: string;
  task_id: string;
  task_digest: string;
  provider: string;
  model: string;
  samples: DurationSampleV1[];
  updated_at: string;
}

export async function planTaskSchedulingHints(input: {
  root: string;
  dataset: string;
  taskIds: readonly string[];
  benchmarkId: string;
  benchmarkRevision: string;
  provider: string;
  model: string;
  requestTimeoutMs: number;
  infrastructureRetries: number;
  evolutionBaselineDurations?: Readonly<Record<string, number>>;
}): Promise<Record<string, SchedulingHintV1>> {
  const hints: Array<[string, SchedulingHintV1]> = [];
  for (const taskId of [...input.taskIds].sort(compareBytes)) {
    const identity = durationIdentity(input, taskId);
    const stats = await readStats(statsPath(input.root, identity.key), identity).catch(() => null);
    const baseline = input.evolutionBaselineDurations?.[taskId];
    if (baseline !== undefined && (!Number.isSafeInteger(baseline) || baseline < 1 || baseline > MAX_DURATION_MS)) {
      throw new TypeError(`evolution baseline duration is invalid: ${taskId}`);
    }
    const taskBudget = await readTaskBudget(input.dataset, taskId);
    const fallback = taskBudget ?? (input.requestTimeoutMs > 0 ? input.requestTimeoutMs : DEFAULT_ESTIMATED_DURATION_MS);
    const estimated = baseline ?? (stats && stats.samples.length > 0
      ? percentile(stats.samples.map((sample) => sample.duration_ms), 0.75)
      : fallback);
    const failures = stats?.samples.filter((sample) => sample.retryable_infrastructure_failure).length ?? 0;
    const retryRate = stats && stats.samples.length > 0 ? failures / stats.samples.length : 0;
    const expectedRetries = Math.min(input.infrastructureRetries, 1) * retryRate;
    hints.push([taskId, {
      policy: "critical-path-lpt-v1",
      estimated_duration_ms: estimated,
      remaining_path_ms: Math.max(estimated, Math.round(estimated * (1 + expectedRetries))),
      estimate_source: baseline !== undefined ? "evolution-baseline" : stats && stats.samples.length > 0 ? "history-p75" : taskBudget !== null || input.requestTimeoutMs > 0 ? "task-budget" : "default",
      estimate_sample_count: baseline !== undefined ? 1 : stats?.samples.length ?? 0,
    }]);
  }
  return Object.fromEntries(hints);
}

export async function recordTaskDuration(input: {
  root: string;
  benchmarkId: string;
  benchmarkRevision: string;
  taskId: string;
  provider: string;
  model: string;
  durationMs: number;
  retryableInfrastructureFailure: boolean;
}): Promise<void> {
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 1 || input.durationMs > MAX_DURATION_MS) {
    throw new TypeError("task duration sample is invalid");
  }
  const identity = durationIdentity(input, input.taskId);
  const directory = await ensureDir(path.dirname(statsPath(input.root, identity.key)));
  const locks = await ensureDir(path.join(input.root, "locks", "scheduler-duration-stats"));
  await withFileLock(locks, identity.key, async () => {
    const current = await readStats(path.join(directory, `${identity.key.slice("sha256:".length)}.json`), identity).catch(() => null);
    const samples = [...(current?.samples ?? []), {
      duration_ms: input.durationMs,
      retryable_infrastructure_failure: input.retryableInfrastructureFailure,
    }].slice(-MAX_SAMPLES);
    await atomicWriteJSON(statsPath(input.root, identity.key), {
      schema_version: "1",
      ...identity,
      samples,
      updated_at: new Date().toISOString(),
    } satisfies TaskDurationStatsV1);
  }, { timeoutCode: "scheduler_duration_stats_locked", timeoutExitCode: 12 });
}

export function schedulingHintsFromPlan(plan: EvalExecutionPlanV1): Record<string, SchedulingHintV1> | undefined {
  const hints = new Map<string, SchedulingHintV1>();
  for (const item of plan.work_items) {
    const taskId = item.task_ids[0];
    if (!taskId || !item.scheduling) return undefined;
    const existing = hints.get(taskId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(item.scheduling)) throw new TypeError(`execution plan task scheduling hint changed: ${taskId}`);
    hints.set(taskId, item.scheduling);
  }
  return Object.fromEntries([...hints.entries()].sort((left, right) => compareBytes(left[0], right[0])));
}

function durationIdentity(input: {
  benchmarkId: string;
  benchmarkRevision: string;
  provider: string;
  model: string;
}, taskId: string): Omit<TaskDurationStatsV1, "schema_version" | "samples" | "updated_at"> {
  const taskDigest = benchmarkTaskDigest(input.benchmarkId, input.benchmarkRevision, taskId);
  const identity = {
    benchmark_id: input.benchmarkId,
    benchmark_revision: input.benchmarkRevision,
    task_id: taskId,
    task_digest: taskDigest,
    provider: input.provider,
    model: input.model,
  };
  return { key: sha256JSON(identity), ...identity };
}

function statsPath(root: string, key: string): string {
  return path.join(root, "indexes", "scheduler-duration-stats", `${key.slice("sha256:".length)}.json`);
}

async function readStats(file: string, identity: ReturnType<typeof durationIdentity>): Promise<TaskDurationStatsV1 | null> {
  const value = await readJSON<unknown | null>(file, null);
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("task duration stats must be an object");
  const record = value as Record<string, unknown>;
  const allowed = ["schema_version", "key", "benchmark_id", "benchmark_revision", "task_id", "task_digest", "provider", "model", "samples", "updated_at"];
  if (Object.keys(record).some((key) => !allowed.includes(key)) || record.schema_version !== "1"
    || record.key !== identity.key || record.benchmark_id !== identity.benchmark_id || record.benchmark_revision !== identity.benchmark_revision
    || record.task_id !== identity.task_id || record.task_digest !== identity.task_digest || record.provider !== identity.provider || record.model !== identity.model
    || !Array.isArray(record.samples) || record.samples.length > MAX_SAMPLES
    || typeof record.updated_at !== "string" || !Number.isFinite(Date.parse(record.updated_at))) {
    throw new TypeError("task duration stats identity is invalid");
  }
  const samples = record.samples.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("task duration sample is invalid");
    const sample = value as Record<string, unknown>;
    if (Object.keys(sample).some((key) => key !== "duration_ms" && key !== "retryable_infrastructure_failure")
      || !Number.isSafeInteger(sample.duration_ms) || (sample.duration_ms as number) < 1 || (sample.duration_ms as number) > MAX_DURATION_MS
      || typeof sample.retryable_infrastructure_failure !== "boolean") throw new TypeError("task duration sample is invalid");
    return { duration_ms: sample.duration_ms as number, retryable_infrastructure_failure: sample.retryable_infrastructure_failure as boolean };
  });
  return { schema_version: "1", ...identity, samples, updated_at: record.updated_at };
}

async function readTaskBudget(dataset: string, taskId: string): Promise<number | null> {
  for (const file of [path.join(dataset, taskId, ".hitch-benchmark.json"), path.join(dataset, ".hitch-benchmark.json")]) {
    const descriptor = await readJSON<Record<string, unknown> | null>(file, null).catch(() => null);
    const seconds = descriptor?.agent_timeout_sec;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) return Math.max(1, Math.round(seconds * 1_000));
  }
  return null;
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] as number;
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
