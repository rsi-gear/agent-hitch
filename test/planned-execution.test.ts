import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResourceLedger, WorkItemDispatcher } from "../src/control-plane/index.js";
import { parseEvalExecutionPlan, readExecutionLeases, runEval } from "../src/evals/index.js";
import { readJSON } from "../src/foundation/index.js";
import { forceRemove, writeFakeHarbor, writeFakeNpm } from "../test-support/helpers.js";

test("planned local execution overlaps different tasks and serializes attempts of the same task", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-planned-execution-"));
  t.after(() => forceRemove(root));
  const dataset = path.join(root, "dataset");
  for (const task of ["one", "two"]) {
    const directory = path.join(dataset, task);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "task.toml"), `name = ${JSON.stringify(task)}\n`);
  }
  const activityLog = path.join(root, "harbor-activity.jsonl");
  const harbor = await writeFakeHarbor(root, { delayMs: 150, activityLog });
  const npm = await writeFakeNpm(root);
  const resources = new ResourceLedger({ cpu_millis: 2_000, memory_bytes: 2 * 1024 * 1024 * 1024, container_slots: 2, build_slots: 1 });
  const dispatcher = new WorkItemDispatcher({ resources });
  t.after(() => dispatcher.close());
  const result = await runEval({
    root,
    harborExecutable: harbor,
    executionStrategy: "local-task-slots-v1",
    trialBundleGraceMs: 0,
    env: { ...process.env, HITCH_NPM_PATH: npm },
    workItemAdmission: {
      acquire: async ({ evalId, workItem, maxParallelism, signal }) => {
        const permit = await dispatcher.acquire({
          evalId,
          workId: workItem.work_id,
          maxParallelism,
          reservation: workItem.reservation,
          collisionKeys: workItem.task_ids.map((taskId) => `test-task:${taskId}`),
          ...(signal ? { signal } : {}),
        });
        return { allocationId: permit.allocation.allocation_id, collisionKeys: permit.collision_keys, release: permit.release };
      },
    },
    request: {
      dataset,
      harness_ref: "pi@version:1.2.3",
      attempts: 2,
      max_concurrent: 2,
      infrastructure_retries: 0,
    },
  });

  assert.equal((result.trials as unknown[]).length, 4);
  const evalDirectory = path.join(root, "evals", result.eval_id);
  const compatibilityPlan = await readJSON<Record<string, unknown>>(path.join(evalDirectory, "plan.json"));
  assert.equal(compatibilityPlan.attempt_execution, "harbor-task-slots-v1");
  const plan = parseEvalExecutionPlan(await readJSON<unknown>(path.join(evalDirectory, "execution-plan.json")));
  assert.equal(plan.membership, "known");
  assert.equal(plan.work_items.length, 4);
  const leases = await readExecutionLeases(evalDirectory);
  assert.equal(leases.length, 4);
  assert.ok(leases.every((lease) => lease.state === "released" && lease.terminal_at && lease.parent_allocation_id));
  assert.deepEqual(new Set(leases.map((lease) => lease.work_id)), new Set(plan.work_items.map((item) => item.work_id)));
  for (const item of plan.work_items) {
    const config = await readJSON<Record<string, unknown>>(path.join(evalDirectory, "harbor", "work-items", item.work_id, "job.json"));
    const datasets = config.datasets as Array<Record<string, unknown>>;
    assert.equal(config.n_attempts, 1);
    assert.equal(config.n_concurrent_trials, 1);
    assert.deepEqual(datasets[0]?.task_names, item.task_ids);
  }

  const activity = (await readFile(activityLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Activity);
  for (const task of ["one", "two"]) {
    const firstEnd = event(activity, "end", task, 1).time;
    const secondStart = event(activity, "start", task, 2).time;
    assert.ok(secondStart >= firstEnd, `${task} attempt 2 started before attempt 1 completed`);
  }
  const firstStarts = [event(activity, "start", "one", 1).time, event(activity, "start", "two", 1).time];
  const firstEnds = [event(activity, "end", "one", 1).time, event(activity, "end", "two", 1).time];
  assert.ok(Math.max(...firstStarts) < Math.min(...firstEnds), "different tasks did not overlap");
  assert.deepEqual(resources.snapshot().allocated, { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 });
});

interface Activity {
  type: "start" | "end";
  time: number;
  logicalAttempt: number;
  tasks: string[];
}

function event(activity: Activity[], type: Activity["type"], task: string, attempt: number): Activity {
  const found = activity.find((entry) => entry.type === type && entry.logicalAttempt === attempt && entry.tasks.includes(task));
  assert.ok(found, `missing ${type} for ${task}#${attempt}`);
  return found;
}
