import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
