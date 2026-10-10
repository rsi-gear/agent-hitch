import test from "node:test";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { link, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJSON } from "../src/foundation/index.js";
import { loadBenchmarkAdapterManifest } from "../src/evals/benchmark-adapter-manifest.js";
import { verifyBenchmarkExecution, verifyTrialBenchmark, verifiedTrialManifest } from "../src/evals/benchmark-verification.js";
import type { VerifiedBenchmarkExecution } from "../src/evals/benchmark-verification.js";
import { nativePhaseDescriptor } from "../src/evals/native-phase-evidence.js";
import { captureVerifierScoreEvidence } from "../src/evals/verifier-score-artifacts.js";
import { importEvalTrialRun, validateEvalTrialReferences } from "../src/evals/trial-import.js";
import { readEvalProgress } from "../src/evals/progress.js";
import { persistTerminalEvalResult } from "../src/evals/eval-state.js";
import { publicationFixture, publicationTimestamp } from "../test-support/benchmark-publication-fixture.js";

for (const concurrency of [1, 4, 20]) test(`verified standard imports publish real evidence at concurrency ${concurrency} with one task scan per slot`, async t => {
  const s = await publicationFixture(t, concurrency);
  const reads: Array<{ root: string; path: string; bytes: number }> = [];
  const observer = (message: unknown) => {
    const value = message as typeof reads[number];
    if (value.root.startsWith(s.dataset + path.sep)) reads.push(value);
  };
  const diagnostics = channel("hitch.benchmark.task-content-read"); diagnostics.subscribe(observer);
  t.after(() => diagnostics.unsubscribe(observer));
  const receipt = await verifyBenchmarkExecution(s.binding); assert.ok(receipt);
  assert.equal(reads.length, 3 * concurrency, "admission verifies every task in full");
  const admissionBytes = reads.reduce((sum, read) => sum + read.bytes, 0);
  assert.ok(admissionBytes > 0);
  reads.length = 0;
  const refs = await Promise.all(s.taskIds.map(async (_, index) => {
    const ref = await s.importTask(index, receipt); await s.publisher.publish(ref, `fixture-${index}`); return ref;
  }));
  await s.publisher.settle();
  assert.equal(reads.length, 3 * concurrency, "native descriptor and score capture share the same verified task scan");
  assert.equal(reads.reduce((sum, read) => sum + read.bytes, 0), admissionBytes, "publication hashes each admitted content byte once");
  for (const taskId of s.taskIds) assert.equal(reads.filter(value => path.basename(value.root) === taskId).length, 3);
  assert.deepEqual(refs.map(ref => ref.task_id), s.taskIds);
  assert.ok(refs.every(ref => ref.observation_status === "valid"));
  assert.deepEqual(refs[0]!.scores, { total_score: 0, process_score: 0.5, normalization: "standard" });
  await validateEvalTrialReferences(s.root, s.evalId, refs, s);
  const published = s.events.filter(event => event.type === "eval.trial.published"); assert.equal(published.length, concurrency);
  await s.publisher.publish(refs[0]!, "duplicate");
  assert.equal(s.events.filter(event => event.type === "eval.trial.published").length, concurrency);
  await s.publisher.close();
  const result = await persistTerminalEvalResult(s.evalDirectory, { schema_version: "1", eval_id: s.evalId,
    benchmark_id: s.benchmarkId, benchmark_revision: s.benchmarkRevision, status: "succeeded", exit_code: 0,
    trials: [], started_at: publicationTimestamp, completed_at: publicationTimestamp });
  const progress = await readEvalProgress(s.evalDirectory);
  assert.equal(progress?.status, "succeeded"); assert.deepEqual(progress?.trials, result.trials);
  assert.equal(progress?.generation, concurrency);
  for (const ref of refs) {
    assert.ok((await readFile(path.join(s.root, "runs", ref.run_id!, "trajectory.ref.json"), "utf8")).includes("fixture-native-session"));
    assert.ok((await readFile(path.join(s.root, "runs", ref.run_id!, "bundle.index.json"), "utf8")).includes("bundle_digest"));
  }
});

