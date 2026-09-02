import path from "node:path";
import type { EvalProgressV1, EvalTrialRefV1 } from "../domain/index.js";
import { atomicWriteJSON, readJSON } from "../foundation/index.js";

const EVAL_ID = /^eval_[a-f0-9]{32}$/;
const RUN_ID = /^run_[a-f0-9]{32}$/;

export function createEvalProgress(input: {
  evalId: string;
  benchmarkId: string;
  benchmarkRevision: string;
  plannedTasks?: number | null;
  plannedTrials?: number | null;
  startedAt: string;
}): EvalProgressV1 {
  if (!EVAL_ID.test(input.evalId)) throw new TypeError("eval progress eval_id is invalid");
  if (!input.benchmarkId || !input.benchmarkRevision) throw new TypeError("eval progress benchmark identity is invalid");
  if (!Number.isFinite(Date.parse(input.startedAt))) throw new TypeError("eval progress started_at is invalid");
  return {
    schema_version: "1",
    eval_id: input.evalId,
    benchmark_id: input.benchmarkId,
    benchmark_revision: input.benchmarkRevision,
    status: "running",
    generation: 0,
    planned_tasks: input.plannedTasks ?? null,
    planned_trials: input.plannedTrials ?? null,
    trials: [],
    summary: { settled_trials: 0, valid_trials: 0, invalid_trials: 0 },
    started_at: input.startedAt,
    updated_at: input.startedAt,
  };
}

export async function readEvalProgress(evalDirectory: string): Promise<EvalProgressV1 | null> {
  const value = await readJSON<unknown | null>(path.join(evalDirectory, "progress.json"), null);
  return value === null ? null : parseEvalProgress(value);
}

export async function writeEvalProgress(evalDirectory: string, progress: EvalProgressV1): Promise<void> {
  await atomicWriteJSON(path.join(evalDirectory, "progress.json"), parseEvalProgress(progress));
}

export function mergeEvalProgressTrial(progress: EvalProgressV1, trial: EvalTrialRefV1, now = new Date().toISOString()): EvalProgressV1 {
  const parsed = parseEvalTrialRef(trial, "eval progress trial");
  const byTrial = progress.trials.find((item) => item.trial_id === parsed.trial_id);
  if (byTrial !== undefined) {
    if (JSON.stringify(byTrial) !== JSON.stringify(parsed)) throw new TypeError(`eval progress trial identity conflict: ${parsed.trial_id}`);
    return progress;
  }
  if (progress.trials.some((item) => evalTrialCandidateKey(item) === evalTrialCandidateKey(parsed))) {
    throw new TypeError(`eval progress run identity conflict: ${evalTrialCandidateKey(parsed)}`);
  }
  if (progress.trials.some((item) => evalTrialKey(item) === evalTrialKey(parsed))) {
    throw new TypeError(`eval progress logical trial conflict: ${parsed.task_id} attempt ${parsed.attempt}`);
  }
  const trials = [...progress.trials, parsed].sort((left, right) => left.task_id.localeCompare(right.task_id)
    || left.attempt - right.attempt
    || left.trial_id.localeCompare(right.trial_id));
  const valid = trials.filter((item) => item.observation_status === "valid").length;
  return parseEvalProgress({
    ...progress,
    generation: progress.generation + 1,
    trials,
    summary: {
      settled_trials: trials.length,
      valid_trials: valid,
      invalid_trials: trials.length - valid,
    },
    updated_at: now,
  });
}

export function evalTrialKey(trial: Pick<EvalTrialRefV1, "task_id" | "attempt">): string {
  return `${trial.task_id}\u0000${trial.attempt}`;
}

export function evalTrialCandidateKey(trial: EvalTrialRefV1): string {
  return trial.run_group ? trial.run_group.run_group_id : trial.run_id;
}

