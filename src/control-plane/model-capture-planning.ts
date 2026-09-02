import { getAdapter } from "../adapters/index.js";
import type { EvalExecutionPolicyV1, EvalRequest, ExecutionProviderStatusV1, ModelCapturePlanV1 } from "../domain/index.js";
import { planModelCapture } from "../model-access/index.js";

export function modelCapturePlanForEval(
  request: EvalRequest,
  execution: EvalExecutionPolicyV1,
  provider: ExecutionProviderStatusV1,
): ModelCapturePlanV1 {
  const separator = request.harness_ref.indexOf("@");
  const harnessId = separator < 0 ? request.harness_ref : request.harness_ref.slice(0, separator);
  return planModelCapture({
    policy: execution.model_capture,
    adapter: getAdapter(harnessId).requirements,
    provider,
  });
}
