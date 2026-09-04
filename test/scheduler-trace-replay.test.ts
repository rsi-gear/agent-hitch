import test from "node:test";
import assert from "node:assert/strict";
import { replaySchedulerTrace, type SchedulerTraceWorkV1 } from "../src/evals/index.js";

test("trace replay models immediate retry without a batch barrier", () => {
  const work: SchedulerTraceWorkV1[] = [
    trace("a-initial", "a", "initial", 0, 100, 0),
    trace("a-retry", "a", "physical-infrastructure-retry", 1, 200, 0),
    trace("b-initial", "b", "initial", 0, 250, 1),
    trace("c-initial", "c", "initial", 0, 250, 2),
  ];
  const batch = replaySchedulerTrace(work, { slots: 2, policy: "critical-path-v1", retryScheduling: "batch-v1" });
  const immediate = replaySchedulerTrace(work, { slots: 2, policy: "critical-path-v1", retryScheduling: "immediate-v1" });
  assert.equal(batch.makespan_ms, 550);
  assert.equal(immediate.makespan_ms, 450);
  assert.equal(immediate.physical_work_ms, 800);
  assert.equal(immediate.runnable_idle_ms, 0);
});

function trace(
  workId: string,
  taskId: string,
  executionKind: SchedulerTraceWorkV1["execution_kind"],
  retryIndex: number,
  durationMs: number,
  queuedOrder: number,
): SchedulerTraceWorkV1 {
  return {
    work_id: workId, task_id: taskId, execution_kind: executionKind,
    retry_index: retryIndex, duration_ms: durationMs, queued_order: queuedOrder,
  };
}