/** Replace one invalid logical trial, or fill a missing slot, with a valid verifier result. */
export function replaceInvalidEvalProgressTrial(
  progress: EvalProgressV1,
  trial: EvalTrialRefV1,
  now = new Date().toISOString(),
): EvalProgressV1 {
  const parsed = parseEvalTrialRef(trial, "eval rerun trial");
  if (parsed.observation_status !== "valid") throw new TypeError("eval rerun replacement must be valid");
  const key = evalTrialKey(parsed);
  const existing = progress.trials.find((item) => evalTrialKey(item) === key);
  if (existing?.observation_status === "valid") {
    if (JSON.stringify(existing) === JSON.stringify(parsed)) return progress;
    throw new TypeError(`eval rerun cannot replace valid task: ${parsed.task_id}`);
  }
  if (progress.trials.some((item) => evalTrialCandidateKey(item) === evalTrialCandidateKey(parsed) && evalTrialKey(item) !== key)) {
    throw new TypeError(`eval progress run identity conflict: ${evalTrialCandidateKey(parsed)}`);
  }
  if (progress.trials.some((item) => item.trial_id === parsed.trial_id && evalTrialKey(item) !== key)) {
    throw new TypeError(`eval progress trial identity conflict: ${parsed.trial_id}`);
  }
  const trials = [...progress.trials.filter((item) => evalTrialKey(item) !== key), parsed].sort((left, right) => left.task_id.localeCompare(right.task_id)
    || left.attempt - right.attempt
    || left.trial_id.localeCompare(right.trial_id));
  const valid = trials.filter((item) => item.observation_status === "valid").length;
  return parseEvalProgress({
    ...progress,
    generation: progress.generation + 1,
    trials,
    summary: {
      settled_trials: trials.length,
      valid_trials: valid,
      invalid_trials: trials.length - valid,
    },
    updated_at: now,
  });
}

export function parseEvalProgress(value: unknown): EvalProgressV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("eval progress must be an object");
  const record = value as Record<string, unknown>;
  if (record.schema_version !== "1" || typeof record.eval_id !== "string" || !EVAL_ID.test(record.eval_id)) {
    throw new TypeError("eval progress identity is invalid");
  }
  if (typeof record.benchmark_id !== "string" || !record.benchmark_id
    || typeof record.benchmark_revision !== "string" || !record.benchmark_revision
    || record.status !== "running") throw new TypeError("eval progress benchmark/status is invalid");
  if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 0) throw new TypeError("eval progress generation is invalid");
  for (const name of ["planned_tasks", "planned_trials"] as const) {
    const planned = record[name];
    if (planned !== null && (!Number.isSafeInteger(planned) || (planned as number) < 0)) throw new TypeError(`eval progress ${name} is invalid`);
  }
  if (!Array.isArray(record.trials)) throw new TypeError("eval progress trials are invalid");
  const trials = record.trials.map((trial, index) => parseEvalTrialRef(trial, `eval progress trial ${index}`));
  if (new Set(trials.map((trial) => trial.trial_id)).size !== trials.length
    || new Set(trials.map(evalTrialCandidateKey)).size !== trials.length) throw new TypeError("eval progress trial identities are duplicated");
  const sorted = [...trials].sort((left, right) => left.task_id.localeCompare(right.task_id)
    || left.attempt - right.attempt
    || left.trial_id.localeCompare(right.trial_id));
  if (sorted.some((trial, index) => trial !== trials[index])) throw new TypeError("eval progress trials are not canonically sorted");
  const summary = record.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) throw new TypeError("eval progress summary is invalid");
  const summaryRecord = summary as Record<string, unknown>;
  const valid = trials.filter((trial) => trial.observation_status === "valid").length;
  if (record.planned_trials !== null && trials.length > (record.planned_trials as number)) {
    throw new TypeError("eval progress has more settled than planned trials");
  }
  if (record.planned_tasks !== null && new Set(trials.map((trial) => trial.task_id)).size > (record.planned_tasks as number)) {
    throw new TypeError("eval progress has more settled than planned tasks");
  }
  if (summaryRecord.settled_trials !== trials.length || summaryRecord.valid_trials !== valid
    || summaryRecord.invalid_trials !== trials.length - valid) throw new TypeError("eval progress summary does not match trials");
  if (typeof record.started_at !== "string" || !Number.isFinite(Date.parse(record.started_at))
    || typeof record.updated_at !== "string" || !Number.isFinite(Date.parse(record.updated_at))) {
    throw new TypeError("eval progress timestamps are invalid");
  }
  return {
    schema_version: "1",
    eval_id: record.eval_id,
    benchmark_id: record.benchmark_id,
    benchmark_revision: record.benchmark_revision,
    status: "running",
    generation: record.generation as number,
    planned_tasks: record.planned_tasks as number | null,
    planned_trials: record.planned_trials as number | null,
    trials,
    summary: {
      settled_trials: trials.length,
      valid_trials: valid,
      invalid_trials: trials.length - valid,
    },
    started_at: record.started_at,
    updated_at: record.updated_at,
  };
}

