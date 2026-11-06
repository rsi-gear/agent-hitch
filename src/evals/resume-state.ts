import path from "node:path";
import type { EvalExecutionPlanV1, EvalProgressV1 } from "../domain/index.js";
import type { EvalWorkStateSnapshot } from "./service-types.js";
import { readJSON, sha256JSON, statePaths } from "../foundation/index.js";
import { parseEvalExecutionPlan } from "./execution-plan.js";
import { readEvalProgress } from "./progress.js";
import { useControllerRuntimeById } from "../controller-runtime/index.js";
import { loadRerunLocalTransport, loadRerunResolvedRevision } from "./rerun-inputs.js";

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

export async function loadResumedControllerRuntime(root: string, state: EvalResumeState) {
  const pin = state.plan.controller_runtime as { runtime_id?: unknown; manifest_digest?: unknown } | undefined;
  if (typeof pin?.runtime_id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(pin.runtime_id)
    || typeof pin.manifest_digest !== "string") throw new TypeError("resumable eval runtime identity is incomplete");
  const runtime = await useControllerRuntimeById(statePaths(root), pin.runtime_id.slice(7));
  if (runtime.runtime_id !== pin.runtime_id || runtime.manifest_digest !== pin.manifest_digest) throw new TypeError("resumable eval runtime identity changed");
  return runtime;
}

export async function loadResumedEvalSource(evalDirectory: string, state: Pick<EvalResumeState, "plan">, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  if (!state.plan.candidate || typeof state.plan.candidate !== "object" || Array.isArray(state.plan.candidate)) throw new TypeError("resumable eval candidate is missing");
  const plan = { candidate: state.plan.candidate as Record<string, unknown>, preparedArtifacts: [],
    ...(state.plan.local_source_transport ? { localSourceTransport: state.plan.local_source_transport as Record<string, unknown> } : {}) };
  const resolvedRevision = await loadRerunResolvedRevision(evalDirectory, plan);
  const localTransport = await loadRerunLocalTransport(evalDirectory, plan, resolvedRevision, env, signal);
  if (resolvedRevision.source.type === "git" && resolvedRevision.source.registered !== true && !localTransport) throw new TypeError("resumable local Git transport is missing");
  return { resolvedRevision, localTransport };
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
