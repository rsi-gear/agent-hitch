import type { EvalExecutionPolicyV1, EvalId, EvalRequest, ExecutionProviderStatusV1, ModelCapturePlanV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
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
}

export async function schedulerQueuedEval(input: {
  evalId: EvalId;
  request: EvalRequest;
  execution: EvalExecutionPolicyV1;
  modelCapturePlan?: ModelCapturePlanV1;
  directory: string;
  collisionDomainId: string;
  resumeExisting?: boolean;
}): Promise<SchedulerQueuedEval> {
  const taskIds = await resolveLocalDatasetTaskIds(input.request.dataset);
  const fineGrained = taskIds !== null;
  return {
    evalId: input.evalId, request: input.request, execution: input.execution,
    ...(input.modelCapturePlan ? { modelCapturePlan: input.modelCapturePlan } : {}),
    directory: input.directory, fineGrained, resumeExisting: input.resumeExisting ?? false,
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
