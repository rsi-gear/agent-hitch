import { getAdapter } from "../adapters/index.js";
import type { EvalExecutionPolicyV1, EvalRequest, ExecutionProviderStatusV1, ModelCapturePlanV1 } from "../domain/index.js";
import { planModelCapture } from "../model-access/index.js";
import { forceLocalInferenceCapturePlan } from "../evals/index.js";
import { HitchError } from "../foundation/index.js";

export function modelCapturePlanForEval(
  request: EvalRequest,
  execution: EvalExecutionPolicyV1,
  provider: ExecutionProviderStatusV1,
): ModelCapturePlanV1 {
  const separator = request.harness_ref.indexOf("@");
  const harnessId = separator < 0 ? request.harness_ref : request.harness_ref.slice(0, separator);
  const plan = planModelCapture({
    policy: execution.model_capture,
    adapter: getAdapter(harnessId).requirements,
    provider,
  });
  if (request.local_inference || request.training_binding) {
    const remote = execution.provider !== "local-docker";
    const feature = request.training_binding ? "training_external_binding" : "managed_model_node";
    if (remote && (!provider.features.model_proxy || provider.features[feature] !== "2"
      || request.local_inference && (!request.local_inference.model_node || !request.local_inference.inference_id))) {
      throw new HitchError(`remote provider requires ${feature}=2 and an immutable model route`, {
        code: "remote_model_binding_unsupported", exitCode: 10,
      });
    }
    return forceLocalInferenceCapturePlan(plan, remote ? "in-sandbox" : "host-side");
  }
  return plan;
}
