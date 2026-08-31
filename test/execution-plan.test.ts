import test from "node:test";
import assert from "node:assert/strict";
import { buildEvalExecutionPlan, parseEvalExecutionPlan, validateEvalId } from "../src/evals/index.js";
import type { EvalRequest } from "../src/domain/index.js";

const request: EvalRequest = {
  schema_version: "1",
  backend: "harbor",
  dataset: "demo@1.0",
  harness_ref: "pi@version:1.2.3",
  model: "openai/test",
  attempts: 2,
  max_concurrent: 4,
  infrastructure_retries: 1,
  infrastructure_retry_backoff_ms: 1_000,
  timeout_ms: 900_000,
  setup_timeout_ms: 1_800_000,
  agent_args: ["--test"],
  pass_env: [],
  benchmark_id: "demo",
  benchmark_revision: "1.0",
};

const input = {
  evalId: validateEvalId("eval_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  request,
  candidate: {
    revisionIdentity: `sha256:${"b".repeat(64)}`,
    artifactId: `sha256:${"c".repeat(64)}`,
  },
  maxParallelism: 2,
  trialResources: { cpu_millis: 2_000, memory_bytes: 4_096, container_slots: 1, build_slots: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
};

test("execution plan creates deterministic slots and attempt work items for known tasks", () => {
  const plan = buildEvalExecutionPlan({ ...input, tasks: ["two", "one"] });
  assert.equal(plan.membership, "known");
  assert.deepEqual(plan.slots.map((slot) => `${slot.task_id}#${slot.attempt}`), ["one#1", "one#2", "two#1", "two#2"]);
  assert.equal(new Set(plan.slots.map((slot) => slot.slot_id)).size, 4);
  assert.deepEqual(plan.work_items.map((item) => ({ attempt: item.logical_attempt, tasks: item.task_ids, parallelism: item.requested_parallelism })), [
    { attempt: 1, tasks: ["one", "two"], parallelism: 2 },
    { attempt: 2, tasks: ["one", "two"], parallelism: 2 },
  ]);
  assert.deepEqual(plan.work_items[0]?.reservation, { cpu_millis: 4_000, memory_bytes: 8_192, container_slots: 2, build_slots: 0 });
  assert.deepEqual(parseEvalExecutionPlan(plan), plan);
  assert.deepEqual(buildEvalExecutionPlan({ ...input, tasks: ["one", "two"] }), plan);
});

test("execution plan conservatively represents opaque dataset membership", () => {
  const plan = buildEvalExecutionPlan({ ...input, tasks: null });
  assert.equal(plan.membership, "opaque");
  assert.deepEqual(plan.slots, []);
  assert.equal(plan.work_items.length, 1);
  assert.equal(plan.work_items[0]?.opaque_membership, true);
  assert.equal(plan.work_items[0]?.requested_parallelism, 2);
  assert.deepEqual(plan.work_items[0]?.reservation, { cpu_millis: 4_000, memory_bytes: 8_192, container_slots: 2, build_slots: 0 });
});

test("task-slot planning emits one schedulable work item per logical trial", () => {
  const plan = buildEvalExecutionPlan({ ...input, tasks: ["two", "one"], workItemMode: "task-slots" });
  assert.equal(plan.work_items.length, 4);
  assert.deepEqual(plan.work_items.map((item) => `${item.task_ids[0]}#${item.logical_attempt}`), ["one#1", "one#2", "two#1", "two#2"]);
  assert.ok(plan.work_items.every((item) => item.slots.length === 1 && item.requested_parallelism === 1));
  assert.deepEqual(plan.work_items[0]?.reservation, input.trialResources);
  assert.deepEqual(parseEvalExecutionPlan(plan), plan);
});

test("execution plan parser rejects slots assigned more than once", () => {
  const plan = buildEvalExecutionPlan({ ...input, tasks: ["one", "two"] });
  const duplicate = structuredClone(plan);
  duplicate.work_items[1]!.slots[0] = duplicate.work_items[0]!.slots[0] as string;
  assert.throws(() => parseEvalExecutionPlan(duplicate), /slots are not assigned exactly once/);
});

test("execution plan parser rejects unknown fields and forged reservations", () => {
  const plan = buildEvalExecutionPlan({ ...input, tasks: ["one", "two"], workItemMode: "task-slots" });
  assert.throws(() => parseEvalExecutionPlan({ ...plan, surprise: true }), /unknown field: surprise/);
  const forged = structuredClone(plan);
  forged.work_items[0]!.reservation.cpu_millis += 1;
  assert.throws(() => parseEvalExecutionPlan(forged), /does not match its slots/);
});