const mutations: Array<[string, (s: Awaited<ReturnType<typeof publicationFixture>>) => Promise<unknown>]> = [
  ["selected contents", s => writeFile(path.join(s.dataset, s.taskIds[0]!, "data.txt"), "changed")],
  ["manifest", s => atomicWriteJSON(path.join(s.dataset, "benchmark.adapter.json"), { ...s.manifest, benchmark: { ...s.manifest.benchmark, id: "changed" } })],
  ["added task membership", async s => { await mkdir(path.join(s.dataset, "extra")); await writeFile(path.join(s.dataset, "extra/task.toml"), "schema_version='1.4'"); }],
  ["removed task membership", s => rm(path.join(s.dataset, s.taskIds[1]!), { recursive: true })],
  ["task symlink", async s => { const target = path.join(s.root, "moved-task"); await rename(path.join(s.dataset, s.taskIds[0]!), target); await symlink(target, path.join(s.dataset, s.taskIds[0]!)); }],
  ["file symlink", async s => { const file = path.join(s.dataset, s.taskIds[0]!, "data.txt"); await rm(file); await symlink(path.join(s.dataset, s.taskIds[1]!, "data.txt"), file); }],
];
for (const [name, mutate] of mutations) test(`verified import rejects changed ${name} without publishing valid scores`, async t => {
  const s = await publicationFixture(t, 2), receipt = await verifyBenchmarkExecution(s.binding); assert.ok(receipt);
  await mutate(s);
  const ref = await s.importTask(0, receipt);
  assert.equal(ref.observation_status, "invalid"); assert.equal(ref.scores, undefined);
  const diagnostic = JSON.parse(await readFile(path.join(s.evalDirectory, "harbor/job", `${s.taskIds[0]}__1`, "hitch-run-import-error.json"), "utf8"));
  assert.match(diagnostic.message, /manifest|symlink|task|benchmark/);
});

test("new full admission still rejects mutation of an unselected task", async t => {
  const s = await publicationFixture(t, 2); assert.ok(await verifyBenchmarkExecution(s.binding));
  await writeFile(path.join(s.dataset, s.taskIds[1]!, "data.txt"), "changed other task");
  await assert.rejects(verifyBenchmarkExecution(s.binding), /task digest mismatch/);
});

test("execution receipt binds frozen digest, request, candidate, eval, and dataset", async t => {
  const s = await publicationFixture(t, 2), receipt = await verifyBenchmarkExecution(s.binding); assert.ok(receipt);
  const trialDirectory = path.join(s.evalDirectory, "harbor/job", `${s.taskIds[0]}__1`);
  for (const change of [{ evalId: `eval_${"f".repeat(32)}` }, { revisionIdentity: `sha256:${"b".repeat(64)}` },
    { request: { ...s.request, model: "other" } }, { request: { ...s.request, dataset: path.join(s.root, "other") } }]) {
    await assert.rejects(verifyTrialBenchmark({ ...s.binding, ...change, trialDirectory }, s.taskIds[0]!, receipt), /receipt identity/);
  }
  await assert.rejects(verifyTrialBenchmark({ ...s.binding, trialDirectory }, s.taskIds[0]!, {} as VerifiedBenchmarkExecution), /receipt identity/);
  await atomicWriteJSON(path.join(s.evalDirectory, "request.json"), { ...s.request, model: "mutated" });
  await assert.rejects(verifyTrialBenchmark({ ...s.binding, trialDirectory }, s.taskIds[0]!, receipt), /request changed/);
  await atomicWriteJSON(path.join(s.evalDirectory, "request.json"), s.request);
  await assert.rejects(verifyBenchmarkExecution({ ...s.binding, request: { ...s.request, benchmark_revision: "different" } }), /frozen eval request/);
});

