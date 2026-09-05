import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EvalRequest, RunContextV1, RunObservationV1, RunStatus } from "../src/domain/index.js";
import type { ResolvedRevision } from "../src/artifacts/index.js";
import { benchmarkTreeDigest } from "../src/benchmarks/index.js";
import { ensureControllerRuntime } from "../src/controller-runtime/index.js";
import { atomicWriteJSON, readJSON, sha256Bytes, sha256JSON } from "../src/foundation/index.js";
import { benchmarkVerifierIdentity, inspectSealedPhaseRunBundle, loadRunRecord, writeResultBundleIndex } from "../src/runs/index.js";
import { buildBenchmarkAdapterManifest } from "../src/evals/benchmark-adapter-manifest.js";
import { importEvalTrialRun, validateEvalTrialReferences } from "../src/evals/trial-import.js";
import { importNativePhaseTrial } from "../src/evals/native-phase-evidence.js";
import type { NativePhaseDescriptor } from "../src/evals/native-phase-evidence.js";
import { sealRegradeAssessment } from "../src/evals/regrade-evidence.js";
import { createEvalProgress, mergeEvalProgressTrial, parseEvalTrialRef, replaceInvalidEvalProgressTrial, writeEvalProgress } from "../src/evals/progress.js";
import { buildEvalExecutionPlan } from "../src/evals/execution-plan.js";
import { validateEvalId } from "../src/evals/request.js";
import { verifierOnlyEvalRerun } from "../src/evals/verifier-only-rerun.js";
import { selectRerunTrialSlots } from "../src/evals/rerun-slots.js";
import { TrajectoryProjector } from "../src/trajectories/projector.js";
import { TrajectoryWriter, canonicalTrajectoryFileRef, trajectoryRefV2 } from "../src/trajectories/store.js";
import { forceRemove } from "../test-support/helpers.js";

const evalId = `eval_${"e".repeat(32)}`, runId = `run_${"b".repeat(32)}`;
const taskId = "task-one", trialId = `${taskId}__1`, benchmarkId = "standard-verifier-test";
const digest = `sha256:${"a".repeat(64)}` as const;
const timestamp = "2026-09-01T00:00:00.000Z";
const parent = { kind: "eval" as const, eval_id: evalId, trial_id: trialId, attempt: 1 };

async function fixture(t: test.TestContext, taskToml = 'schema_version = "1.4"\n') {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-standard-verifier-"));
  t.after(() => forceRemove(root));
  const dataset = path.join(root, "dataset"), evalDirectory = path.join(root, "evals", evalId);
  const trialDirectory = path.join(evalDirectory, "harbor/job", trialId);
  await mkdir(path.join(dataset, taskId), { recursive: true });
  await mkdir(path.join(trialDirectory, "verifier"), { recursive: true });
  await writeFile(path.join(dataset, taskId, "task.toml"), taskToml);
  const manifest = await buildBenchmarkAdapterManifest({ dataset,
    benchmark: { id: benchmarkId, revision: "1" },
    adapter: { id: "fixture", revision: digest, output_protocol: "gear-harbor-eval-result-v1" },
    scoring: { total_score: { source_metric: "success", direction: "maximize", range: [0, 1], reducer: "task-macro-mean" } },
    taskIds: [taskId] });
  await atomicWriteJSON(path.join(dataset, "benchmark.adapter.json"), manifest);
  const benchmarkRevision = manifest.dataset_digest;
  const request: EvalRequest = { schema_version: "1", backend: "harbor", dataset, harness_ref: "codex@version:1.0.0", model: "synthetic-model",
    attempts: 1, max_concurrent: 1, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0, timeout_ms: 0, setup_timeout_ms: 1000,
    agent_args: [], pass_env: [], benchmark_id: benchmarkId, benchmark_revision: benchmarkRevision };
  const resolvedRevision: ResolvedRevision = { schema_version: "1", requested_ref: request.harness_ref, canonical_ref: request.harness_ref,
    harness_id: "codex", selector: { type: "version", value: "1.0.0" }, source: { type: "npm" },
    revision: { type: "version", version: "1.0.0" }, identity: digest, resolved_at: timestamp };
  const context: RunContextV1 = { kind: "benchmark_task", benchmark_id: benchmarkId, benchmark_revision: benchmarkRevision,
    task_id: taskId, task_digest: digest, verifier_identity: benchmarkVerifierIdentity(benchmarkId, benchmarkRevision) };
  return { root, evalId, evalDirectory, trialDirectory, request, resolvedRevision, benchmarkId, benchmarkRevision, context };
}

