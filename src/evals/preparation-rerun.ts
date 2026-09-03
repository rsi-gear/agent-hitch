import { cp, lstat, readdir, rename } from "node:fs/promises";
import path from "node:path";
import type { EvalRequest } from "../domain/index.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, ensureDir, readJSON } from "../foundation/index.js";
import { logicalPlanModelCapture, readEvalLogicalPlan } from "./eval-logical-plan.js";
import { readEvalProgress } from "./progress.js";
import { validateEvalId } from "./request.js";
import { evalRerunSemantics } from "./rerun-types.js";
import type { EvalRerunResult, EvalRerunType, RerunEvalOptions } from "./rerun-types.js";
import { invalidTrialSlots, slotKey, sortSlots, uniqueTasks, validateProgressPlan } from "./rerun-slots.js";
import type { EvalTrialSlot } from "./rerun-slots.js";
import { runEval } from "./service.js";

type RecoveryOptions = RerunEvalOptions & {
  rerunId: string;
  rerunType: EvalRerunType;
  evalId: string;
  evalDirectory: string;
};

/** Restart an eval that failed before its executable plan was fully materialized. */
export async function restartIncompleteEval(
  options: RecoveryOptions,
  request: EvalRequest,
  startedAt: string,
  rerunDirectory: string,
  statePath: string,
): Promise<EvalRerunResult | null> {
  const materializedFiles = ["plan.json", "execution-plan.json", "progress.json"];
  if ((await Promise.all(materializedFiles.map((name) => exists(path.join(options.evalDirectory, name))))).every(Boolean)) return null;
  const failedResult = await readJSON<Record<string, unknown> | null>(path.join(options.evalDirectory, "result.json"), null);
  if (failedResult === null) return null;
  if (options.rerunType !== "candidate-restart" || options.selector.mode !== "invalid") {
    throw unavailable("an eval with incomplete preparation can only be restarted with candidate-restart --invalid");
  }
  if (failedResult?.status === "cancelled") {
    throw new HitchError("cancelled eval cannot be rerun", { code: "eval_rerun_cancelled", exitCode: 2 });
  }
  if (failedResult?.status !== "failed" || !Array.isArray(failedResult.trials) || failedResult.trials.length !== 0) {
    throw unavailable("eval preparation is incomplete but the source is not a failed pre-execution attempt");
  }

  const logicalPlan = await readEvalLogicalPlan(options.evalDirectory, options.evalId, request).catch((error) => {
    throw unavailable((error as Error).message);
  });
  await writeRequest(rerunDirectory, options, startedAt, [], []);
  await writeState(statePath, options, startedAt, "running", [], [], [], []);
  await archiveIncompleteAttempt(options, rerunDirectory, failedResult);

  try {
    const modelCapturePlan = logicalPlanModelCapture(logicalPlan);
    const restarted = await runEval({
      evalId: validateEvalId(options.evalId),
      root: options.root,
      request,
      normalizedRequest: request,
      precreated: true,
      replaceTerminal: true,
      env: options.env ?? process.env,
      ...(options.maxConcurrentOverride === undefined ? {} : { maxConcurrentOverride: options.maxConcurrentOverride }),
      ...(options.harborExecutable === undefined ? {} : { harborExecutable: options.harborExecutable }),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.trialBundleGraceMs === undefined ? {} : { trialBundleGraceMs: options.trialBundleGraceMs }),
      ...(options.executionResources ? { executionResources: options.executionResources } : {}),
      ...(options.executionResourceSource ? { executionResourceSource: options.executionResourceSource } : {}),
      executionStrategy: options.executionStrategy
        ?? (logicalPlan?.attempt_execution === "harbor-task-slots-v1" ? "local-task-slots-v1" : "legacy-attempt-shards"),
      ...(options.environmentBuildMode ? { environmentBuildMode: options.environmentBuildMode } : {}),
      ...(modelCapturePlan ? { modelCapturePlan } : {}),
      ...(options.harborArtifactBuilder ? { harborArtifactBuilder: options.harborArtifactBuilder } : {}),
    });
    if (restarted.status === "cancelled") {
      throw new HitchError("eval rerun was aborted", { code: "eval_rerun_aborted", exitCode: 9 });
    }
    const [planValue, executionPlanValue, progress] = await Promise.all([
      readJSON<unknown | null>(path.join(options.evalDirectory, "plan.json"), null),
      readJSON<unknown | null>(path.join(options.evalDirectory, "execution-plan.json"), null),
      readEvalProgress(options.evalDirectory),
    ]);
    if (planValue === null || executionPlanValue === null || progress === null) throw restartFailure(restarted);

    const plan = parseRecoveredPlan(planValue, options.evalId, request);
    validateProgressPlan(progress, plan, request, options.evalId);
    const selectedTrials = sortSlots(plan.tasks.flatMap((taskId) => Array.from(
      { length: plan.attempts },
      (_, index) => ({ task_id: taskId, attempt: index + 1 }),
    )));
    const valid = new Set(progress.trials.filter((trial) => trial.observation_status === "valid").map(slotKey));
    const repairedTrials = selectedTrials.filter((trial) => valid.has(slotKey(trial)));
    const remainingTrials = invalidTrialSlots(plan.tasks, plan.attempts, progress);
    const selectedTasks = uniqueTasks(selectedTrials);
    const repairedTasks = uniqueTasks(repairedTrials);
    const remainingTasks = uniqueTasks(remainingTrials);
    const completedAt = new Date().toISOString();
    await writeRequest(rerunDirectory, options, startedAt, selectedTasks, selectedTrials);
    const output: EvalRerunResult = {
      schema_version: "1",
      kind: "eval-rerun",
      rerun_id: options.rerunId,
      rerun_type: options.rerunType,
      semantics: evalRerunSemantics(options.rerunType),
      eval_id: options.evalId,
      status: "completed",
      selected_tasks: selectedTasks,
      repaired_tasks: repairedTasks,
      remaining_invalid_tasks: remainingTasks,
      selected_trials: selectedTrials,
      repaired_trials: repairedTrials,
      remaining_invalid_trials: remainingTrials,
      eval_status: restarted.status === "succeeded" ? "succeeded" : "failed",
      started_at: startedAt,
      completed_at: completedAt,
    };
    await writeState(statePath, options, startedAt, "completed", selectedTasks, selectedTrials, repairedTasks, repairedTrials, {
      completedAt,
      evalStatus: output.eval_status,
      remainingTasks,
      remainingTrials,
    });
    return output;
  } catch (error) {
    await writeState(statePath, options, startedAt, "failed", [], [], [], [], {
      completedAt: new Date().toISOString(),
      errorCode: error instanceof HitchError ? error.code : "eval_rerun_failed",
    }).catch(() => {});
    throw error;
  }
}

