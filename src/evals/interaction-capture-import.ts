import type { ModelCapturePlanV1 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, ensureDir } from "../foundation/index.js";
import { loadInteractionCapture } from "../model-access/index.js";
import type { EvalInteractionCaptureExporter } from "./service-types.js";

export async function importTrialInteractionCapture(input: {
  modelCapturePlan?: ModelCapturePlanV1;
  interactionCaptureExporter?: EvalInteractionCaptureExporter;
}, runId: string, staging: string): Promise<void> {
  const plan = input.modelCapturePlan;
  await writeTrialCapturePolicy(staging, plan);
  const expectsProxy = plan?.effective_mode === "proxy" || plan?.effective_mode === "hybrid";
  const existing = expectsProxy
    ? await loadInteractionCapture(staging).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    })
    : null;
  if (existing) {
    const ref = existing.ref;
    if (ref.run_id !== runId || ref.mode !== plan?.effective_mode || ref.required !== plan.required
      || ref.topology !== plan.topology || plan.required && ref.completeness !== "complete") {
      throw new HitchError("remote model interaction capture does not match its sealed plan", { code: "model_capture_incomplete", exitCode: 12 });
    }
    return;
  }
  if (!input.interactionCaptureExporter) {
    if (expectsProxy && plan.required) {
      throw new HitchError("required model interaction capture is unavailable", { code: "model_capture_incomplete", exitCode: 12 });
    }
    return;
  }
  const ref = await input.interactionCaptureExporter.finalizeRun(runId, staging);
  if (ref.run_id !== runId || ref.mode !== input.interactionCaptureExporter.route.mode) {
    throw new HitchError("model interaction capture identity does not match the run", { code: "model_capture_incomplete", exitCode: 12 });
  }
  if (input.interactionCaptureExporter.plan.required && ref.completeness !== "complete") {
    throw new HitchError("required model interaction capture is incomplete", { code: "model_capture_incomplete", exitCode: 12 });
  }
}

export async function writeTrialCapturePolicy(staging: string, plan?: ModelCapturePlanV1): Promise<void> {
  if (!plan) return;
  await ensureDir(`${staging}/interactions`);
  await atomicWriteJSON(`${staging}/interactions/capture.policy.json`, {
    schema_version: "1",
    requested_mode: plan.requested_mode,
    effective_mode: plan.effective_mode,
    required: plan.required,
    ...(plan.topology ? { topology: plan.topology } : {}),
    ...(plan.degraded_reason ? { degraded_reason: plan.degraded_reason } : {}),
  });
}