async function writeRun(directory: string, context: RunContextV1, status: RunStatus = "succeeded", observation?: RunObservationV1) {
  await atomicWriteJSON(path.join(directory, "manifest.json"), { schema_version: "1", run_id: runId, context, parent, status,
    harness: { harness_id: "codex", requested_ref: "codex@version:1.0.0", revision_identity: digest },
    model: { requested_id: "synthetic-model", effective_id: "synthetic-model", identity_resolved: false },
    protocol: { timeout_ms: 1000, workspace_mode: "shared" }, ...(observation ? { observation } : {}),
    request_ref: "request.json", resolution_ref: "resolution.json", result_ref: "result.json", trajectory_ref: "trajectory.ref.json",
    created_at: timestamp, sealed: true });
  await atomicWriteJSON(path.join(directory, "request.json"), { context, parent });
  await atomicWriteJSON(path.join(directory, "resolution.json"), {});
  await atomicWriteJSON(path.join(directory, "result.json"), { run_id: runId, status, started_at: timestamp, completed_at: timestamp });
  await writeFile(path.join(directory, "events.jsonl"), "");
  const projector = new TrajectoryProjector({ runId, cwd: "/workspace", prompt: "fixture", model: "synthetic-model", fidelity: "normalized" });
  projector.feed({ type: "message.completed", text: "done" });
  const projected = projector.finalize("succeeded");
  const writer = await TrajectoryWriter.open({ runDirectory: directory, cwd: "/workspace", sessionId: projected.header.id,
    fidelity: projected.fidelity, header: projected.header });
  for (const event of projected.events) writer.append(event);
  const file = await canonicalTrajectoryFileRef(directory, await writer.close());
  await atomicWriteJSON(path.join(directory, "trajectory.ref.json"), trajectoryRefV2({ runId, fidelity: "normalized",
    providerSessionId: "synthetic-native-session", files: [file] }));
}

const cases: Array<{ name: string; verifier: Record<string, unknown> | null; exception?: boolean; log?: string; status?: RunStatus; reason?: string }> = [
  { name: "verifier exception without results", verifier: null, exception: true, reason: "verifier_infrastructure_failure" },
  { name: "verifier exception with malformed scores", verifier: { rewards: { reward: 0, total_score: 1 } }, exception: true, reason: "verifier_infrastructure_failure" },
  { name: "missing verifier result", verifier: null, reason: "verifier_result_missing" },
  { name: "verifier DNS failure", verifier: { rewards: { reward: 0 } }, log: "curl: (6) Could not resolve host: example.test\n", reason: "verifier_infrastructure_failure" },
  { name: "failed candidate", verifier: null, status: "failed", reason: "infrastructure_failure" },
  { name: "cancelled candidate", verifier: null, status: "cancelled", reason: "cancelled" },
  { name: "completed verifier omits standard scores", verifier: { rewards: { reward: 0 } }, reason: "verifier_score_contract_invalid" },
  { name: "completed verifier reports a valid zero", verifier: { rewards: { reward: 0, total_score: 0 } } },
];
for (const value of cases) test(`standard trial preserves ${value.name}`, async t => {
  const input = await fixture(t), bundle = path.join(input.trialDirectory, "hitch-run-bundle");
  await writeRun(bundle, input.context, value.status);
  if (value.log) await writeFile(path.join(input.trialDirectory, "verifier/test-stderr.txt"), value.log);
  const trial = { task_name: taskId, trial_name: trialId, verifier_result: value.verifier,
    ...(value.exception ? { exception_info: { exception_type: "VerifierSetupError" } } : {}) };
  const ref = await importEvalTrialRun(input, trial);
  assert.equal(ref.run_id, runId, "the original candidate must remain attached");
  assert.equal(ref.invalid_reason, value.reason);
  assert.equal(ref.observation_status, value.reason ? "invalid" : "valid");
  assert.deepEqual(ref.scores, value.reason ? undefined : { total_score: 0, normalization: "standard" });
  await validateEvalTrialReferences(input.root, evalId, [ref], input);
  const progress = mergeEvalProgressTrial(createEvalProgress({ ...input, startedAt: timestamp, plannedTasks: 1, plannedTrials: 1 }), ref);
  if (value.reason?.startsWith("verifier_") && value.reason !== "verifier_score_contract_invalid") {
    assert.throws(() => selectRerunTrialSlots([taskId], 1, progress, { mode: "invalid" }), /Candidate Agent will not be rerun/);
    assert.deepEqual(selectRerunTrialSlots([taskId], 1, progress, { mode: "invalid" }, { allowVerifierFailures: true }), [{ task_id: taskId, attempt: 1 }]);
  }
  // Retrying a captured publication must not parse a failed verifier's malformed scores.
  await writeRun(bundle, input.context, value.status);
  assert.deepEqual(await importEvalTrialRun(input, trial), ref);
});

