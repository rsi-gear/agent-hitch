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
}
