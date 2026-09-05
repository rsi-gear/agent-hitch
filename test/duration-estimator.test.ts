import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { planTaskSchedulingHints, recordTaskDuration } from "../src/evals/index.js";
import { forceRemove } from "../test-support/helpers.js";

const identity = {
  benchmarkId: "demo",
  benchmarkRevision: "1.0",
  provider: "openai",
  model: "test-model",
};

test("duration estimator learns bounded p75 history and expected retry cost", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-duration-estimator-"));
  t.after(() => forceRemove(root));
  const dataset = path.join(root, "dataset");
  await mkdir(path.join(dataset, "one"), { recursive: true });
  await writeFile(path.join(dataset, "one", ".hitch-benchmark.json"), JSON.stringify({ agent_timeout_sec: 42 }));

  const initial = await planTaskSchedulingHints({
    root,
    dataset,
    taskIds: ["one"],
    ...identity,
    requestTimeoutMs: 90_000,
    infrastructureRetries: 1,
  });
  assert.deepEqual(initial.one, {
    policy: "critical-path-lpt-v1",
    estimated_duration_ms: 42_000,
    remaining_path_ms: 42_000,
    estimate_source: "task-budget",
    estimate_sample_count: 0,
  });

  for (const [durationMs, retryableInfrastructureFailure] of [
    [10_000, false],
    [30_000, false],
    [20_000, true],
    [40_000, false],
  ] as const) {
    await recordTaskDuration({ root, taskId: "one", ...identity, durationMs, retryableInfrastructureFailure });
  }

  const learned = await planTaskSchedulingHints({
    root,
    dataset,
    taskIds: ["one"],
    ...identity,
    requestTimeoutMs: 90_000,
    infrastructureRetries: 1,
  });
  assert.deepEqual(learned.one, {
    policy: "critical-path-lpt-v1",
    estimated_duration_ms: 30_000,
    remaining_path_ms: 37_500,
    estimate_source: "history-p75",
    estimate_sample_count: 4,
  });

  const baseline = await planTaskSchedulingHints({
    root, dataset, taskIds: ["one"], ...identity, requestTimeoutMs: 90_000, infrastructureRetries: 1,
    evolutionBaselineDurations: { one: 55_000 },
  });
  assert.equal(baseline.one?.estimated_duration_ms, 55_000);
  assert.equal(baseline.one?.estimate_source, "evolution-baseline");
  assert.equal(baseline.one?.estimate_sample_count, 1);
});

test("duration estimator rejects unusable samples", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-duration-invalid-"));
  t.after(() => forceRemove(root));
  await assert.rejects(
    recordTaskDuration({ root, taskId: "one", ...identity, durationMs: 0, retryableInfrastructureFailure: false }),
    /duration sample is invalid/,
  );
});
