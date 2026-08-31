import type { ModelCapturePlanV1 } from "../domain/index.js";

const DEFAULT_MODEL_CAPTURE_PLAN: ModelCapturePlanV1 = {
  requested_mode: "native",
  effective_mode: "native",
  required: false,
};

export function resolveEvalModelCapturePlan(input: {
  requested?: ModelCapturePlanV1 | undefined;
  resumed?: ModelCapturePlanV1 | undefined;
  resuming: boolean;
}): { plan: ModelCapturePlanV1; persist: boolean } {
  return {
    plan: input.requested ?? input.resumed ?? DEFAULT_MODEL_CAPTURE_PLAN,
    persist: !input.resuming || input.requested !== undefined || input.resumed !== undefined,
  };
}

export function modelCaptureDegradationEvent(plan?: ModelCapturePlanV1): Record<string, unknown> | null {
  if (!plan?.degraded_reason) return null;
  return {
    type: "interaction.capture.degraded",
    requested_mode: plan.requested_mode,
    effective_mode: plan.effective_mode,
    reason: plan.degraded_reason,
  };
}