async function archiveIncompleteAttempt(
  options: RecoveryOptions,
  rerunDirectory: string,
  result: Record<string, unknown>,
): Promise<void> {
  const archive = path.join(rerunDirectory, "previous-attempt");
  await ensureDir(archive);
  for (const name of ["request.json", "submission.json", "control.json", "result.json"]) {
    const source = path.join(options.evalDirectory, name);
    if (await exists(source)) await cp(source, path.join(archive, name), { recursive: true, errorOnExist: true });
  }
  const stable = new Set(["request.json", "submission.json", "control.json", "result.json", "reruns"]);
  for (const entry of await readdir(options.evalDirectory, { withFileTypes: true })) {
    if (stable.has(entry.name)) continue;
    await rename(path.join(options.evalDirectory, entry.name), path.join(archive, entry.name));
  }
  const failure = result.error && typeof result.error === "object" && !Array.isArray(result.error)
    ? result.error as Record<string, unknown>
    : null;
  await atomicWriteJSON(path.join(archive, "recovery.json"), {
    schema_version: SCHEMA_VERSION,
    kind: "eval-preparation-restart",
    eval_id: options.evalId,
    rerun_id: options.rerunId,
    ...(typeof result.failure_stage === "string" ? { failure_stage: result.failure_stage } : {}),
    ...(typeof failure?.code === "string" ? { failure_code: failure.code } : {}),
    archived_at: new Date().toISOString(),
  });
}

