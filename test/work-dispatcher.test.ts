import test from "node:test";
import assert from "node:assert/strict";
import { WorkItemDispatcher, ResourceLedger, evalTaskCollisionKey } from "../src/control-plane/index.js";
import type { EvalRequest } from "../src/domain/index.js";
import { delay } from "../src/foundation/index.js";

const UNIT = { cpu_millis: 1_000, memory_bytes: 1024, container_slots: 1, build_slots: 0 };
const CAPACITY = { cpu_millis: 2_000, memory_bytes: 2048, container_slots: 2, build_slots: 1 };
const EVAL_A = "eval_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EVAL_B = "eval_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("work-item DRR admits a newly queued eval before returning a released slot to the last eval", async () => {
  const resources = new ResourceLedger(CAPACITY);
  const dispatcher = new WorkItemDispatcher({ resources });
  const first = await dispatcher.acquire(work(EVAL_A, "1", "task:a", 2));
  const second = await dispatcher.acquire(work(EVAL_A, "2", "task:b", 2));
  const thirdPromise = dispatcher.acquire(work(EVAL_A, "3", "task:c", 2));
  const smallPromise = dispatcher.acquire(work(EVAL_B, "4", "task:d", 1));
  await delay(5);
  assert.equal(dispatcher.snapshot().active, 2);
  assert.equal(dispatcher.snapshot().queued, 2);

  first.release();
  const winner = await Promise.race([
    thirdPromise.then(() => "large"),
    smallPromise.then(() => "small"),
  ]);
  assert.equal(winner, "small");
  const small = await smallPromise;
  assert.equal(resources.snapshot().allocated.container_slots, 2);

  small.release();
  const third = await thirdPromise;
  second.release();
  third.release();
  assert.deepEqual(resources.snapshot().allocated, { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 });
  dispatcher.close();
});

test("work-item dispatch enforces per-eval parallelism and cross-eval task collision keys", async () => {
  const dispatcher = new WorkItemDispatcher({ resources: new ResourceLedger(CAPACITY) });
  const first = await dispatcher.acquire(work(EVAL_A, "5", "shared-task", 1));
  const sameEvalPromise = dispatcher.acquire(work(EVAL_A, "6", "other-task", 1));
  const collidingPromise = dispatcher.acquire(work(EVAL_B, "7", "shared-task", 2));
  const independent = await dispatcher.acquire(work(EVAL_B, "8", "independent-task", 2));
  await delay(5);
  assert.equal(dispatcher.evalSnapshot(EVAL_A)?.active, 1);
  assert.equal(dispatcher.snapshot().active, 2);

  independent.release();
  first.release();
  const colliding = await collidingPromise;
  const sameEval = await sameEvalPromise;
  assert.notEqual(colliding.allocation.allocation_id, sameEval.allocation.allocation_id);
  colliding.release();
  sameEval.release();
  dispatcher.close();
});

test("work-item dispatch rejects a vector that can never fit", async () => {
  const dispatcher = new WorkItemDispatcher({ resources: new ResourceLedger(CAPACITY) });
  await assert.rejects(
    dispatcher.acquire({
      ...work(EVAL_A, "9", "too-large", 1),
      reservation: { ...UNIT, memory_bytes: 4096 },
    }),
    (error: unknown) => (error as { code?: string }).code === "resource_request_unsatisfiable",
  );
  dispatcher.close();
});

test("work-item identity and collision-domain keys fence duplicate or conflicting execution", async () => {
  const dispatcher = new WorkItemDispatcher({ resources: new ResourceLedger(CAPACITY) });
  const request = work(EVAL_A, "a", "task", 1);
  const permit = await dispatcher.acquire(request);
  await assert.rejects(
    dispatcher.acquire(request),
    (error: unknown) => (error as { code?: string }).code === "work_item_already_scheduled",
  );
  permit.release();

  const evalRequest = { backend: "harbor", benchmark_id: "demo", benchmark_revision: "1.0" } as EvalRequest;
  const key = evalTaskCollisionKey(evalRequest, "task-a", "docker:one");
  assert.equal(key, evalTaskCollisionKey(evalRequest, "task-a", "docker:one"));
  assert.notEqual(key, evalTaskCollisionKey(evalRequest, "task-b", "docker:one"));
  assert.notEqual(key, evalTaskCollisionKey(evalRequest, "task-a", "docker:two"));
  dispatcher.close();
});

function work(evalId: string, suffix: string, collisionKey: string, maxParallelism: number) {
  return {
    evalId,
    workId: `work_${suffix.repeat(32)}`,
    maxParallelism,
    reservation: UNIT,
    collisionKeys: [collisionKey],
  };
}
