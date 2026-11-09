import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { publicationFixture } from "../test-support/benchmark-publication-fixture.js";
import { atomicWriteJSON, readJSON } from "../src/foundation/index.js";
import { benchmarkVerifierIdentity, listRunOutputArtifacts } from "../src/runs/index.js";
import { buildBenchmarkAdapterManifest } from "../src/evals/benchmark-adapter-manifest.js";
import { verifyBenchmarkExecution, verifyTrialBenchmark } from "../src/evals/benchmark-verification.js";
import { importEvalTrialRun } from "../src/evals/trial-import.js";
import { captureTrialOutputArtifacts } from "../src/evals/output-artifacts.js";
import { identity, parseResourceDataset, ResourceStore, sealResourceTask, selectResources } from "../src/resources/index.js";

async function fixture(t: test.TestContext) {
  const s = await publicationFixture(t);
  const taskId = s.taskIds[0]!, trialId = `${taskId}__1`, trialDirectory = path.join(s.evalDirectory, "harbor/job", trialId);
  const bundle = path.join(trialDirectory, "hitch-run-bundle");
  await writeFile(path.join(s.dataset, taskId, "task.toml"), 'schema_version = "1.4"\nartifacts = [{source="/app/output"}]\n');
  const manifest = await buildBenchmarkAdapterManifest({ dataset: s.dataset, taskIds: s.taskIds, benchmark: s.manifest.benchmark,
    adapter: s.manifest.adapter, scoring: s.manifest.scoring });
  s.benchmarkRevision = manifest.dataset_digest; s.request.benchmark_revision = manifest.dataset_digest;
  const commit = "d".repeat(40);
  s.request.harness_ref = `codex@commit:${commit}`;
  s.resolvedRevision.revision = { type: "commit", commit };
  s.resolvedRevision.selector = { type: "commit", value: commit };
  await atomicWriteJSON(path.join(s.dataset, "benchmark.adapter.json"), manifest);
  await atomicWriteJSON(path.join(s.evalDirectory, "request.json"), s.request);
  const run = await readJSON<Record<string, unknown>>(path.join(bundle, "manifest.json"));
  const context = { ...(run.context as Record<string, unknown>), benchmark_revision: manifest.dataset_digest,
    verifier_identity: benchmarkVerifierIdentity(s.benchmarkId, manifest.dataset_digest) };
  await atomicWriteJSON(path.join(bundle, "manifest.json"), { ...run, context });
  await atomicWriteJSON(path.join(bundle, "resolution.json"), s.resolvedRevision);
  await mkdir(path.join(trialDirectory, "artifacts/app/output"), { recursive: true });
  await writeFile(path.join(trialDirectory, "artifacts/app/output/submission.csv"), "PassengerId,Survived\n892,0\n");
  await writeFile(path.join(trialDirectory, "artifacts/secret.txt"), "not declared in immutable task");
  await atomicWriteJSON(path.join(trialDirectory, "config.json"), { artifacts: ["/secret.txt"] });
  await atomicWriteJSON(path.join(bundle, "output-artifacts/manifest.json"), { forged: true });
  const binding = { ...s, revisionIdentity: s.resolvedRevision.identity };
  const verifiedBenchmark = await verifyBenchmarkExecution(binding);
  assert.ok(verifiedBenchmark);
  return { ...s, manifest, taskId, trialId, trialDirectory, bundle, commit, verifiedBenchmark, binding };
}

test("terminal Harbor import seals only frozen declarations and retains valid zero scores", async t => {
  const s = await fixture(t);
  const trial = { task_name: s.taskId, trial_name: s.trialId, verifier_result: { rewards: { reward: 0, total_score: 0, process_score: 0.5 } } };
  const ref = await importEvalTrialRun(s, trial);
  assert.equal(ref.run_id, `run_${"1".padStart(32, "0")}`);
  assert.ok(ref.run_id);
  assert.equal(ref.observation_status, "valid"); assert.equal(ref.scores?.total_score, 0);
  const outputs = await listRunOutputArtifacts(s.root, ref.run_id);
  assert.equal(outputs.harness_commit, s.commit); assert.equal(outputs.task_digest, s.manifest.tasks[0]?.task_digest);
  const run = await readJSON<{ context: { task_digest: string } }>(path.join(s.root, "runs", ref.run_id, "manifest.json"));
  assert.notEqual(outputs.task_digest, run.context.task_digest);
  assert.deepEqual(outputs.entries.map(entry => entry.path), ["app/output/submission.csv"]);
  await rm(s.trialDirectory, { recursive: true });
  assert.deepEqual(await listRunOutputArtifacts(s.root, ref.run_id), outputs);
});

test("unsafe outputs fail closed without changing the finished trial's score", async t => {
  const s = await fixture(t), output = path.join(s.trialDirectory, "artifacts/app/output/submission.csv");
  await rm(output); await symlink(path.join(s.trialDirectory, "artifacts/secret.txt"), output);
  const ref = await importEvalTrialRun(s, { task_name: s.taskId, trial_name: s.trialId,
    verifier_result: { rewards: { reward: 0, total_score: 0, process_score: 0.5 } } });
  assert.ok(ref.run_id);
  assert.equal(ref.observation_status, "valid"); assert.equal(ref.scores?.total_score, 0);
  await assert.rejects(listRunOutputArtifacts(s.root, ref.run_id), { code: "output_artifacts_corrupt" });
  assert.match(await readFile(path.join(s.root, "runs", ref.run_id, "output-artifacts-status.json"), "utf8"), /unavailable/);
});

