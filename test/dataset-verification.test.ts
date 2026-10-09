import assert from "node:assert/strict";
import fs, { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { buildBenchmarkAdapterManifest, loadBenchmarkAdapterManifest, persistTrialVerifierDiagnostics, runEval } from "../src/evals/index.js";
import { nativePhaseDescriptor } from "../src/evals/native-phase-evidence.js";
import type { ImportEvalRunOptions } from "../src/evals/trial-import.js";
import { forceRemove, prepareHostHarborArtifactForTest, writeFakeHarbor, writeFakeNpm } from "../test-support/helpers.js";
import { resourceFixture } from "../test-support/resource-fixture.js";
import { selectResources } from "../src/resources/index.js";

async function fixture(t: TestContext, ids = ["alpha", "beta"], benchmark = "arbitrary-suite") {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-dataset-verification-"));
  t.after(() => forceRemove(root));
  const dataset = path.join(root, "dataset");
  for (const id of ids) {
    await mkdir(path.join(dataset, id, "arbitrary", "nested"), { recursive: true });
    await writeFile(path.join(dataset, id, "task.toml"), "# independent fixture\n");
    await writeFile(path.join(dataset, id, "arbitrary", "nested", "input.bin"), Buffer.from([0, 42, 255, id.length]));
  }
  const manifest = await buildBenchmarkAdapterManifest({
    dataset, taskIds: ids,
    benchmark: { id: benchmark, revision: "release-1" },
    adapter: { id: "arbitrary-adapter", revision: "revision-1", output_protocol: "gear-harbor-eval-result-v1" },
    scoring: { total_score: { source_metric: "accuracy", direction: "maximize", range: [0, 1], reducer: "task-macro-mean" } },
  });
  const manifestFile = path.join(dataset, "benchmark.adapter.json");
  await writeFile(manifestFile, JSON.stringify(manifest));
  const verify = (taskId: string) => loadBenchmarkAdapterManifest(dataset, { taskId, expectedRevision: manifest.dataset_digest });
  return { root, dataset, manifest, manifestFile, verify };
}

function trackReads(t: TestContext) {
  const reads: string[] = [];
  const original = fs.readFile;
  t.mock.method(fs, "readFile", (...args: unknown[]) => {
    reads.push(String(args[0]));
    return Reflect.apply(original, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return reads;
}

test("collection reads task payloads linearly across arbitrary dataset sizes", async t => {
  for (const count of [1, 3, 20]) await t.test(`${count} tasks`, async t => {
    const ids = Array.from({ length: count }, (_, i) => `case-${i}`);
    const { dataset, manifest, verify, root } = await fixture(t, ids);
    const reads = trackReads(t);
    assert.deepEqual(await loadBenchmarkAdapterManifest(dataset), manifest);
    for (const taskId of ids) {
      assert.equal(await nativePhaseDescriptor({
        evalDirectory: path.join(root, "eval"), request: { dataset },
        benchmarkId: manifest.benchmark.id, benchmarkRevision: manifest.dataset_digest,
      } as ImportEvalRunOptions, taskId), null);
      assert.deepEqual(await verify(taskId), manifest);
    }
    assert.deepEqual(await loadBenchmarkAdapterManifest(dataset), manifest);
    const payloadReads = reads.filter(file => file.endsWith("task.toml") || file.endsWith("input.bin"));
    assert.equal(payloadReads.length, count * 2 * 3, "admission + one read per collected task + final sweep");
  });
});

test("task-scoped checks reject content, mode, membership and link changes without a metadata cache", async t => {
  const mutations: Array<[string, (task: string) => Promise<unknown>]> = [
    ["content with restored size and mtime", async task => {
      const file = path.join(task, "arbitrary/nested/input.bin"), before = await stat(file);
      await writeFile(file, Buffer.from([9, 8, 7, 6]));
      await utimes(file, before.atime, before.mtime);
    }],
    ["executable bit", task => chmod(path.join(task, "task.toml"), 0o755)],
    ["new file", task => writeFile(path.join(task, "new-file"), "added")],
    ["deleted file", task => rm(path.join(task, "arbitrary/nested/input.bin"))],
    ["renamed file", task => rename(path.join(task, "task.toml"), path.join(task, "renamed.toml"))],
    ["file symlink", async task => {
      await rm(path.join(task, "task.toml"));
      await symlink("arbitrary/nested/input.bin", path.join(task, "task.toml"));
    }],
    ["task symlink", async task => {
      await rename(task, `${task}-original`);
      await symlink(`${task}-original`, task);
    }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async t => {
    const { dataset, verify } = await fixture(t);
    await verify("alpha");
    await mutate(path.join(dataset, "alpha"));
    await assert.rejects(verify("alpha"), /digest mismatch|symlink|not a directory/);
    await assert.rejects(loadBenchmarkAdapterManifest(dataset));
  });
});

test("pinned contracts reject forged or replaced manifests, unknown tasks, and changed task sets", async t => {
  const { dataset, manifest, manifestFile, verify } = await fixture(t);
  await assert.rejects(verify("unknown"), /not in the benchmark/);
  await assert.rejects(verify("../alpha"), /task id is invalid/);
  const forged = structuredClone(manifest);
  forged.scoring.total_score.range = [0, 100];
  await writeFile(manifestFile, JSON.stringify(forged));
  await assert.rejects(verify("alpha"), /dataset digest mismatch/);
  const replaced = await buildBenchmarkAdapterManifest({ ...forged, dataset, taskIds: ["alpha", "beta"] });
  await writeFile(manifestFile, JSON.stringify(replaced));
  await assert.rejects(verify("alpha"), /changed after eval admission/);
  await writeFile(manifestFile, JSON.stringify(manifest));
  await mkdir(path.join(dataset, "extra"));
  await writeFile(path.join(dataset, "extra/task.toml"), "");
  await assert.rejects(verify("alpha"), /task set does not match/);
  await rm(path.join(dataset, "extra"), { recursive: true });
  await rm(path.join(dataset, "beta"), { recursive: true });
  await assert.rejects(verify("alpha"), /task set does not match/);
});

test("concurrent datasets and retries do not share stale validation results", async t => {
  const a = await fixture(t), b = await fixture(t, ["alpha", "beta"], "another-suite");
  await Promise.all([a.verify("alpha"), b.verify("alpha"), a.verify("beta"), b.verify("beta")]);
  const file = path.join(a.dataset, "alpha/arbitrary/nested/input.bin"), original = await readFile(file);
  await writeFile(file, "changed");
  const results = await Promise.allSettled([a.verify("alpha"), b.verify("alpha"), a.verify("beta")]);
  assert.deepEqual(results.map(result => result.status), ["rejected", "fulfilled", "fulfilled"]);
  // A late edit to a task already collected is still caught by the final sweep.
  await assert.rejects(loadBenchmarkAdapterManifest(a.dataset), /task digest mismatch/);
  await writeFile(file, original);
  assert.deepEqual(await a.verify("alpha"), a.manifest);
  assert.deepEqual(await loadBenchmarkAdapterManifest(a.dataset), a.manifest);
});

test("score collection uses the current task and preserves the scoring contract", async t => {
  const { root, dataset, manifest } = await fixture(t);
  const trialDirectory = path.join(root, "trial");
  await mkdir(path.join(trialDirectory, "verifier"), { recursive: true });
  const reads = trackReads(t);
  const input = { dataset, taskId: "alpha", benchmarkRevision: manifest.dataset_digest, trialDirectory,
    runDirectory: path.join(root, "run"), verifierResult: { rewards: { reward: 1, total_score: 1 } } };
  assert.deepEqual((await persistTrialVerifierDiagnostics(input)).scores, { total_score: 1, normalization: "standard" });
  assert.ok(reads.some(file => file.includes("/alpha/")));
  assert.equal(reads.some(file => file.includes("/beta/")), false);
  const outOfRange = await persistTrialVerifierDiagnostics({ ...input, verifierResult: { rewards: { reward: 2, total_score: 2 } } });
  assert.match(outOfRange.issue!, /outside the benchmark range/);
  await writeFile(path.join(dataset, "alpha/task.toml"), "mutated");
  assert.match((await persistTrialVerifierDiagnostics(input)).issue!, /task digest mismatch/);
});

test("exported native phase descriptors verify their own task; standalone callers retain full verification", async t => {
  const { root, dataset, manifest, manifestFile } = await fixture(t);
  const descriptorFile = path.join(dataset, "alpha/.hitch-benchmark.json");
  const descriptor = { task_id: "alpha", task_digest: "source-task-digest", primary_metric: "accuracy",
    score_contract: { total_score: "accuracy" }, metrics: {}, agent_timeout_sec: 60,
    task: { driver: { kind: "tool-server", config: { native_phases: { audit_path: "/audit.jsonl" } } } } };
  await writeFile(descriptorFile, JSON.stringify(descriptor));
  const sealed = await buildBenchmarkAdapterManifest({ ...manifest, dataset, taskIds: ["alpha", "beta"] });
  await writeFile(manifestFile, JSON.stringify(sealed));
  const input = { evalDirectory: path.join(root, "eval"), request: { dataset },
    benchmarkId: sealed.benchmark.id, benchmarkRevision: sealed.dataset_digest } as ImportEvalRunOptions;
  const reads = trackReads(t);
  assert.equal((await nativePhaseDescriptor({ ...input, datasetVerification: "task" }, "alpha"))?.agent_timeout_ms, 60_000);
  assert.equal(reads.some(file => file.includes("/beta/")), false);
  await writeFile(path.join(dataset, "beta/task.toml"), "changed");
  await assert.rejects(nativePhaseDescriptor(input, "alpha"), /task digest mismatch: beta/);
  await writeFile(descriptorFile, JSON.stringify({ ...descriptor, agent_timeout_sec: 120 }));
  await assert.rejects(nativePhaseDescriptor({ ...input, datasetVerification: "task" }, "alpha"), /task digest mismatch: alpha/);
});

test("resource datasets and selections retain their CAS identities and task membership", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-verification-resources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { source, dataset } = await resourceFixture(root);
  assert.deepEqual(await loadBenchmarkAdapterManifest(source, { expectedRevision: dataset.dataset_digest, taskId: "task-1" }), dataset);
  await assert.rejects(loadBenchmarkAdapterManifest(source, { expectedRevision: dataset.dataset_digest, taskId: "missing" }), /not in the benchmark/);
  const selection = selectResources(dataset, ["task-1"]), file = path.join(root, "selection.json");
  await writeFile(file, JSON.stringify(selection));
  assert.equal((await loadBenchmarkAdapterManifest(file, { expectedRevision: selection.digest, taskId: "task-1" }))?.dataset_digest, selection.digest);
  await assert.rejects(loadBenchmarkAdapterManifest(file, { expectedRevision: dataset.dataset_digest, taskId: "task-1" }), /changed after eval admission/);
  await assert.rejects(loadBenchmarkAdapterManifest(file, { expectedRevision: selection.digest, taskId: "task-0" }), /not in the benchmark/);
});

test("eval collection is bounded and finalization catches late changes and removed manifests", async t => {
  for (const change of ["none", "payload", "manifest"] as const) await t.test(change, async t => {
    const { root, dataset, manifestFile } = await fixture(t, ["one", "two"]);
    const harbor = await writeFakeHarbor(root), npm = await writeFakeNpm(root);
    const reads = trackReads(t);
    let finalized = false;
    const result = await runEval({
      root, harborExecutable: harbor, harborArtifactBuilder: prepareHostHarborArtifactForTest,
      env: { ...process.env, HITCH_NPM_PATH: npm },
      request: { dataset, harness_ref: "pi@version:1.2.3", model: "openai/test-model", infrastructure_retries: 0 },
      onControlPhase: async phase => {
        if (phase !== "finalizing") return;
        finalized = true;
        if (change === "payload") await writeFile(path.join(dataset, "one/arbitrary/nested/input.bin"), "late edit");
        if (change === "manifest") await rm(manifestFile);
      },
    });
    assert.equal(finalized, true, JSON.stringify(result.error));
    if (change === "none") {
      assert.notEqual(result.failure_stage, "finalizing");
      assert.equal(reads.filter(file => file.endsWith("input.bin")).length, 8, "two admission scans, per-task imports, one final scan");
    } else {
      assert.equal(result.status, "failed");
      assert.equal(result.failure_stage, "finalizing");
      assert.match(result.error!.message, change === "payload" ? /task digest mismatch/ : /manifest disappeared/);
    }
  });
});
