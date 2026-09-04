import type { EvalExecutionPlanV1 } from "../domain/index.js";
import type { EvalEventSink } from "./events.js";

export function emitEvalPlanLifecycle(sink: EvalEventSink, plan: EvalExecutionPlanV1, planningStartedAt: number): void {
  sink.emit({
    type: "eval.plan.created",
    duration_ms: Date.now() - planningStartedAt,
    work_items: plan.work_items.length,
    membership: plan.membership,
  });
  for (const workItem of plan.work_items) sink.emit({
    type: "eval.work.queued",
    work_id: workItem.work_id,
    task_ids: workItem.task_ids,
    reservation: workItem.reservation,
  });
  for (const workItem of plan.work_items) if (workItem.scheduling) sink.emit({
    type: "eval.work.priority-computed",
    work_id: workItem.work_id,
    slot_id: workItem.slots[0],
    task_id: workItem.task_ids[0],
    policy: workItem.scheduling.policy,
    estimated_duration_ms: workItem.scheduling.estimated_duration_ms,
    remaining_path_ms: workItem.scheduling.remaining_path_ms,
    estimate_source: workItem.scheduling.estimate_source,
    estimate_sample_count: workItem.scheduling.estimate_sample_count,
  });
}