test("standard regrade validates score channels in its sealed assessment and repairs progress", async t => {
  const input = await fixture(t);
  await writeRun(path.join(input.trialDirectory, "hitch-run-bundle"), input.context);
  const original = await importEvalTrialRun(input, { task_name: taskId, trial_name: trialId, verifier_result: null });
  const run = path.join(input.root, "runs", runId), index = await writeResultBundleIndex(run);
  const directory = path.join(input.evalDirectory, "assessments", `assessment_${"c".repeat(32)}`);
  const observation: RunObservationV1 = { status: "valid", reward: 0, verifier_result_ref: "evidence/verifier-result.json" };
  const resultPath = path.join(directory, observation.verifier_result_ref!);
  await atomicWriteJSON(resultPath, { rewards: { reward: 0, total_score: 0, process_score: 0.25 } });
  const assessment = await sealRegradeAssessment(directory, { eval_id: evalId, task_id: taskId, attempt: 1,
    source: { trial_id: trialId, run_id: runId, bundle_index_digest: sha256JSON(index) }, observation });
  const trial = parseEvalTrialRef({ trial_id: trialId, task_id: taskId, attempt: 1, run_id: runId,
    observation_status: "valid", reward: 0, verifier_result_ref: observation.verifier_result_ref, assessment,
    scores: { total_score: 0, process_score: 0.25, normalization: "standard" } });
  await validateEvalTrialReferences(input.root, evalId, [trial], input);
  const progress = mergeEvalProgressTrial(createEvalProgress({ ...input, startedAt: timestamp, plannedTasks: 1, plannedTrials: 1 }), original);
  assert.deepEqual(replaceInvalidEvalProgressTrial(progress, trial).trials, [trial]);
  await validateEvalTrialReferences(input.root, evalId, [{ ...trial, scores: { normalization: "standard", process_score: 0.25, total_score: 0 } }]);
  await assert.rejects(validateEvalTrialReferences(input.root, evalId, [{ ...trial, scores: { ...trial.scores!, process_score: 0.5 } }]), /score channels mismatch/);
  await assert.rejects(validateEvalTrialReferences(input.root, evalId, [{ ...trial, scores: { total_score: 0, normalization: "standard" } }]), /score channels mismatch/);
  const originalBytes = await readFile(resultPath);
  await atomicWriteJSON(resultPath, { rewards: { reward: 1, total_score: 1 } });
  await assert.rejects(validateEvalTrialReferences(input.root, evalId, [trial]), /evidence changed/);
  await writeFile(resultPath, originalBytes);
  const manifestPath = path.join(run, "manifest.json");
  await writeFile(manifestPath, Buffer.concat([await readFile(manifestPath), Buffer.from(" ")]));
  await assert.rejects(validateEvalTrialReferences(input.root, evalId, [trial]), /integrity/);
});

