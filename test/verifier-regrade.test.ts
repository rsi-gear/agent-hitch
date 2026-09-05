import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildHarborRegradeConfig, seedHarborRegradeTrial } from "../src/backends/index.js";
import { readRegradeObservation, regradeTreeDigest, sealRegradeAssessment } from "../src/evals/regrade-evidence.js";
import { parseEvalTrialRef } from "../src/evals/progress.js";
import { writeResultBundleIndex } from "../src/runs/index.js";
import { atomicWriteJSON, sha256Bytes, sha256JSON } from "../src/foundation/index.js";
import { benchmarkTreeDigest } from "../src/benchmarks/index.js";
import { frozenRerunBenchmark } from "../src/evals/verifier-only-rerun.js";

test("artifact regrade preserves candidate, budgets and verifier and refuses a replacement candidate", () => {
  const original = { task: { path: "/task" }, trial_name: "original", timeout_multiplier: 1,
    agent: { import_path: "hitch_harbor_agent:HitchHarborAgent", model_name: "frozen", kwargs: { logical_attempt: 2 } },
    verifier: { override_timeout_sec: 900, kwargs: { infrastructure_retries: 0 } },
    environment: { import_path: "hitch_harbor_environment:HitchHarborDockerEnvironment", override_cpus: 4, override_memory_mb: 8192, kwargs: { hitch_resolved_images: { image: "image@sha256:abc" } } },
    artifacts: ["/tmp/agent.patch"] };
  const before = structuredClone(original);
  const input = { sourceConfig: original, sourceResult: { id: "01234567-0123-4567-8123-012345678901" }, sourceDirectory: "/source", outputDirectory: "/output", trialName: "regraded", ownershipLabels: { lease: "new" } };
  const config = buildHarborRegradeConfig(input);
  assert.deepEqual(original, before);
  for (const key of ["agent", "verifier", "artifacts", "task", "timeout_multiplier"] as const) assert.deepEqual(config[key], original[key]);
  assert.deepEqual(config.source_trial, { action: "regrade", type: "local", trial_id: input.sourceResult.id, path: "/source" });
  assert.equal((config.environment as Record<string, unknown>).override_cpus, 4);
  assert.throws(() => buildHarborRegradeConfig({ ...input, sourceConfig: { ...original, agent: { name: "nop" } } }), /original managed Hitch/);
  assert.throws(() => buildHarborRegradeConfig({ ...input, sourceConfig: { ...original, source_trial: { action: "regrade" } } }), /original managed Hitch/);
});

test("regrade inventories capture empty directories and reject linked or changed inputs", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-regrade-tree-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "agent.patch"), "original");
  const before = await regradeTreeDigest(directory);
  await mkdir(path.join(directory, "empty"));
  assert.notEqual(await regradeTreeDigest(directory), before);
  await writeFile(path.join(directory, "agent.patch"), "changed");
  assert.notEqual(await regradeTreeDigest(directory), before);
  await symlink("agent.patch", path.join(directory, "link"));
  await assert.rejects(regradeTreeDigest(directory), /symlink/);
});

test("regrade carries the original lifecycle receipt without inventing missing or failed phases", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-regrade-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), output = path.join(root, "output");
  await mkdir(source);
  await assert.rejects(seedHarborRegradeTrial(source, output));
  const journal = { schema_version: "1", phases: { prepare: { source: "original" }, snapshot: { digest: "original" } }, failure: null };
  await atomicWriteJSON(path.join(source, "benchmark-lifecycle.json"), journal);
  await seedHarborRegradeTrial(source, output);
  assert.deepEqual(await readFile(path.join(output, "benchmark-lifecycle.json")), await readFile(path.join(source, "benchmark-lifecycle.json")));
  await atomicWriteJSON(path.join(source, "benchmark-lifecycle.json"), { ...journal, failure: "snapshot_failed" });
  await assert.rejects(seedHarborRegradeTrial(source, output), /incomplete or failed/);
});

