/** Model-free replay of the dataset checks in eval admission and trial collection. */
import assert from "node:assert/strict";
import fs, { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadBenchmarkAdapterManifest } from "../src/evals/benchmark-adapter-manifest.js";
import { nativePhaseDescriptor } from "../src/evals/native-phase-evidence.js";
import type { ImportEvalRunOptions } from "../src/evals/trial-import.js";

const { values } = parseArgs({ options: { dataset: { type: "string" }, baseline: { type: "string" }, output: { type: "string" } } });
if (!values.dataset || !values.baseline || !values.output) throw new Error("required: --dataset PATH --baseline PACKAGE_DIRECTORY --output JSON_FILE");
const dataset = path.resolve(values.dataset), baseline = path.resolve(values.baseline);
const oldManifest = await import(pathToFileURL(path.join(baseline, "dist/src/evals/benchmark-adapter-manifest.js")).href) as { loadBenchmarkAdapterManifest: typeof loadBenchmarkAdapterManifest };
const oldNative = await import(pathToFileURL(path.join(baseline, "dist/src/evals/native-phase-evidence.js")).href) as { nativePhaseDescriptor: typeof nativePhaseDescriptor };
const scratch = await mkdtemp(path.join(tmpdir(), "hitch-dataset-replay-"));
const originalRead = fs.readFile;
let reads = 0, bytes = 0;
fs.readFile = (async (...args: unknown[]) => {
  const value = await Reflect.apply(originalRead, fs, args) as Buffer | string;
  if (String(args[0]).startsWith(`${dataset}${path.sep}`)) {
    reads++;
    bytes += typeof value === "string" ? Buffer.byteLength(value) : value.length;
  }
  return value;
}) as typeof fs.readFile;
syncBuiltinESMExports();

async function replay(optimized: boolean) {
  const loader = optimized ? loadBenchmarkAdapterManifest : oldManifest.loadBenchmarkAdapterManifest;
  const native = optimized ? nativePhaseDescriptor : oldNative.nativePhaseDescriptor;
  reads = 0; bytes = 0;
  const start = performance.now();
  const manifest = await loader(dataset);
  if (!manifest || manifest.schema_version !== "1") throw new Error("replay requires a legacy standardized dataset");
  assert.deepEqual(await loader(dataset), manifest); // admission and planning
  const input = { evalDirectory: scratch, request: { dataset }, benchmarkId: manifest.benchmark.id,
    benchmarkRevision: manifest.dataset_digest, ...(optimized ? { datasetVerification: "task" } : {}) } as ImportEvalRunOptions;
  const descriptors = [];
  const collectionStart = performance.now();
  for (const [index, task] of manifest.tasks.entries()) {
    const descriptor = await native(input, task.task_id);
    descriptors.push(descriptor);
    if (!descriptor) assert.deepEqual(await loader(dataset, optimized ? {
      taskId: task.task_id, expectedRevision: manifest.dataset_digest,
    } : undefined), manifest); // score evidence import
    if ((index + 1) % 5 === 0) process.stderr.write(`${optimized ? "optimized" : "baseline"}: ${index + 1}/${manifest.tasks.length} tasks\n`);
  }
  const collectionMs = performance.now() - collectionStart;
  if (optimized) assert.deepEqual(await loader(dataset, { expectedRevision: manifest.dataset_digest }), manifest);
  return { mode: optimized ? "optimized" : "baseline", tasks: manifest.tasks.length,
    dataset_digest: manifest.dataset_digest, wall_ms: performance.now() - start,
    collection_ms: collectionMs, successful_dataset_reads: reads, logical_dataset_bytes: bytes, descriptors };
}

try {
  // Bracket the baseline so the timing comparison is not only a cold/warm pair.
  const before = await replay(true), baselineResult = await replay(false), after = await replay(true);
  assert.equal(before.dataset_digest, baselineResult.dataset_digest);
  assert.equal(after.dataset_digest, baselineResult.dataset_digest);
  assert.deepEqual(before.descriptors, baselineResult.descriptors);
  assert.deepEqual(after.descriptors, baselineResult.descriptors);
  assert.equal(before.logical_dataset_bytes, after.logical_dataset_bytes);
  const result = { dataset, baseline, measured_at: new Date().toISOString(), model_calls: 0,
    note: "Sequential dataset-check replay, not end-to-end evaluation; bytes are logical reads, not physical disk I/O.",
    results: [before, baselineResult, after],
    logical_byte_reduction: 1 - after.logical_dataset_bytes / baselineResult.logical_dataset_bytes };
  await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  fs.readFile = originalRead; syncBuiltinESMExports();
  await rm(scratch, { recursive: true, force: true });
}