test("unsupported remote provider cannot fall back to local Harbor private artifacts", async t => {
  const s = await fixture(t);
  const binding = { ...s.binding, taskId: s.taskId, trialDirectory: s.trialDirectory };
  const receipt = await verifyTrialBenchmark(binding, s.taskId, s.verifiedBenchmark);
  await captureTrialOutputArtifacts({ ...s, runDirectory: s.bundle, runId: `run_${"1".padStart(32, "0")}`, attempt: 1,
    harnessCommit: s.commit, provider: "daytona", verifiedTrialBinding: binding, verifiedTrialBenchmark: receipt });
  assert.deepEqual(await readJSON(path.join(s.bundle, "output-artifacts-status.json")), {
    schema_version: "1", status: "unavailable", code: "output_artifacts_unavailable",
  });
  await assert.rejects(readFile(path.join(s.bundle, "output-artifacts/manifest.json")), { code: "ENOENT" });
});

async function resourceFixture(t: test.TestContext, kind: "dataset" | "selection", descriptor = false) {
  const { verifiedBenchmark: _legacyReceipt, ...s } = await fixture(t);
  const directory = path.join(s.dataset, s.taskId);
  if (descriptor) await atomicWriteJSON(path.join(directory, ".hitch-benchmark.json"), { task: { driver: { kind: "ordinary" } } });
  await atomicWriteJSON(path.join(directory, "resource.lock.json"), {
    protocol: "hitch-resource-lock@1", resources: {}, bindings: [], requiredCapabilities: [],
  });
  const store = new ResourceStore(s.root, { limits: { minFreeBytes: 0 } });
  const task = await sealResourceTask(store, directory, s.taskId, "resource-output-fixture");
  const body = { schema_version: "3", kind: "gear-harbor-benchmark", resource_protocol: "hitch-resource-lock@1",
    execution: { backend: "harbor-role-context@1", resolver: "hitch-resource-resolver@1", platform: "linux/amd64" },
    required_capabilities: [], benchmark: s.manifest.benchmark, adapter: s.manifest.adapter, scoring: s.manifest.scoring, tasks: [task] };
  const manifest = parseResourceDataset({ ...body, dataset_digest: identity("hitch-resource-dataset@3", body) });
  const selection = selectResources(manifest, [s.taskId]);
  const dataset = kind === "dataset" ? s.dataset : path.join(s.root, "selection.json");
  const benchmarkRevision = kind === "dataset" ? manifest.dataset_digest : selection.digest;
  await atomicWriteJSON(kind === "dataset" ? path.join(dataset, "benchmark.adapter.json") : dataset,
    kind === "dataset" ? manifest : selection);
  const request = { ...s.request, dataset, benchmark_revision: benchmarkRevision };
  await atomicWriteJSON(path.join(s.evalDirectory, "request.json"), request);
  const run = await readJSON<Record<string, unknown>>(path.join(s.bundle, "manifest.json"));
  await atomicWriteJSON(path.join(s.bundle, "manifest.json"), { ...run,
    context: { ...(run.context as Record<string, unknown>), benchmark_revision: benchmarkRevision,
      verifier_identity: benchmarkVerifierIdentity(s.benchmarkId, benchmarkRevision) } });
  await rm(directory, { recursive: true }); // Import must use sealed CAS metadata, never a legacy task path.
  return { ...s, dataset, request, benchmarkRevision, task, store };
}

for (const kind of ["dataset", "selection"] as const) test(`resource ${kind} imports a complete run and seals its declared outputs`, async t => {
  const s = await resourceFixture(t, kind, kind === "selection");
  const ref = await importEvalTrialRun(s, { task_name: s.taskId, trial_name: s.trialId,
    verifier_result: { rewards: { reward: 0, total_score: 0, process_score: 0.5 } } });
  assert.equal(ref.run_id, `run_${"1".padStart(32, "0")}`);
  assert.equal(ref.observation_status, "valid"); assert.equal(ref.scores?.total_score, 0);
  const outputs = await listRunOutputArtifacts(s.root, ref.run_id!);
  assert.equal(outputs.task_digest, s.task.task_digest);
  assert.deepEqual(outputs.entries.map(entry => entry.path), ["app/output/submission.csv"]);
});

test("resource selection rejects a corrupt sealed native descriptor instead of publishing scores", async t => {
  const s = await resourceFixture(t, "selection", true);
  const tree = await s.store.objects.readTree(s.task.sourceTree.manifestDigest);
  const descriptor = tree.entries.find(entry => entry.path === ".hitch-benchmark.json");
  assert.ok(descriptor?.kind === "file");
  await writeFile(s.store.objects.objectPath(descriptor.digest), "corrupt");
  const ref = await importEvalTrialRun(s, { task_name: s.taskId, trial_name: s.trialId,
    verifier_result: { rewards: { reward: 0, total_score: 0, process_score: 0.5 } } });
  assert.equal(ref.observation_status, "invalid"); assert.equal(ref.scores, undefined);
  await assert.rejects(listRunOutputArtifacts(s.root, ref.run_id!), { code: "output_artifacts_unavailable" });
});
