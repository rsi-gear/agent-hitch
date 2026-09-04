import type { BackendWorkItemV1, EvalTrialRefV1 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";

/** Derive one unique physical work identity for a Candidate infrastructure
 * retry. The logical slot and original work item remain unchanged. */
export function physicalRetryWorkItem(
  item: BackendWorkItemV1,
  retry: number,
  triggers: readonly EvalTrialRefV1[],
): BackendWorkItemV1 {
  return physicalRetryWorkItemForTriggerIds(item, retry, triggers.map((trial) => trial.trial_id));
}

export function physicalRetryWorkItemForTriggerIds(
  item: BackendWorkItemV1,
  retry: number,
  triggerTrialIds: readonly string[],
): BackendWorkItemV1 {
  if (!Number.isSafeInteger(retry) || retry < 1) throw new TypeError("physical retry index must be a positive safe integer");
  const triggerTrials = [...new Set(triggerTrialIds)].sort(compareBytes);
  if (triggerTrials.length === 0) throw new TypeError("physical retry requires at least one trigger trial");
  const identity = sha256JSON({
    origin_work_id: item.work_id,
    slots: item.slots,
    execution_kind: "physical-infrastructure-retry",
    retry,
    trigger_trials: triggerTrials,
  });
  return {
    ...item,
    work_id: `work_${identity.slice("sha256:".length, "sha256:".length + 32)}`,
    ...(item.scheduling ? {
      scheduling: { ...item.scheduling, remaining_path_ms: item.scheduling.estimated_duration_ms },
    } : {}),
  };
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