function restartFailure(result: Record<string, unknown>): HitchError {
  const error = result.error && typeof result.error === "object" && !Array.isArray(result.error)
    ? result.error as Record<string, unknown>
    : null;
  const code = typeof error?.code === "string" && error.code ? error.code : "eval_rerun_preparation_failed";
  const stage = typeof result.failure_stage === "string" ? result.failure_stage : "preparing";
  const message = typeof error?.message === "string" && error.message ? error.message : "eval restart did not produce an executable plan";
  return new HitchError(`eval restart failed during ${stage}: ${message}`, {
    code,
    exitCode: Number.isSafeInteger(result.exit_code) ? result.exit_code as number : 12,
  });
}

function parseRecoveredPlan(value: unknown, evalId: string, request: EvalRequest): { tasks: string[]; attempts: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable("recovered eval plan is missing");
  const plan = value as Record<string, unknown>;
  if (plan.schema_version !== SCHEMA_VERSION || plan.eval_id !== evalId || plan.dataset !== request.dataset
    || plan.benchmark_id !== request.benchmark_id || plan.benchmark_revision !== request.benchmark_revision
    || !Number.isSafeInteger(plan.attempts) || plan.attempts !== request.attempts) {
    throw unavailable("recovered eval plan identity changed");
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0
    || plan.tasks.some((task) => typeof task !== "string" || task.length === 0)
    || new Set(plan.tasks).size !== plan.tasks.length) throw unavailable("recovered eval task plan is invalid");
  return { tasks: [...plan.tasks as string[]], attempts: plan.attempts as number };
}

async function writeRequest(
  directory: string,
  options: RecoveryOptions,
  startedAt: string,
  tasks: readonly string[],
  trials: readonly EvalTrialSlot[],
): Promise<void> {
  await atomicWriteJSON(path.join(directory, "request.json"), {
    schema_version: SCHEMA_VERSION,
    rerun_id: options.rerunId,
    eval_id: options.evalId,
    rerun_type: options.rerunType,
    semantics: evalRerunSemantics(options.rerunType),
    mode: options.selector.mode,
    tasks: [...tasks],
    trials: sortSlots(trials),
    base_generation: 0,
    created_at: startedAt,
  });
}

async function writeState(
  file: string,
  options: RecoveryOptions,
  startedAt: string,
  status: "running" | "completed" | "failed",
  tasks: readonly string[],
  trials: readonly EvalTrialSlot[],
  repairedTasks: readonly string[],
  repairedTrials: readonly EvalTrialSlot[],
  terminal: {
    completedAt?: string;
    evalStatus?: "succeeded" | "failed";
    remainingTasks?: readonly string[];
    remainingTrials?: readonly EvalTrialSlot[];
    errorCode?: string;
  } = {},
): Promise<void> {
  await atomicWriteJSON(file, {
    schema_version: SCHEMA_VERSION,
    rerun_id: options.rerunId,
    eval_id: options.evalId,
    rerun_type: options.rerunType,
    semantics: evalRerunSemantics(options.rerunType),
    status,
    tasks: [...tasks],
    trials: sortSlots(trials),
    repaired_tasks: [...repairedTasks],
    repaired_trials: sortSlots(repairedTrials),
    started_at: startedAt,
    ...(terminal.completedAt ? { completed_at: terminal.completedAt } : {}),
    ...(terminal.evalStatus ? { eval_status: terminal.evalStatus } : {}),
    ...(terminal.remainingTasks ? { remaining_invalid_tasks: [...terminal.remainingTasks] } : {}),
    ...(terminal.remainingTrials ? { remaining_invalid_trials: sortSlots(terminal.remainingTrials) } : {}),
    ...(terminal.errorCode ? { error: { code: terminal.errorCode } } : {}),
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function unavailable(message: string): HitchError {
  return new HitchError(message, { code: "eval_rerun_unavailable", exitCode: 2 });
}