test("trial receipt consumers reject reuse across task or eval before native and score early returns", async t => {
  const s = await publicationFixture(t, 2), execution = await verifyBenchmarkExecution(s.binding); assert.ok(execution);
  const binding = { ...s.binding, taskId: s.taskIds[0]!, trialDirectory: path.join(s.evalDirectory, "harbor/job", `${s.taskIds[0]}__1`) };
  const receipt = await verifyTrialBenchmark(binding, binding.taskId, execution);
  await assert.rejects(nativePhaseDescriptor({ ...s, verifiedTrialBenchmark: receipt, verifiedTrialBinding: binding }, s.taskIds[1]!), /receipt identity/);
  await assert.rejects(verifiedTrialManifest(receipt, { ...binding, evalId: `eval_${"f".repeat(32)}` }), /receipt identity/);
  const captured = await captureVerifierScoreEvidence({ trialDirectory: binding.trialDirectory, runDirectory: path.join(s.root, "score-copy"),
    verifierResult: { rewards: { reward: 0 } }, dataset: s.dataset, benchmarkRevision: s.benchmarkRevision,
    verifiedTrialBenchmark: receipt, verifiedTrialBinding: { ...binding, taskId: s.taskIds[1]! } });
  assert.match(captured.issue ?? "", /receipt identity/); assert.equal(captured.scores, undefined);
});

test("legacy receipt cannot opt out of standard validation at another dataset or after manifest introduction", async t => {
  const legacy = await publicationFixture(t, 1, false), standard = await publicationFixture(t, 1);
  const binding = { ...legacy.binding, taskId: legacy.taskIds[0]!, trialDirectory: path.join(legacy.evalDirectory, "harbor/job", `${legacy.taskIds[0]}__1`) };
  const receipt = await verifyTrialBenchmark(binding, binding.taskId);
  assert.equal(await verifiedTrialManifest(receipt, binding), null);
  const captured = await captureVerifierScoreEvidence({ trialDirectory: binding.trialDirectory, runDirectory: path.join(legacy.root, "score-copy"),
    verifierResult: { rewards: { reward: 0 } }, dataset: standard.dataset, benchmarkRevision: standard.benchmarkRevision,
    verifiedTrialBenchmark: receipt, verifiedTrialBinding: binding });
  assert.match(captured.issue ?? "", /consumer identity/); assert.equal(captured.scores, undefined);
  await atomicWriteJSON(path.join(legacy.dataset, "benchmark.adapter.json"), legacy.manifest);
  await assert.rejects(verifiedTrialManifest(receipt, binding), /manifest changed during/);
});

test("legacy imports and ordinary dataset hardlinks retain supported behavior", async t => {
  const legacy = await publicationFixture(t, 1, false);
  assert.equal(await verifyBenchmarkExecution(legacy.binding), null);
  const ref = await legacy.importTask(0); assert.equal(ref.observation_status, "valid");
  assert.equal(ref.reward, 0); assert.equal(ref.scores, undefined, "legacy trial references keep their existing reward-only shape");
  const standard = await publicationFixture(t, 1);
  await link(path.join(standard.dataset, standard.taskIds[0]!, "data.txt"), path.join(standard.root, "data-alias"));
  assert.equal((await loadBenchmarkAdapterManifest(standard.dataset))?.dataset_digest, standard.benchmarkRevision);
});

test("task mutation during hashing fails closed instead of minting a partial snapshot", async t => {
  const s = await publicationFixture(t, 1), receipt = await verifyBenchmarkExecution(s.binding); assert.ok(receipt);
  const diagnostics = channel("hitch.benchmark.task-content-read");
  let changed = false;
  const observer = (message: unknown) => {
    const value = message as { root: string; path: string };
    if (value.root === path.join(s.dataset, s.taskIds[0]!) && value.path === "data.txt") { writeFileSync(path.join(value.root, "data.txt"), "raced"); changed = true; }
  };
  diagnostics.subscribe(observer); t.after(() => diagnostics.unsubscribe(observer));
  const ref = await s.importTask(0, receipt); assert.equal(changed, true);
  assert.equal(ref.observation_status, "invalid"); assert.equal(ref.scores, undefined);
});

