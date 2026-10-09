import path from "node:path";
import { lstat } from "node:fs/promises";
import type { EvalProgressV1, EvalTrialRefV1 } from "../domain/index.js";
import { atomicWriteJSON, readJSON, withFileLock } from "../foundation/index.js";

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

export function withEvalProgressLock<T>(evalDirectory: string, action: () => Promise<T>): Promise<T> {
  return withFileLock(path.join(evalDirectory, ".progress-locks"), "publication", action);
}

/** Read the result and its progress projection under the publication lock. */
export async function readEvalState(evalDirectory: string): Promise<{
  progress: EvalProgressV1 | null; result: Record<string, unknown> | null;
}> {
  const exists = await lstat(evalDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!exists) return { progress: null, result: null };
  return withEvalProgressLock(evalDirectory, async () => {
    const value = await readJSON<unknown | null>(path.join(evalDirectory, "progress.json"), null);
    const result = await readJSON<Record<string, unknown> | null>(path.join(evalDirectory, "result.json"), null);
    if (value === null) return { progress: null, result };
    const progress = parseEvalProgress(value);
    if (!result) return { progress, result };
    const terminal = terminalEvalProgress(progress, result);
    if (JSON.stringify(terminal) !== JSON.stringify(progress)) await atomicWriteJSON(path.join(evalDirectory, "progress.json"), terminal);
    return { progress: terminal, result };
  });
}

export async function readEvalProgress(evalDirectory: string): Promise<EvalProgressV1 | null> {
  return (await readEvalState(evalDirectory)).progress;
}

/** A late running projection cannot resurrect a terminal eval. */
export async function writeEvalProgress(evalDirectory: string, input: EvalProgressV1,
  options: { terminalRepair?: boolean } = {}): Promise<EvalProgressV1> {
  return withEvalProgressLock(evalDirectory, async () => {
    const incoming = parseEvalProgress(input);
    const saved = await readJSON<unknown | null>(path.join(evalDirectory, "progress.json"), null);
    let current = saved === null ? null : parseEvalProgress(saved);
    const result = await readJSON<Record<string, unknown> | null>(path.join(evalDirectory, "result.json"), null);
    if (current && result) current = terminalEvalProgress(current, result);
    if (!current) {
      if (result) throw new TypeError("terminal eval progress requires an explicit preparation restart");
      await atomicWriteJSON(path.join(evalDirectory, "progress.json"), incoming);
      return incoming;
    }
    if (incoming.eval_id !== current.eval_id || incoming.benchmark_id !== current.benchmark_id
      || incoming.benchmark_revision !== current.benchmark_revision || incoming.started_at !== current.started_at
      || incoming.planned_tasks !== current.planned_tasks || incoming.planned_trials !== current.planned_trials) {
      throw new TypeError("eval progress identity changed");
    }
    let next = current;
    for (const trial of incoming.trials) {
      const previous = next.trials.find(item => evalTrialKey(item) === evalTrialKey(trial));
      if (previous && JSON.stringify(previous) === JSON.stringify(trial)) continue;
      if (current.status !== "running" && !options.terminalRepair) throw new TypeError("terminal eval cannot publish a new running projection");
      next = previous?.observation_status === "invalid" && trial.observation_status === "valid"
        ? replaceInvalidEvalProgressTrial(next, trial, incoming.updated_at) : mergeEvalProgressTrial(next, trial, incoming.updated_at);
    }
    // Reruns retain terminal status until their own final result is persisted.
    next = parseEvalProgress({ ...next, status: current.status === "running" ? incoming.status : current.status,
      updated_at: next.generation === current.generation ? current.updated_at : incoming.updated_at });
    await atomicWriteJSON(path.join(evalDirectory, "progress.json"), next);
    return next;
  });
}

export function terminalEvalProgress(progress: EvalProgressV1, result: Record<string, unknown>): EvalProgressV1 {
  if (!["succeeded", "failed", "cancelled"].includes(String(result.status)) || result.eval_id !== progress.eval_id
    || result.benchmark_id !== progress.benchmark_id || result.benchmark_revision !== progress.benchmark_revision) {
    throw new TypeError("terminal eval result/progress identity differs");
  }
  if (typeof result.completed_at !== "string" || !Number.isFinite(Date.parse(result.completed_at))) throw new TypeError("terminal eval result timestamp is invalid");
  const updatedAt = Date.parse(result.completed_at) >= Date.parse(progress.updated_at) ? result.completed_at : progress.updated_at;
  // This is shared by the terminal writer and crash recovery. A newer explicit
  // repair may already have replaced an old invalid reference in result.json.
  for (const value of Array.isArray(result.trials) ? result.trials : []) {
    const trial = parseEvalTrialRef(value);
    const previous: EvalTrialRefV1 | undefined = progress.trials.find(item => evalTrialKey(item) === evalTrialKey(trial));
    if (previous && JSON.stringify(previous) === JSON.stringify(trial)) continue;
    if (previous?.observation_status === "valid") {
      if (trial.observation_status === "valid") throw new TypeError("terminal result conflicts with a durable valid trial");
      continue;
    }
    progress = previous?.observation_status === "invalid" && trial.observation_status === "valid"
      ? replaceInvalidEvalProgressTrial(progress, trial, updatedAt) : mergeEvalProgressTrial(progress, trial, updatedAt);
  }
  return parseEvalProgress({ ...progress, status: result.status, updated_at: updatedAt });
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
    || !["running", "succeeded", "failed", "cancelled"].includes(String(record.status))) throw new TypeError("eval progress benchmark/status is invalid");
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
    status: record.status as EvalProgressV1["status"],
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
  const scores = trial.scores === undefined ? undefined : parseScores(trial.scores, label);
  if (scores !== undefined && (trial.observation_status !== "valid" || scores.total_score !== trial.reward)) {
    throw new TypeError(`${label} scores do not match the valid reward`);
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
    ...(scores === undefined ? {} : { scores }),
    ...(trial.verifier_result_ref === undefined ? {} : { verifier_result_ref: trial.verifier_result_ref as string }),
    ...(trial.invalid_reason === undefined ? {} : { invalid_reason: trial.invalid_reason as string }),
  };
  const reference = assessment ? { id: assessment.id as string, digest: assessment.digest as string } : undefined;
  return group ? { ...common, run_group: { run_group_id: group.run_group_id as string, digest: group.digest as `sha256:${string}` }, assessment: reference! }
    : { ...common, run_id: trial.run_id as string, ...(reference ? { assessment: reference } : {}) };
}

function parseScores(value: unknown, label: string): import("../domain/index.js").VerifierScoresV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} scores are invalid`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["total_score", "process_score", "normalization"].includes(key))
    || typeof record.total_score !== "number" || !Number.isFinite(record.total_score)
    || record.process_score !== undefined && (typeof record.process_score !== "number" || !Number.isFinite(record.process_score))
    || record.normalization !== "standard" && record.normalization !== "legacy-reward"
    || record.normalization === "legacy-reward" && record.process_score !== undefined) {
    throw new TypeError(`${label} scores are invalid`);
  }
  return {
    total_score: record.total_score,
    ...(record.process_score === undefined ? {} : { process_score: record.process_score as number }),
    normalization: record.normalization,
  };
}
