import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ResolvedRevision } from "../artifacts/index.js";
import { readHarborRawResult } from "../backends/index.js";
import type { EvalExecutionPlanV1, EvalProgressV1, EvalRequest, EvalTrialRefV1 } from "../domain/index.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, readJSON } from "../foundation/index.js";
import { summarizeTrialRefs } from "./result-helpers.js";
import { parseEvalExecutionPlan } from "./execution-plan.js";
import { replaceInvalidEvalProgressTrial, writeEvalProgress } from "./progress.js";
import { evalRerunSemantics } from "./rerun-types.js";
import type { EvalRerunResult } from "./rerun-types.js";
import { formatSlot, invalidTrialSlots, slotKey, sortSlots, uniqueTasks } from "./rerun-slots.js";
import type { EvalTrialSlot } from "./rerun-slots.js";
import { importEvalTrialRun, TrialBundlePendingError, validateEvalTrialReferences } from "./trial-import.js";

export interface CollectOnlyRerunInput {
  root: string;
  evalId: string;
  evalDirectory: string;
  rerunId: string;
  rerunDirectory: string;
  startedAt: string;
  request: EvalRequest;
  plan: {
    tasks: string[];
    attempts: number;
    candidate: Record<string, unknown>;
    controllerRuntime: Record<string, unknown>;
  };
  progress: EvalProgressV1;
  previousResult: Record<string, unknown> | null;
  selectedTrials: EvalTrialSlot[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

interface CollectedSource {
  source_trial_id: string;
  source_run_id?: string;
  source_run_group_id?: string;
  source_work_id: string;
  source_backend_directory: string;
}

export async function collectOnlyEvalRerun(input: CollectOnlyRerunInput): Promise<EvalRerunResult> {
  const executionPlan = parseEvalExecutionPlan(await readJSON<unknown>(path.join(input.evalDirectory, "execution-plan.json")));
  if (executionPlan.eval_id !== input.evalId || executionPlan.membership !== "known") throw unavailable("collect-only requires a known-task execution plan");
  const resolution = await readJSON<ResolvedRevision>(path.join(input.evalDirectory, "resolution.json"));
  if (resolution.identity !== requiredString(input.plan.candidate.revision_identity, "candidate revision identity")) throw unavailable("collect-only resolution identity changed");
  const runtimeId = requiredString(input.plan.controllerRuntime.runtime_id, "controller runtime id");
  let progress = input.progress;
  const baseRefs = progress.trials.filter((ref) => !input.selectedTrials.some((slot) => slotKey(slot) === slotKey(ref)));
  const collectedRefs: EvalTrialRefV1[] = [];
  const sources: CollectedSource[] = [];
  for (const slot of input.selectedTrials) {
    const collected = await collectSlot(input, executionPlan, resolution, runtimeId, slot, [...baseRefs, ...collectedRefs]);
    collectedRefs.push(collected.ref);
    sources.push(collected.source);
  }
  for (const ref of collectedRefs) progress = replaceInvalidEvalProgressTrial(progress, ref);
  if (progress.generation !== input.progress.generation) await writeEvalProgress(input.evalDirectory, progress);
  const remainingTrials = invalidTrialSlots(input.plan.tasks, input.plan.attempts, progress);
  const remainingTasks = uniqueTasks(remainingTrials);
  const repairedTrials = sortSlots(collectedRefs.map((ref) => ({ task_id: ref.task_id, attempt: ref.attempt })));
  const repairedTasks = uniqueTasks(repairedTrials);
  const succeeded = remainingTrials.length === 0;
  const completedAt = new Date().toISOString();
  await writeEvalResult(input, progress, remainingTrials, succeeded, completedAt);
  await atomicWriteJSON(path.join(input.rerunDirectory, "state.json"), {
    schema_version: SCHEMA_VERSION,
    rerun_id: input.rerunId,
    eval_id: input.evalId,
    rerun_type: "collect-only",
    semantics: evalRerunSemantics("collect-only"),
    status: "completed",
    tasks: uniqueTasks(input.selectedTrials),
    trials: sortSlots(input.selectedTrials),
    repaired_tasks: repairedTasks,
    repaired_trials: repairedTrials,
    remaining_invalid_tasks: remainingTasks,
    remaining_invalid_trials: remainingTrials,
    sources,
    eval_status: succeeded ? "succeeded" : "failed",
    started_at: input.startedAt,
    completed_at: completedAt,
    updated_at: completedAt,
  });
  return {
    schema_version: "1",
    kind: "eval-rerun",
    rerun_id: input.rerunId,
    rerun_type: "collect-only",
    semantics: evalRerunSemantics("collect-only"),
    eval_id: input.evalId,
    status: "completed",
    selected_tasks: uniqueTasks(input.selectedTrials),
    repaired_tasks: repairedTasks,
    remaining_invalid_tasks: remainingTasks,
    selected_trials: sortSlots(input.selectedTrials),
    repaired_trials: repairedTrials,
    remaining_invalid_trials: remainingTrials,
    sources,
    eval_status: succeeded ? "succeeded" : "failed",
    started_at: input.startedAt,
    completed_at: completedAt,
  };
}

async function collectSlot(
  input: CollectOnlyRerunInput,
  executionPlan: EvalExecutionPlanV1,
  resolution: ResolvedRevision,
  runtimeId: string,
  slot: EvalTrialSlot,
  existingRefs: EvalTrialRefV1[],
): Promise<{ ref: EvalTrialRefV1; source: CollectedSource }> {
  const plannedSlot = executionPlan.slots.find((entry) => entry.task_id === slot.task_id && entry.attempt === slot.attempt);
  const work = plannedSlot && executionPlan.work_items.find((entry) => entry.slots.includes(plannedSlot.slot_id));
  if (!plannedSlot || !work || work.task_ids.length !== 1 || work.task_ids[0] !== slot.task_id) {
    throw unavailable(`collect-only has no isolated work item for ${formatSlot(slot)}`);
  }
  const workDirectory = path.join(input.evalDirectory, "harbor", "work-items", work.work_id);
  let entries;
  try { entries = await readdir(workDirectory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw unavailable(`collect-only source is missing for ${formatSlot(slot)}`);
    throw error;
  }
  const epochs = entries.filter((entry) => entry.isDirectory() && /^epoch-[0-9]{6}$/.test(entry.name))
    .map((entry) => entry.name).sort().reverse();
  for (const epoch of epochs) {
    const relativeBackend = path.join("harbor", "work-items", work.work_id, epoch);
    const jobDirectory = path.join(input.evalDirectory, relativeBackend, "job");
    const raw = await readHarborRawResult(jobDirectory);
    const trials = Array.isArray(raw?.trial_results) ? raw.trial_results as Record<string, unknown>[] : [];
    if (!raw || trials.length === 0) continue;
    const imported = [...existingRefs];
    for (const [index, trial] of trials.entries()) {
      try {
        const ref = await importEvalTrialRun({
          root: input.root,
          evalId: input.evalId,
          evalDirectory: input.evalDirectory,
          harborJobDirectory: jobDirectory,
          expectedAttempt: slot.attempt,
          request: input.request,
          resolvedRevision: resolution,
          benchmarkId: input.request.benchmark_id,
          benchmarkRevision: input.request.benchmark_revision,
          publicationMode: "replace-invalid",
          runtimeId,
          env: input.env ?? process.env,
          ...(input.signal ? { signal: input.signal } : {}),
          requireCompleteMarker: true,
        }, trial, index, imported);
        if (!imported.some((entry) => entry.trial_id === ref.trial_id)) imported.push(ref);
      } catch (error) {
        if (error instanceof TrialBundlePendingError) continue;
        throw error;
      }
    }
    const ref = imported.find((entry) => entry.task_id === slot.task_id && entry.attempt === slot.attempt && entry.observation_status === "valid");
    if (!ref) continue;
    await validateEvalTrialReferences(input.root, input.evalId, [ref], {
      benchmarkId: input.request.benchmark_id,
      benchmarkRevision: input.request.benchmark_revision,
    });
    return {
      ref,
      source: {
        source_trial_id: ref.trial_id,
        ...(ref.run_group ? { source_run_group_id: ref.run_group.run_group_id } : { source_run_id: ref.run_id }),
        source_work_id: work.work_id,
        source_backend_directory: relativeBackend.split(path.sep).join("/"),
      },
    };
  }
  throw new HitchError(`collect-only found no complete valid result for ${formatSlot(slot)}`, {
    code: "eval_collect_only_result_unavailable",
    exitCode: 12,
  });
}

async function writeEvalResult(
  input: CollectOnlyRerunInput,
  progress: EvalProgressV1,
  remainingTrials: EvalTrialSlot[],
  succeeded: boolean,
  completedAt: string,
): Promise<void> {
  const result: Record<string, unknown> = {
    ...(input.previousResult ?? {}),
    schema_version: SCHEMA_VERSION,
    eval_id: input.evalId,
    status: succeeded ? "succeeded" : "failed",
    exit_code: succeeded ? 0 : 13,
    candidate: input.plan.candidate,
    dataset: input.request.dataset,
    benchmark_id: input.request.benchmark_id,
    benchmark_revision: input.request.benchmark_revision,
    generation: progress.generation,
    trials: progress.trials,
    summary: summarizeTrialRefs(progress.trials),
    ...(succeeded ? {} : { error: { code: "eval_has_invalid_tasks", message: `eval has invalid or missing trials: ${remainingTrials.map(formatSlot).join(", ")}` } }),
    started_at: typeof input.previousResult?.started_at === "string" ? input.previousResult.started_at : progress.started_at,
    completed_at: completedAt,
  };
  if (succeeded) delete result.error;
  await atomicWriteJSON(path.join(input.evalDirectory, "result.json"), result);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw unavailable(`${label} is missing`);
  return value;
}

function unavailable(message: string): HitchError {
  return new HitchError(message, { code: "eval_collect_only_unavailable", exitCode: 2 });
}
