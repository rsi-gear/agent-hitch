import path from "node:path";
import type { EvalExecutionPolicyV1, EvalId, EvalRequest, ExecutionProviderStatusV1, ModelCapturePlanV1, WorkResourceProfilingV1 } from "../domain/index.js";
import { HitchError, readJSON } from "../foundation/index.js";
import { parseEvalExecutionPlan } from "../evals/index.js";
import { resolveLocalDatasetTaskIds } from "../evals/index.js";
import { evalTaskCollisionKey } from "./eval-records.js";
import { modelCapturePlanForEval } from "./model-capture-planning.js";
import type { RemoteWorkCoordinator } from "./remote-work-coordinator.js";

export interface SchedulerQueuedEval {
  evalId: EvalId;
  request: EvalRequest;
  execution: EvalExecutionPolicyV1;
  modelCapturePlan?: ModelCapturePlanV1;
  directory: string;
  collisionKeys: string[];
  fineGrained: boolean;
  resumeExisting: boolean;
  coarseProfiling?: WorkResourceProfilingV1;
  coarseParallelism?: number;
}

export async function schedulerQueuedEval(input: {
  evalId: EvalId;
  request: EvalRequest;
  execution: EvalExecutionPolicyV1;
  modelCapturePlan?: ModelCapturePlanV1;
  directory: string;
  collisionDomainId: string;
  resumeExisting?: boolean;
  unknownMaxParallelism?: number;
}): Promise<SchedulerQueuedEval> {
  const frozen = input.resumeExisting ? parseEvalExecutionPlan(await readJSON(path.join(input.directory, "execution-plan.json"))) : undefined;
  const fineGrained = frozen ? frozen.membership === "known" && frozen.work_items.every(work => work.slots.length === 1)
    : await resolveLocalDatasetTaskIds(input.request.dataset) !== null;
  const coarseProfiling: WorkResourceProfilingV1 | undefined = fineGrained ? undefined : frozen ? frozen.work_items[0]?.resource_profiling
    : { schema_version: "1", unknown: true, unknown_max_parallelism: input.unknownMaxParallelism ?? 1,
      unknown_slots: Math.min(input.execution.max_parallelism, input.unknownMaxParallelism ?? 1), reason: "unknown-task-membership", approval_digests: [] };
  if (coarseProfiling?.unknown && coarseProfiling.unknown_slots > (input.unknownMaxParallelism ?? 1)) {
    throw new HitchError("frozen unknown work exceeds the worker profiling cap; restore that operator capacity or create a new plan", {
      code: "resource_request_unsatisfiable", exitCode: 10,
    });
  }
  return {
    evalId: input.evalId, request: input.request, execution: input.execution,
    ...(input.modelCapturePlan ? { modelCapturePlan: input.modelCapturePlan } : {}),
    directory: input.directory, fineGrained, resumeExisting: input.resumeExisting ?? false,
    ...(coarseProfiling ? { coarseProfiling } : {}),
    ...(!fineGrained && frozen ? { coarseParallelism: frozen.max_parallelism } : {}),
    collisionKeys: fineGrained ? [] : [evalTaskCollisionKey(input.request, "*", input.collisionDomainId)],
  };
}

export async function schedulerCapturePlan(input: {
  request: EvalRequest;
  execution: EvalExecutionPolicyV1;
  localProvider: string;
  localStatus: ExecutionProviderStatusV1;
  remoteWork?: RemoteWorkCoordinator;
}): Promise<ModelCapturePlanV1> {
  if (input.execution.provider === input.localProvider) return modelCapturePlanForEval(input.request, input.execution, input.localStatus);
  const statuses = await input.remoteWork?.providerStatuses(input.execution.provider) ?? [];
  if (statuses.length === 0) throw new HitchError(`execution provider is unavailable: ${input.execution.provider}`, { code: "execution_provider_unavailable", exitCode: 10 });
  let lastError: unknown;
  for (const status of statuses) {
    try { return modelCapturePlanForEval(input.request, input.execution, status); }
    catch (error) { lastError = error; }
  }
  throw lastError;
}
