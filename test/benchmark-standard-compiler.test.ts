import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportStandardBenchmarkDataset, loadBenchmarkAdapterManifest, resolveBenchmarkReference } from "../src/evals/index.js";
import { writeBenchmarkFixture } from "../test-support/benchmark-fixture.js";

test("every Package v1 benchmark compiles to one total-only standard Harbor dataset", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-standard-compiler-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const output = path.join(root, "dataset");
  await writeBenchmarkFixture(source);

  const result = await exportStandardBenchmarkDataset(source, output);
  const manifest = await loadBenchmarkAdapterManifest(output);
  assert.ok(manifest);
  assert.deepEqual(result, {
    dataset: output,
    benchmark_id: "local-counter",
    benchmark_revision: manifest.dataset_digest,
    source_package_digest: manifest.benchmark.revision,
    tasks: ["add-seven"],
    scoring: manifest.scoring,
  });
  assert.deepEqual(manifest.scoring, {
    total_score: {
      source_metric: "target_reached",
      direction: "maximize",
      range: [0, 1],
      reducer: "task-macro-mean",
    },
  });
  assert.deepEqual(await resolveBenchmarkReference(output), {
    benchmark_id: "local-counter",
    benchmark_revision: manifest.dataset_digest,
  });
  const descriptor = JSON.parse(await readFile(path.join(output, "add-seven", ".hitch-benchmark.json"), "utf8"));
  assert.deepEqual(descriptor.score_contract, { total_score: "target_reached" });

  await assert.rejects(exportStandardBenchmarkDataset(source, output), /exist/i);
  await writeFile(path.join(output, "add-seven", "instruction.md"), "changed\n");
  await assert.rejects(loadBenchmarkAdapterManifest(output), /task digest mismatch/);
});

test("compiled datasets accept task names whose locale and code-unit orders differ", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-standard-membership-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await writeBenchmarkFixture(source, { benchmark: "mixed-membership", task: "a-b", tool: "accumulate", metric: "target_reached" });
  const ids = ["a-b", "a_b", "Z", "zeta"];
  for (const id of ids.slice(1)) {
    const task = path.join(source, "tasks", id);
    await cp(path.join(source, "tasks", "a-b"), task, { recursive: true });
    const config = JSON.parse(await readFile(path.join(task, "task.hitch.json"), "utf8"));
    await writeFile(path.join(task, "task.hitch.json"), JSON.stringify({ ...config, source_task_id: id }));
  }
  const packageManifest = path.join(source, "benchmark.toml");
  await writeFile(packageManifest, (await readFile(packageManifest, "utf8")).replace('task_ids = ["a-b"]', `task_ids = ${JSON.stringify(ids)}`));
  const output = path.join(root, "dataset");
  const result = await exportStandardBenchmarkDataset(source, output);
  assert.deepEqual(result.tasks, [...ids].sort());
  assert.deepEqual((await loadBenchmarkAdapterManifest(output))!.tasks.map(task => task.task_id), [...ids].sort());
  await rm(path.join(output, "a_b"), { recursive: true });
  await assert.rejects(loadBenchmarkAdapterManifest(output), /manifest task is missing: a_b/);
});