export function parseEvalTrialRef(value: unknown, label = "eval trial"): EvalTrialRefV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const trial = value as Record<string, unknown>;
  if (typeof trial.trial_id !== "string" || !trial.trial_id
    || typeof trial.task_id !== "string" || !trial.task_id
    || !Number.isSafeInteger(trial.attempt) || (trial.attempt as number) < 1
    || (trial.observation_status !== "valid" && trial.observation_status !== "invalid")) {
    throw new TypeError(`${label} identity is invalid`);
  }
  if (trial.observation_status === "valid" && (typeof trial.reward !== "number" || !Number.isFinite(trial.reward))) {
    throw new TypeError(`${label} valid reward is invalid`);
  }
  if (trial.observation_status === "invalid" && (typeof trial.invalid_reason !== "string" || !trial.invalid_reason)) {
    throw new TypeError(`${label} invalid reason is missing`);
  }
  if (trial.verifier_result_ref !== undefined && (typeof trial.verifier_result_ref !== "string" || !trial.verifier_result_ref)) {
    throw new TypeError(`${label} verifier ref is invalid`);
  }
  const assessment = trial.assessment as { id?: unknown; digest?: unknown } | undefined;
  if (assessment !== undefined && (!assessment || typeof assessment.id !== "string" || !/^assessment_[a-f0-9]{32}$/.test(assessment.id)
    || typeof assessment.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(assessment.digest))) throw new TypeError(`${label} assessment is invalid`);
  const group = trial.run_group as { run_group_id?: unknown; digest?: unknown } | undefined;
  if (group !== undefined) {
    if (!group || typeof group !== "object" || Array.isArray(group) || Object.keys(group).some(key => !["run_group_id", "digest"].includes(key))
      || typeof group.run_group_id !== "string" || !/^run_group_[a-f0-9]{32}$/.test(group.run_group_id)
      || typeof group.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(group.digest) || trial.run_id !== undefined || !assessment) {
      throw new TypeError(`${label} phase group identity is invalid`);
    }
  } else if (typeof trial.run_id !== "string" || !RUN_ID.test(trial.run_id)) throw new TypeError(`${label} run identity is invalid`);
  const common = {
    trial_id: trial.trial_id,
    task_id: trial.task_id,
    attempt: trial.attempt as number,
    observation_status: trial.observation_status as "valid" | "invalid",
    ...(trial.reward === undefined ? {} : { reward: trial.reward as number }),
    ...(trial.verifier_result_ref === undefined ? {} : { verifier_result_ref: trial.verifier_result_ref as string }),
    ...(trial.invalid_reason === undefined ? {} : { invalid_reason: trial.invalid_reason as string }),
  };
  const reference = assessment ? { id: assessment.id as string, digest: assessment.digest as string } : undefined;
  return group ? { ...common, run_group: { run_group_id: group.run_group_id as string, digest: group.digest as `sha256:${string}` }, assessment: reference! }
    : { ...common, run_id: trial.run_id as string, ...(reference ? { assessment: reference } : {}) };
}