for (const score of [-1, 0, 1, 2]) test(`verifier-only regrade enforces the frozen [0, 1] range for score ${score}`, async t => {
  const input = await fixture(t, 'schema_version = "1.4"\n[verifier]\nenvironment_mode = "separate"\n');
  const source = path.join(input.root, "package-source"), tasks = input.request.dataset;
  await mkdir(source);
  await writeFile(path.join(source, "input"), "frozen");
  await chmod(path.join(source, "input"), 0o644);
  const lock = { protocol: "hitch-benchmark@1", benchmark_id: benchmarkId, package_digest: await benchmarkTreeDigest(source),
    files: [{ path: "input", digest: sha256Bytes(Buffer.from("frozen")), bytes: 6, mode: 0o644 }] };
  const compiledDigest = sha256JSON({ lock, compiler: "harbor-package@6" });
  await atomicWriteJSON(path.join(input.evalDirectory, "benchmark/package.json"), { source, tasks, package_digest: lock.package_digest, compiled_digest: compiledDigest });
  await atomicWriteJSON(path.join(input.evalDirectory, "benchmark/benchmark.lock.json"), lock);
  await atomicWriteJSON(path.join(path.dirname(tasks), "compiled.json"), { digest: compiledDigest, tasks_digest: await benchmarkTreeDigest(tasks) });
  const payload = path.join(input.root, "runtime-payload");
  await mkdir(path.join(payload, "dist/bin"), { recursive: true });
  await writeFile(path.join(payload, "dist/bin/hitch.js"), "// frozen runtime\n");
  const runtime = await ensureControllerRuntime({ root: input.root, payloadRoot: payload, rules: [{ path: "dist/bin/hitch.js" }] });
  const execution = buildEvalExecutionPlan({ evalId: validateEvalId(evalId), request: input.request,
    candidate: { revisionIdentity: digest, artifactId: digest }, tasks: [taskId], maxParallelism: 1 });
  await atomicWriteJSON(path.join(input.evalDirectory, "execution-plan.json"), execution);
  const sourceTrial = path.join(input.evalDirectory, "harbor/work-items", execution.work_items[0]!.work_id, "epoch-000001/job", trialId);
  await mkdir(path.join(sourceTrial, "artifacts"), { recursive: true });
  const sourceResult = { id: "original-trial", trial_name: trialId, task_name: taskId,
    agent_result: { metadata: { hitch_run_id: runId, controller_runtime_id: runtime.runtime_id } } };
  await atomicWriteJSON(path.join(sourceTrial, "result.json"), sourceResult);
  await atomicWriteJSON(path.join(sourceTrial, "config.json"), { task: { path: path.join(tasks, taskId) },
    agent: { import_path: "hitch_harbor_agent:HitchHarborAgent" }, verifier: {},
    environment: { import_path: "hitch_harbor_environment:HitchHarborDockerEnvironment" } });
  await atomicWriteJSON(path.join(sourceTrial, "benchmark-lifecycle.json"), { schema_version: "1", phases: {}, failure: null });
  await writeRun(path.join(input.trialDirectory, "hitch-run-bundle"), input.context);
  const original = await importEvalTrialRun(input, { ...sourceResult, verifier_result: null });
  const progress = mergeEvalProgressTrial(createEvalProgress({ ...input, startedAt: timestamp, plannedTasks: 1, plannedTrials: 1 }), original);
  await writeEvalProgress(input.evalDirectory, progress);
  const originalManifest = await readFile(path.join(input.root, "runs", runId, "manifest.json"));
  // Exercise real regrade orchestration; only the external Harbor/Docker commands
  // are replaced. The candidate result and sealed run remain authoritative.
  const harbor = path.join(input.root, "fake-harbor.mjs"), docker = path.join(input.root, "fake-docker.mjs");
  await writeFile(docker, "#!/usr/bin/env node\n");
  await writeFile(harbor, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
if (process.argv.includes('--version')) { console.log('harbor 0.21.0'); process.exit(0); }
const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8'));
const source = JSON.parse(readFileSync(path.join(config.source_trial.path, 'result.json'), 'utf8'));
writeFileSync(path.join(config.trials_dir, config.trial_name, 'result.json'), JSON.stringify({ ...source,
  trial_name: config.trial_name, verifier_result: { rewards: { reward: ${score}, total_score: ${score} } } }));
`);
  await chmod(harbor, 0o755); await chmod(docker, 0o755);
  const rerunId = `rerun_${"f".repeat(32)}`;
  const rerun = verifierOnlyEvalRerun({ ...input, progress, previousResult: null, rerunId,
    rerunDirectory: path.join(input.evalDirectory, "reruns", rerunId), startedAt: timestamp,
    selector: { mode: "invalid" }, selectedTrials: [{ task_id: taskId, attempt: 1 }],
    plan: { tasks: [taskId], attempts: 1, controllerRuntime: { runtime_id: runtime.runtime_id, manifest_digest: runtime.manifest_digest } },
    harborExecutable: harbor, env: { ...process.env, HITCH_DOCKER_PATH: docker } });
  if (score === -1 || score === 2) {
    await assert.rejects(rerun, { code: "eval_verifier_only_unavailable", message: "regraded standardized score contract is invalid" });
    assert.deepEqual(await readJSON(path.join(input.evalDirectory, "progress.json")), progress);
  } else {
    assert.deepEqual((await rerun).repaired_trials, [{ task_id: taskId, attempt: 1 }]);
    const repaired = await readJSON<{ trials: Array<{ reward: number; run_id: string }> }>(path.join(input.evalDirectory, "progress.json"));
    assert.equal(repaired.trials[0]!.reward, score);
    assert.equal(repaired.trials[0]!.run_id, runId);
  }
  assert.deepEqual(await readFile(path.join(input.root, "runs", runId, "manifest.json")), originalManifest);
});

for (const exception of [false, true]) test(`native standard assessment retains ${exception ? "verifier infrastructure failure" : "missing verifier result"}`, async t => {
  const input = await fixture(t), groupId = `run_group_${"d".repeat(32)}`;
  const context: RunContextV1 = { ...input.context, kind: "benchmark_phase", run_group_id: groupId, phase_index: 1 };
  const bundleRef = "agent/hitch-run-bundle", bundle = path.join(input.trialDirectory, bundleRef);
  await writeRun(bundle, context);
  await writeResultBundleIndex(bundle);
  const proof = await inspectSealedPhaseRunBundle({ sourceDirectory: bundle, expected: { run_id: runId, context, parent, revision_identity: digest } });
  const descriptor: NativePhaseDescriptor = { task_digest: digest, primary_metric: "success", audit_path: "/evidence/channel.jsonl",
    agent_timeout_ms: 1000, standard_total_range: [0, 1], metrics: { success: { type: "binary", direction: "maximize", range: [0, 1], reducer: "task_macro_mean" } },
    task: { schema_version: "1", source_task_id: taskId, requirements: ["native-phases@1"], lifecycle: {},
      driver: { kind: "tool-server", protocol_version: "1", config: { transport: "http-json-cli", endpoint: "http://counter:8765", schema: "tools.json", service: "counter",
        native_phases: { protocol: "hitch-native-phase-control@1", argv: ["python", "/control.py"], audit_path: "/evidence/channel.jsonl", shutdown_timeout_ms: 1000 } } },
      submission: { kind: "artifacts", paths: ["/evidence"], max_bytes: 1024 }, grading: { kind: "command", entrypoint: ["bash", "/tests/test.sh"], metric_map: { success: "passed" } } } };
  const screenshot = Buffer.from("synthetic screenshot"), screenshotHash = sha256Bytes(screenshot).slice(7);
  const artifacts = path.join(input.trialDirectory, "artifacts/evidence");
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "observation-000001.png"), screenshot);
  const audit = [
    { event: "context_required", generation: 1, sequence: 0 },
    { event: "prediction", generation: 1, sequence: 1, screenshot_file: "observation-000001.png", screenshot_sha256: screenshotHash },
    { event: "context_bound", generation: 1, sequence: 1, run_id: runId },
    { event: "action_submitted", generation: 1, sequence: 1, run_id: runId },
    { event: "completed", generation: 1, sequence: 1 },
  ];
  await writeFile(path.join(artifacts, "channel.jsonl"), audit.map(event => JSON.stringify(event)).join("\n") + "\n");
  await atomicWriteJSON(path.join(input.trialDirectory, "hitch-native-phases/supervision.json"), {
    schema_version: "hitch-native-phase-supervision@1", scope: "candidate-evidence-only", status: "completed", run_group_id: groupId, task_digest: digest,
    phases: [{ phase_index: 1, generation: 1, run_id: runId, status: "sealed", bundle_ref: bundleRef, evidence: proof,
      first_prediction_sequence: 1, first_screenshot_sha256: screenshotHash, boundary: { state: "completed", generation: 1, sequence: 1 } }] });
  await atomicWriteJSON(path.join(input.trialDirectory, "benchmark-lifecycle.json"), {
    failure: null, phases: Object.fromEntries(["prepare", "quiesce", "snapshot"].map(phase => [phase, { status: "ok" }])) });
  const trial = { task_name: taskId, trial_name: trialId,
    verifier_result: exception ? { rewards: { reward: 0, total_score: 1 } } : null,
    ...(exception ? { exception_info: { exception_type: "VerifierSetupError" } } : {}) };
  const options = { ...input, trial, trialId, taskId, attempt: 1 };
  const ref = await importNativePhaseTrial(options, descriptor);
  assert.ok(ref.run_group);
  assert.equal(ref.observation_status, "invalid");
  assert.equal(ref.invalid_reason, exception ? "verifier_infrastructure_failure" : "verifier_result_missing");
  assert.equal(ref.scores, undefined);
  await validateEvalTrialReferences(input.root, evalId, [ref], input);
  assert.deepEqual(await importNativePhaseTrial(options, descriptor), ref);
  assert.equal((await loadRunRecord(path.join(input.root, "runs", runId))).record.observation, undefined);
  const record = await readJSON<{ observation: RunObservationV1 }>(path.join(input.evalDirectory, "assessments", ref.assessment.id, "assessment.json"));
  assert.equal(record.observation.invalid_reason, ref.invalid_reason);
});
