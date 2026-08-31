import path from "node:path";
import type { EvalExecutionPlanV1, EvalProgressV1 } from "../domain/index.js";
import type { EvalWorkStateSnapshot } from "./service-types.js";
import { readJSON, sha256JSON } from "../foundation/index.js";
import { parseEvalExecutionPlan } from "./execution-plan.js";
import { readEvalProgress } from "./progress.js";

export interface EvalResumeState {
  plan: Record<string, unknown>;
  executionPlan: EvalExecutionPlanV1;
  progress: EvalProgressV1;
  resolutionIdentity: string;
}

export async function loadEvalResumeState(evalDirectory: string): Promise<EvalResumeState> {
  const plan = await readJSON<Record<string, unknown>>(path.join(evalDirectory, "plan.json"));
  const executionPlan = parseEvalExecutionPlan(await readJSON<unknown>(path.join(evalDirectory, "execution-plan.json")));
  const progress = await readEvalProgress(evalDirectory);
  const resolution = await readJSON<Record<string, unknown>>(path.join(evalDirectory, "resolution.json"));
  if (!progress || typeof resolution.identity !== "string") throw new TypeError("resumable eval state is incomplete");
  return { plan, executionPlan, progress, resolutionIdentity: resolution.identity };
}

export function assertEvalResumeState(input: {
  state: EvalResumeState;
  expectedPlan: Record<string, unknown>;
  expectedExecutionPlan: EvalExecutionPlanV1;
  expectedResolutionIdentity: string;
  plannedTasks: number | null;
  plannedTrials: number | null;
}): void {
  const { state } = input;
  if (sha256JSON(state.plan) !== sha256JSON(input.expectedPlan)
    || sha256JSON(state.executionPlan) !== sha256JSON(input.expectedExecutionPlan)
    || state.resolutionIdentity !== input.expectedResolutionIdentity) {
    throw new TypeError("resumable eval plan identity changed");
  }
  if (state.progress.eval_id !== state.executionPlan.eval_id
    || state.progress.benchmark_id !== state.executionPlan.benchmark.id
    || state.progress.benchmark_revision !== state.executionPlan.benchmark.revision
    || state.progress.planned_tasks !== input.plannedTasks
    || state.progress.planned_trials !== input.plannedTrials) {
    throw new TypeError("resumable eval progress does not match its plan");
  }
}

export function executionPlanWorkState(plan: EvalExecutionPlanV1, progress: EvalProgressV1): EvalWorkStateSnapshot {
  const settled = new Set(progress.trials.map((trial) => `${trial.task_id}\0${trial.attempt}`));
  const terminalWorkItems = plan.work_items.filter((item) => item.logical_attempt !== null
    && item.task_ids.every((taskId) => settled.has(`${taskId}\0${item.logical_attempt}`))).map((item) => item.work_id);
  const terminal = new Set(terminalWorkItems);
  return { queuedWorkItems: plan.work_items.map((item) => item.work_id).filter((workId) => !terminal.has(workId)), terminalWorkItems };
}
