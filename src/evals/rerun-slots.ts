import type { EvalProgressV1, EvalRequest, EvalTrialRefV1 } from "../domain/index.js";
import { HitchError, invalidInput } from "../foundation/index.js";
import { evalTrialKey } from "./progress.js";

export type RerunSelector =
  | { mode: "invalid" }
  | { mode: "tasks"; taskNames: readonly string[] };

export interface EvalTrialSlot {
  task_id: string;
  attempt: number;
}

export function selectRerunTasks(
  tasks: readonly string[],
  progress: EvalProgressV1,
  selector: RerunSelector,
  attempts = 1,
): string[] {
  return uniqueTasks(selectRerunTrialSlots(tasks, attempts, progress, selector));
}

export function selectRerunTrialSlots(
  tasks: readonly string[],
  attempts: number,
  progress: EvalProgressV1,
  selector: RerunSelector,
  options: { allowVerifierFailures?: boolean } = {},
): EvalTrialSlot[] {
  const planned = new Set(tasks);
  if (planned.size !== tasks.length || tasks.some((task) => typeof task !== "string" || task.length === 0)) {
    throw unavailable("eval task plan is invalid");
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw unavailable("eval attempts plan is invalid");
  const invalid = invalidTrialSlots(tasks, attempts, progress);
  if (selector.mode === "invalid") return options.allowVerifierFailures ? invalid : rejectVerifierOnlyReruns(progress, invalid);
  const requested = [...new Set(selector.taskNames)].sort();
  if (requested.length === 0) throw invalidInput("eval rerun requires at least one --task");
  for (const task of requested) {
    if (!planned.has(task)) throw new HitchError(`eval task is not in the plan: ${task}`, { code: "eval_rerun_unknown_task", exitCode: 2 });
    if (!invalid.some((slot) => slot.task_id === task)) {
      throw new HitchError(`eval task is already valid: ${task}`, { code: "eval_task_already_valid", exitCode: 2 });
    }
  }
  const requestedSet = new Set(requested);
  const selected = invalid.filter((slot) => requestedSet.has(slot.task_id));
  return options.allowVerifierFailures ? selected : rejectVerifierOnlyReruns(progress, selected);
}

function rejectVerifierOnlyReruns(progress: EvalProgressV1, slots: EvalTrialSlot[]): EvalTrialSlot[] {
  const selected = new Set(slots.map(slotKey));
  const verifierOnly = progress.trials.filter((trial) => selected.has(evalTrialKey(trial))
    && (trial.invalid_reason === "verifier_infrastructure_failure" || trial.invalid_reason === "verifier_result_missing"));
  if (verifierOnly.length === 0) return slots;
  throw new HitchError(
    `verifier-only retry is unavailable after the original trial environment closed: ${verifierOnly.map((trial) => `${trial.task_id}#${trial.attempt}`).join(", ")}; the Candidate Agent will not be rerun`,
    { code: "eval_verifier_only_rerun_unavailable", exitCode: 2 },
  );
}

export function invalidTrialSlots(tasks: readonly string[], attempts: number, progress: EvalProgressV1): EvalTrialSlot[] {
  const byKey = new Map<string, EvalTrialRefV1>();
  for (const trial of progress.trials) {
    const key = evalTrialKey(trial);
    if (byKey.has(key)) throw unavailable(`eval has duplicate logical trial: ${trial.task_id} attempt ${trial.attempt}`);
    byKey.set(key, trial);
  }
  const invalid: EvalTrialSlot[] = [];
  for (const task of tasks) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (byKey.get(slotKey({ task_id: task, attempt }))?.observation_status !== "valid") {
        invalid.push({ task_id: task, attempt });
      }
    }
  }
  return sortSlots(invalid);
}

export function validateProgressPlan(
  progress: EvalProgressV1,
  plan: { tasks: readonly string[]; attempts: number },
  request: EvalRequest,
  evalId: string,
): void {
  if (progress.eval_id !== evalId) throw unavailable("eval progress identity is invalid");
  if (progress.benchmark_id !== request.benchmark_id || progress.benchmark_revision !== request.benchmark_revision) {
    throw unavailable("eval progress benchmark identity changed");
  }
  if (progress.planned_tasks !== plan.tasks.length || progress.planned_trials !== plan.tasks.length * plan.attempts) {
    throw unavailable("eval progress does not match the frozen task/attempt plan");
  }
  const planned = new Set(plan.tasks);
  for (const trial of progress.trials) {
    if (trial.attempt > plan.attempts || !planned.has(trial.task_id)) {
      throw unavailable(`eval progress contains an unplanned trial: ${trial.task_id} attempt ${trial.attempt}`);
    }
  }
  invalidTrialSlots(plan.tasks, plan.attempts, progress);
}

export function slotKey(slot: EvalTrialSlot): string {
  return `${slot.task_id}\u0000${slot.attempt}`;
}

export function sortSlots(slots: readonly EvalTrialSlot[]): EvalTrialSlot[] {
  return [...slots]
    .map((slot) => ({ task_id: slot.task_id, attempt: slot.attempt }))
    .sort((left, right) => left.task_id.localeCompare(right.task_id) || left.attempt - right.attempt);
}

export function uniqueTasks(slots: readonly EvalTrialSlot[]): string[] {
  return [...new Set(slots.map((slot) => slot.task_id))].sort();
}

export function groupSlotsByAttempt(slots: readonly EvalTrialSlot[]): Array<[number, EvalTrialSlot[]]> {
  const grouped = new Map<number, EvalTrialSlot[]>();
  for (const slot of slots) {
    const current = grouped.get(slot.attempt) ?? [];
    current.push(slot);
    grouped.set(slot.attempt, current);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([attempt, values]) => [attempt, sortSlots(values)]);
}

export function attemptDirectoryName(attempt: number): string {
  return `attempt-${String(attempt).padStart(4, "0")}`;
}

export function formatSlot(slot: EvalTrialSlot): string {
  return `${slot.task_id}#${slot.attempt}`;
}

function unavailable(message: string): HitchError {
  return new HitchError(message, { code: "eval_rerun_unavailable", exitCode: 2 });
}