test("frozen regrade uses the saved resolver and rejects changed source or compiled task bytes", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-regrade-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "package/source"), tasks = path.join(root, "package/tasks");
  await mkdir(source, { recursive: true }); await mkdir(tasks);
  await writeFile(path.join(source, "input"), "frozen"); await chmod(path.join(source, "input"), 0o644);
  await writeFile(path.join(tasks, "task.toml"), "frozen compiled task");
  const lock = { protocol: "hitch-benchmark@1", benchmark_id: "demo", package_digest: await benchmarkTreeDigest(source),
    resolver: { code_digest: `sha256:${"d".repeat(64)}` }, files: [{ path: "input", digest: sha256Bytes(Buffer.from("frozen")), bytes: 6, mode: 0o644 }] };
  const digest = sha256JSON({ lock, compiler: "harbor-package@3" });
  await atomicWriteJSON(path.join(root, "benchmark/package.json"), { source, tasks, package_digest: lock.package_digest, compiled_digest: digest });
  await atomicWriteJSON(path.join(root, "benchmark/benchmark.lock.json"), lock);
  await atomicWriteJSON(path.join(root, "package/compiled.json"), { digest, tasks_digest: await benchmarkTreeDigest(tasks) });
  assert.deepEqual(await frozenRerunBenchmark(root), { id: "demo", revision: lock.package_digest, tasks, standard: false });
  await writeFile(path.join(source, "input"), "edited");
  await assert.rejects(frozenRerunBenchmark(root), /identity changed/);
  await writeFile(path.join(source, "input"), "frozen");
  await writeFile(path.join(tasks, "task.toml"), "new grader");
  await assert.rejects(frozenRerunBenchmark(root), /identity changed/);
});

test("regrade restores the trusted final response only when it matches the sealed run", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-regrade-response-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), output = path.join(root, "output");
  await mkdir(source);
  await atomicWriteJSON(path.join(source, "benchmark-lifecycle.json"), { schema_version: "1", phases: {}, failure: null });
  const result = { run_id: "run-original", status: "succeeded", output: "" };
  const canonical = { schema_version: "1", source: "hitch-run-result", run_id: result.run_id, termination: result.status, response: result.output };
  await atomicWriteJSON(path.join(source, "hitch-final-response.json"), canonical);
  await mkdir(path.join(source, "artifacts"));
  await atomicWriteJSON(path.join(source, "artifacts/hitch-final-response.json"), { ...canonical, response: "forged candidate artifact" });
  await assert.rejects(seedHarborRegradeTrial(source, output), /sealed candidate result/);
  await seedHarborRegradeTrial(source, output, result);
  assert.deepEqual(await readFile(path.join(output, "hitch-final-response.json")), await readFile(path.join(source, "hitch-final-response.json")));
  for (const field of ["run_id", "termination", "response", "source"]) {
    await atomicWriteJSON(path.join(source, "hitch-final-response.json"), { ...canonical, [field]: "changed" });
    await assert.rejects(seedHarborRegradeTrial(source, output, result), /sealed candidate result/);
  }
});

test("separate assessment retains a zero score and rejects evidence and source tampering", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-regrade-assessment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evalId = `eval_${"a".repeat(32)}`, runId = `run_${"b".repeat(32)}`, assessmentId = `assessment_${"c".repeat(32)}`;
  const directory = path.join(root, "evals", evalId, "assessments", assessmentId);
  const run = path.join(root, "runs", runId);
  await mkdir(path.join(directory, "evidence"), { recursive: true });
  await atomicWriteJSON(path.join(run, "manifest.json"), { schema_version: "1", run_id: runId, sealed: true });
  const index = await writeResultBundleIndex(run);
  const observation = { status: "valid", reward: 0, verifier_result_ref: "evidence/verifier-result.json" };
  await atomicWriteJSON(path.join(directory, "evidence/verifier-result.json"), { rewards: { reward: 0 } });
  const reference = await sealRegradeAssessment(directory, { eval_id: evalId, task_id: "task", attempt: 1,
    source: { trial_id: "original", run_id: runId, bundle_index_digest: sha256JSON(index) }, observation });
  const trial = parseEvalTrialRef({ trial_id: "original", run_id: runId, task_id: "task", attempt: 1, observation_status: "valid", reward: 0, verifier_result_ref: observation.verifier_result_ref, assessment: reference });
  assert.deepEqual(await readRegradeObservation(root, evalId, trial), observation);
  await assert.rejects(readRegradeObservation(root, evalId, { ...trial, trial_id: "another" }), /source identity/);
  const bytes = await readFile(path.join(directory, "evidence/verifier-result.json"));
  await writeFile(path.join(directory, "evidence/verifier-result.json"), '{"reward":1}');
  await assert.rejects(readRegradeObservation(root, evalId, trial), /evidence changed/);
  await writeFile(path.join(directory, "evidence/verifier-result.json"), bytes);
  await atomicWriteJSON(path.join(run, "manifest.json"), { schema_version: "1", run_id: runId, sealed: true, altered: true });
  await assert.rejects(readRegradeObservation(root, evalId, trial), /integrity does not match/);
});
