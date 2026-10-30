import type { EvalExecutionPlanV1, EvalRequest, ExternalEndpointBindingV1 } from "../domain/index.js";
import { HitchError, sha256JSON } from "../foundation/index.js";

/** Physical reruns retain their source work contract. They cannot silently
 * carry an explicit approval across a changed execution identity. */
export function assertRerunResourceApproval(input: {
  plan: EvalExecutionPlanV1; request: EvalRequest; controllerRuntimeId: string;
  trials: readonly { task_id: string; attempt: number }[];
  endpointBinding?: ExternalEndpointBindingV1; verifierRuntimeId?: string;
}): void {
  const changed = input.endpointBinding !== undefined && sha256JSON(input.endpointBinding) !== sha256JSON(input.request.endpoint_binding ?? null)
    || input.verifierRuntimeId !== undefined && input.verifierRuntimeId !== input.controllerRuntimeId;
  if (!changed) return;
  for (const trial of input.trials) {
    const approval = input.plan.resource_profiling?.approvals.find(entry => entry.task_id === trial.task_id);
    const slot = input.plan.slots.find(entry => entry.task_id === trial.task_id && entry.attempt === trial.attempt);
    const work = slot && input.plan.work_items.find(entry => entry.slots.includes(slot.slot_id));
    if (approval && work?.resource_profiling?.approval_digests.includes(approval.approval_digest)) {
      throw new HitchError(`resource approval for ${trial.task_id} does not cover the changed endpoint or verifier runtime; create a new eval plan and approve its resource identity`, {
        code: "eval_rerun_resource_approval_changed", exitCode: 12,
      });
    }
  }
}
