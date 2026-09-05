import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBenchmarkAdapterManifest, persistTrialVerifierDiagnostics, resolveBenchmarkReference, scoreWithinRange } from "../src/evals/index.js";
import { forceRemove } from "../test-support/helpers.js";

test("standard benchmark manifests bind identity, task trees, and score availability", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-benchmark-adapter-"));
  t.after(() => forceRemove(root));
  const task = path.join(root, "task-one");
  await mkdir(task);
  await writeFile(path.join(task, "task.toml"), 'schema_version = "1.4"\n');
  await writeFile(path.join(task, "instruction.md"), "Do the task.\n");
  const taskDigest = await treeDigest(task);
  const body = {
    schema_version: "1",
    kind: "gear-harbor-benchmark",
    benchmark: { id: "example-bench", revision: "commit:1234" },
    adapter: { id: "example-adapter", revision: `sha256:${"a".repeat(64)}`, output_protocol: "gear-harbor-eval-result-v1" },
    scoring: {
      total_score: { source_metric: "success", direction: "maximize", range: [0, 1], reducer: "task-macro-mean" },
    },
    tasks: [{ task_id: "task-one", task_digest: taskDigest }],
  };
  const datasetDigest = sha256(canonicalJson(body));
  await writeFile(path.join(root, "benchmark.adapter.json"), `${JSON.stringify({ ...body, dataset_digest: datasetDigest }, null, 2)}\n`);

  const manifest = await loadBenchmarkAdapterManifest(root);
  assert.equal(manifest?.dataset_digest, datasetDigest);
  assert.equal(manifest?.scoring.process_score, undefined);
  assert.deepEqual(await resolveBenchmarkReference(root), { benchmark_id: "example-bench", benchmark_revision: datasetDigest });
  assert.equal(scoreWithinRange(1, manifest!.scoring.total_score), true);
  assert.equal(scoreWithinRange(1.1, manifest!.scoring.total_score), false);

  const trialDirectory = path.join(root, "trial");
  await mkdir(path.join(trialDirectory, "verifier"), { recursive: true });
  const valid = await persistTrialVerifierDiagnostics({
    trialDirectory,
    runDirectory: path.join(root, "run-valid"),
    verifierResult: { rewards: { reward: 1, total_score: 1 } },
    dataset: root,
    benchmarkRevision: datasetDigest,
  });
  assert.deepEqual(valid.scores, { total_score: 1, normalization: "standard" });
  const outOfRange = await persistTrialVerifierDiagnostics({
    trialDirectory,
    runDirectory: path.join(root, "run-invalid"),
    verifierResult: { rewards: { reward: 2, total_score: 2 } },
    dataset: root,
    benchmarkRevision: datasetDigest,
  });
  assert.match(outOfRange.issue ?? "", /outside the benchmark range/);

  await writeFile(path.join(task, "instruction.md"), "Mutated.\n");
  await assert.rejects(loadBenchmarkAdapterManifest(root), /task digest mismatch/);
});

async function treeDigest(root: string): Promise<string> {
  const rows: Array<{ path: string; mode: "file" | "executable"; sha256: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) await visit(absolute);
      else {
        const info = await lstat(absolute);
        rows.push({ path: relative, mode: info.mode & 0o111 ? "executable" : "file", sha256: createHash("sha256").update(await readFile(absolute)).digest("hex") });
      }
    }
  };
  await visit(root);
  return sha256(JSON.stringify(rows));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