test("scoped missing-bundle collection retains a canonical invalid diagnostic instead of inventing a valid zero", async t => {
  const s = await publicationFixture(t), receipt = await verifyBenchmarkExecution(s.binding); assert.ok(receipt);
  await rm(path.join(s.evalDirectory, "harbor/job", `${s.taskIds[0]}__1`, "hitch-run-bundle"), { recursive: true });
  const ref = await importEvalTrialRun({ ...s, verifiedBenchmark: receipt, requireCompleteMarker: true, allowMissingBundleDiagnostic: true }, {
    task_name: s.taskIds[0], trial_name: `${s.taskIds[0]}__1`, verifier_result: { rewards: { reward: 0, total_score: 0, process_score: 0.5 } },
  });
  assert.equal(ref.task_id, s.taskIds[0]); assert.equal(ref.observation_status, "invalid"); assert.equal(ref.scores, undefined);
  assert.ok(ref.run_id); await validateEvalTrialReferences(s.root, s.evalId, [ref], s);
});

test("an unknown task cannot request scoped content verification", async t => {
  const s = await publicationFixture(t), execution = await verifyBenchmarkExecution(s.binding); assert.ok(execution);
  await assert.rejects(verifyTrialBenchmark({ ...s.binding, trialDirectory: path.join(s.evalDirectory, "harbor/job/unknown__1") }, "unknown", execution), /absent from the admitted/);
});

for (const kind of ["dataset", "selection"] as const) test(`resource ${kind} keeps its full fallback and standard zero score contract`, async t => {
  const s = await publicationFixture(t, 1, false);
  const fixture = JSON.parse(await readFile("test-contracts/hitch-resources-v1.json", "utf8"));
  const dataset = path.join(s.root, `resource-${kind}`);
  if (kind === "dataset") { await mkdir(dataset); await atomicWriteJSON(path.join(dataset, "benchmark.adapter.json"), fixture.dataset); }
  else await atomicWriteJSON(dataset, fixture.selection);
  const manifest = await loadBenchmarkAdapterManifest(dataset); assert.ok(manifest); assert.equal(manifest.schema_version, "2");
  const request = { ...s.request, dataset, benchmark_id: manifest.benchmark.id, benchmark_revision: manifest.dataset_digest };
  await atomicWriteJSON(path.join(s.evalDirectory, "request.json"), request);
  const binding = { ...s.binding, request, benchmarkId: manifest.benchmark.id, benchmarkRevision: manifest.dataset_digest,
    taskId: "case-1", trialDirectory: path.join(s.evalDirectory, "harbor/job", `${s.taskIds[0]}__1`) };
  assert.equal(await verifyBenchmarkExecution(binding), null, "resource input cannot mint a local directory optimization receipt");
  const receipt = await verifyTrialBenchmark(binding, binding.taskId);
  assert.deepEqual(await verifiedTrialManifest(receipt, binding), manifest);
  const captured = await captureVerifierScoreEvidence({ trialDirectory: binding.trialDirectory, runDirectory: path.join(s.root, "resource-score"),
    verifierResult: { rewards: { reward: 0, total_score: 0 } }, dataset, benchmarkRevision: binding.benchmarkRevision,
    verifiedTrialBenchmark: receipt, verifiedTrialBinding: binding });
  assert.equal(captured.issue, undefined); assert.deepEqual(captured.scores, { total_score: 0, normalization: "standard" });
  const invalid = await captureVerifierScoreEvidence({ trialDirectory: binding.trialDirectory, runDirectory: path.join(s.root, "resource-invalid"),
    verifierResult: { rewards: { reward: 0 } }, dataset, benchmarkRevision: binding.benchmarkRevision,
    verifiedTrialBenchmark: receipt, verifiedTrialBinding: binding });
  assert.match(invalid.issue ?? "", /requires total_score/); assert.equal(invalid.scores, undefined);
});
