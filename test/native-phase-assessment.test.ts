import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { parse as parseTOML } from "smol-toml";
import type { EvalExecutionPlanV1, EvalRequest } from "../src/domain/index.js";
import { loadBenchmark } from "../src/benchmarks/index.js";
import { atomicWriteJSON, ensureDir, readJSON, sha256Bytes } from "../src/foundation/index.js";
import { compileBenchmark } from "../src/evals/benchmark-run.js";
import { resolveBenchmarkReference } from "../src/evals/request.js";
import { importEvalTrialRun, validateEvalTrialReferences } from "../src/evals/trial-import.js";
import { readNativePhaseObservation } from "../src/evals/native-phase-evidence.js";
import { createEvalProgress, mergeEvalProgressTrial, parseEvalTrialRef } from "../src/evals/progress.js";
import { recoverPromotedEvalTrialPublications } from "../src/evals/trial-publication-recovery.js";
import { summarizeTrialRefs } from "../src/evals/result-helpers.js";
import { benchmarkVerifierIdentity, executeRun, inspectSealedPhaseRunBundle, loadRunRecord, newRunId, verifyResultBundleIndex } from "../src/runs/index.js";
import { parseHarnessReference, resolveHarness } from "../src/revisions/index.js";
import { writeBenchmarkFixture } from "../test-support/benchmark-fixture.js";

for (const budgetCase of ["normal", "active", "between"] as const) test(`native package imports one immutable whole-task assessment (${budgetCase}) and recovers publication`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-native-assessment-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = await ensureDir(path.join(directory, "state")), pkg = path.join(directory, "package");
  await writeBenchmarkFixture(pkg);
  const sourceTask = path.join(pkg, "tasks/add-seven");
  const task = await readJSON<Record<string, any>>(path.join(sourceTask, "task.hitch.json"));
  task.driver.config.native_phases = { protocol: "hitch-native-phase-control@1", argv: ["python", "/runtime/control.py"], audit_path: "/evidence/channel.jsonl", shutdown_timeout_ms: 30000 };
  if (budgetCase !== "normal") Object.assign(task.driver.config.native_phases, { protocol: "hitch-native-phase-control@2", finalization_timeout_ms: 5000 });
  task.requirements.push("native-phases@1", "tool-result-images@1", "native-image-input");
  task.submission.paths = ["/evidence"];
  await atomicWriteJSON(path.join(sourceTask, "task.hitch.json"), task);
  await writeFile(path.join(sourceTask, "task.toml"), (await readFile(path.join(sourceTask, "task.toml"), "utf8")).replace("/evidence/counter.json", "/evidence"));
  const profilePath = path.join(pkg, "profiles/default.json"), profile = await readJSON<Record<string, any>>(profilePath);
  profile.tool_policy.allowed = task.requirements;
  await atomicWriteJSON(profilePath, profile);
  const loaded = await loadBenchmark(pkg);
  for (const change of [
    { ...task.driver.config.native_phases, audit_path: "/private/channel.jsonl" },
    { ...task.driver.config.native_phases, protocol: "unknown@1" },
    { ...task.driver.config.native_phases, protocol: "hitch-native-phase-control@1", finalization_timeout_ms: 5000 },
    { ...task.driver.config.native_phases, protocol: "hitch-native-phase-control@2", finalization_timeout_ms: undefined },
    { ...task.driver.config.native_phases, protocol: "hitch-native-phase-control@2", finalization_timeout_ms: profile.budget.collection_timeout_ms + 1 },
  ]) {
    await atomicWriteJSON(path.join(sourceTask, "task.hitch.json"), { ...task, driver: { ...task.driver, config: { ...task.driver.config, native_phases: change } } });
    await assert.rejects(loadBenchmark(pkg));
  }
  await atomicWriteJSON(path.join(sourceTask, "task.hitch.json"), task);
  const compiled = await compileBenchmark(loaded, root);
  const execution = parseTOML(await readFile(path.join(compiled.tasks, "add-seven/task.toml"), "utf8"));
  assert.equal((execution.agent as Record<string, unknown>).timeout_sec, budgetCase === "normal" ? 300 : 360);
  const descriptor = await readJSON<Record<string, any>>(path.join(compiled.tasks, "add-seven/.hitch-benchmark.json"));
  assert.equal(descriptor.agent_timeout_sec, 60, "model task budget must remain unchanged");
  const evalId = `eval_${"1".repeat(32)}`, groupId = `run_group_${"2".repeat(32)}`, trialId = "add-seven__native";
  const evalDirectory = await ensureDir(path.join(root, "evals", evalId));
  await ensureDir(path.join(evalDirectory, "benchmark"));
  await atomicWriteJSON(path.join(evalDirectory, "benchmark/package.json"), { ...compiled, package_digest: loaded.lock.package_digest, compiled_digest: compiled.digest });
  await atomicWriteJSON(path.join(evalDirectory, "benchmark/benchmark.lock.json"), loaded.lock);
  const trialDirectory = await ensureDir(path.join(evalDirectory, "harbor/job", trialId));
  await atomicWriteJSON(path.join(trialDirectory, "lock.json"), { task: { name: "add-seven" } });
  const executable = path.join(directory, "synthetic-codex");
  await writeFile(executable, `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('codex-cli 9.9.9');process.exit(0);}
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>prompt+=part);
console.log(JSON.stringify({type:'thread.started',thread_id:require('node:crypto').randomUUID()}));
process.stdin.on('end',()=>{
if(${JSON.stringify(budgetCase === "active")} && prompt.includes('native phase 2')) { setInterval(()=>{},1000); return; }
console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'synthetic phase'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
});
`, { mode: 0o755 });
  const old = process.env.HITCH_CODEX_PATH; process.env.HITCH_CODEX_PATH = executable;
  t.after(() => { if (old === undefined) delete process.env.HITCH_CODEX_PATH; else process.env.HITCH_CODEX_PATH = old; });
  const resolution = await resolveHarness(parseHarnessReference("codex"), { root });
  const benchmark = await resolveBenchmarkReference(compiled.tasks);
  const request: EvalRequest = { schema_version: "1", backend: "harbor", dataset: compiled.tasks, harness_ref: "codex", model: "synthetic-model",
    attempts: 1, max_concurrent: 1, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0, timeout_ms: 0, setup_timeout_ms: 10000,
    agent_args: [], pass_env: [], benchmark_id: benchmark.benchmark_id, benchmark_revision: benchmark.benchmark_revision };
  const cwd = await ensureDir(path.join(directory, "candidate-workspace"));
  const candidateRoot = await ensureDir(path.join(directory, "candidate-state"));
  const supervision: Record<string, any> = { schema_version: "hitch-native-phase-supervision@1", scope: "candidate-evidence-only", status: "completed",
    run_group_id: groupId, task_digest: descriptor.task_digest, phases: [] };
  const audit: Record<string, unknown>[] = [], originalIndexes = new Map<string, Buffer>();
  const artifacts = await ensureDir(path.join(trialDirectory, "artifacts/evidence"));
  // Synthetic PNG bytes exercise evidence hashing, not image understanding.
  const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex"), screenshotHash = sha256Bytes(png).slice(7);
  for (let phase = 1; phase <= 2; phase++) {
    const id = newRunId();
    const context = { kind: "benchmark_phase" as const, benchmark_id: request.benchmark_id, benchmark_revision: request.benchmark_revision,
      task_id: "add-seven", task_digest: descriptor.task_digest, verifier_identity: benchmarkVerifierIdentity(request.benchmark_id, request.benchmark_revision), run_group_id: groupId, phase_index: phase };
    const parent = { kind: "eval", eval_id: evalId, trial_id: trialId, attempt: 1 };
    const result = await executeRun({ root: candidateRoot, runsRoot: path.join(candidateRoot, "runs"), runId: id,
      request: { agent: "codex", model: request.model, cwd, prompt: `native phase ${phase}`, timeout_ms: budgetCase === "active" && phase === 2 ? 1000 : 5000, workspace_mode: "copy", context, parent } });
    assert.equal(result.status, budgetCase === "active" && phase === 2 ? "timed_out" : "succeeded");
    const bundleRef = phase === 2 && budgetCase !== "between" ? "agent/hitch-run-bundle" : `hitch-candidate-phases/phase-${String(phase).padStart(4, "0")}/agent/hitch-run-bundle`;
    const sourceDirectory = path.join(trialDirectory, bundleRef);
    await ensureDir(path.dirname(sourceDirectory));
    await cp(path.join(candidateRoot, "runs", id), sourceDirectory, { recursive: true });
    const proof = await inspectSealedPhaseRunBundle({ sourceDirectory, expected: { run_id: id, context, parent, revision_identity: resolution.identity } });
    originalIndexes.set(id, await readFile(path.join(sourceDirectory, "bundle.index.json")));
    supervision.phases.push({ phase_index: phase, generation: phase, run_id: id, status: "sealed", bundle_ref: bundleRef, evidence: proof,
      first_prediction_sequence: phase, first_screenshot_sha256: screenshotHash,
      boundary: { state: phase === 2 ? "completed" : "context_required", generation: 2, sequence: phase === 2 ? 2 : 1 } });
    const screenshot = `observation-${String(phase).padStart(6, "0")}.png`;
    await writeFile(path.join(artifacts, screenshot), png);
    audit.push({ event: "context_required", generation: phase, sequence: phase - 1 },
      { event: "prediction", generation: phase, sequence: phase, screenshot_file: screenshot, screenshot_sha256: screenshotHash },
      { event: "context_bound", generation: phase, sequence: phase, run_id: id });
    if (budgetCase !== "active" || phase !== 2) audit.push({ event: "action_submitted", generation: phase, sequence: phase, run_id: id });
  }
  if (budgetCase === "between") {
    supervision.phases[1].boundary = { state: "context_required", generation: 3, sequence: 2 };
    await writeFile(path.join(artifacts, "observation-000003.png"), png);
    audit.push({ event: "context_required", generation: 3, sequence: 2 },
      { event: "prediction", generation: 3, sequence: 3, screenshot_file: "observation-000003.png", screenshot_sha256: screenshotHash });
  }
  const terminal = { state: "completed", generation: budgetCase === "between" ? 3 : 2, sequence: budgetCase === "between" ? 3 : 2 };
  if (budgetCase !== "normal") {
    const receipt = { budget_exhausted: true, generation: terminal.generation, sequence: terminal.sequence,
      run_id: budgetCase === "active" ? supervision.phases[1].run_id : null, pending_prediction: true, action_submitted: false };
    supervision.started_at = new Date(Date.now() - 61000).toISOString(); supervision.timeout_ms = 60000;
    supervision.budget_finalization = { status: "completed", timeout_ms: 5000, elapsed_ms: 60001, requested_at: new Date().toISOString(), receipt };
    supervision.final_native_state = terminal;
    const { budget_exhausted: _exhausted, ...fields } = receipt;
    audit.push({ event: "budget_exhausted", ...fields });
  }
  audit.push({ event: "completed", generation: terminal.generation, sequence: terminal.sequence });
  // Synthetic host retirement receipt. Actual Docker retirement is covered by
  // its own canary; this test exercises import, retention and cross-checking.
  for (let index = 0; index < (budgetCase === "between" ? 2 : 1); index++) {
    supervision.phases[index].replacement_receipt_ref = `hitch-candidate-phases/phase-${String(index + 1).padStart(4, "0")}/receipt.json`;
    await atomicWriteJSON(path.join(trialDirectory, supervision.phases[index].replacement_receipt_ref), {
      schema_version: "hitch-candidate-recycle@1", scope: "environment-only", status: "completed", phase_index: index + 1,
      old_container_id: String(index + 1).repeat(64), new_container_id: String(index + 2).repeat(64), image: `sha256:${"a".repeat(64)}`, configuration_digest: `sha256:${"b".repeat(64)}`,
      ownership: { "io.hitch.eval-id": evalId, "io.hitch.task-id": "add-seven", "io.hitch.lease-id": "synthetic-lease", "io.hitch.lease-epoch": "1" },
      sidecars: { counter: { id: "e".repeat(64), image: `sha256:${"c".repeat(64)}`, started_at: "2026-09-02T00:00:00Z" } },
      archives: { "/logs/agent": `phase-${String(index + 1).padStart(4, "0")}/agent` },
    });
  }
  const auditPath = path.join(artifacts, "channel.jsonl"), auditBytes = audit.map(row => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(auditPath, auditBytes);
  await ensureDir(path.join(trialDirectory, "hitch-native-phases"));
  await atomicWriteJSON(path.join(trialDirectory, "hitch-native-phases/supervision.json"), supervision);
  await atomicWriteJSON(path.join(trialDirectory, "benchmark-lifecycle.json"), { failure: null, phases: Object.fromEntries(["prepare", "quiesce", "snapshot"].map(phase => [phase, { status: "ok" }])) });
  const verifierDir = await ensureDir(path.join(trialDirectory, "verifier"));
  const rewards = { raw: { passed: 0 }, metrics: { target_reached: 0 }, primary_metric: "target_reached", source_task_id: "add-seven", task_digest: descriptor.task_digest };
  await atomicWriteJSON(path.join(verifierDir, "benchmark-rewards.json"), rewards);
  await atomicWriteJSON(path.join(verifierDir, "reward.json"), rewards.raw);
  const trial = { task_name: "add-seven", trial_name: trialId, verifier_result: { rewards: { reward: 0, total_score: 0, passed: 0 } } };
  const options = { root, evalId, evalDirectory, request, resolvedRevision: resolution, benchmarkId: request.benchmark_id, benchmarkRevision: request.benchmark_revision };
  const ref = await importEvalTrialRun(options, trial);
  assert.ok(ref.run_group, JSON.stringify(ref.run_group ? ref : await readJSON(path.join(trialDirectory, "hitch-run-import-error.json"))));
  assert.equal(ref.run_id, undefined);
  assert.equal(ref.observation_status, "valid"); assert.equal(ref.reward, 0);
  assert.deepEqual(ref.scores, { total_score: 0, normalization: "standard" });
  assert.equal(summarizeTrialRefs([ref]).n_completed, 1, "phases must not double count the task");
  await validateEvalTrialReferences(root, evalId, [ref], options);
  assert.deepEqual(await importEvalTrialRun(options, trial), ref, "import replay must keep the original assessment");
  for (const [id, original] of originalIndexes) {
    const source = path.join(root, "runs", id);
    assert.deepEqual(await readFile(path.join(source, "bundle.index.json")), original);
    assert.equal((await loadRunRecord(source)).record.observation, undefined);
    await verifyResultBundleIndex(source);
  }
  const assessmentDirectory = path.join(evalDirectory, "assessments", ref.assessment.id);
  await rm(path.join(assessmentDirectory, "eval/publication.json"));
  // Minimal plan projection consumed by publication recovery; this test does
  // not represent worker allocation or Docker execution planning.
  const plan = { eval_id: evalId, benchmark: { id: request.benchmark_id, revision: request.benchmark_revision }, membership: "known", slots: [{ task_id: "add-seven", attempt: 1 }] } as EvalExecutionPlanV1;
  const progress = createEvalProgress({ evalId, benchmarkId: request.benchmark_id, benchmarkRevision: request.benchmark_revision, startedAt: new Date().toISOString() });
  const recovered = await recoverPromotedEvalTrialPublications({ root, evalDirectory, plan, progress });
  assert.deepEqual(recovered.progress.trials, [ref]);
  assert.equal((await recoverPromotedEvalTrialPublications({ root, evalDirectory, plan, progress: recovered.progress })).recovered.length, 0);
  assert.throws(() => parseEvalTrialRef({ ...ref, run_id: newRunId() }), /phase group/);
  assert.throws(() => parseEvalTrialRef({ ...ref, assessment: undefined }), /phase group/);
  const another = { ...ref, trial_id: "other", task_id: "other", run_group: { ...ref.run_group, run_group_id: `run_group_${"3".repeat(32)}` } };
  assert.equal(mergeEvalProgressTrial(recovered.progress, another).trials.length, 2, "distinct groups must not conflict on absent run_id");
  for (const altered of [auditBytes.split("\n").slice(0, -2).join("\n") + "\n", auditBytes.replace(supervision.phases[1].run_id, supervision.phases[0].run_id)]) {
    await writeFile(auditPath, altered);
    assert.equal((await importEvalTrialRun(options, trial)).observation_status, "invalid");
  }
  await writeFile(auditPath, auditBytes);
  if (budgetCase !== "normal") {
    const originalReceipt = supervision.budget_finalization.receipt;
    supervision.budget_finalization.receipt = { ...originalReceipt, pending_prediction: false };
    await atomicWriteJSON(path.join(trialDirectory, "hitch-native-phases/supervision.json"), supervision);
    assert.equal((await importEvalTrialRun(options, trial)).observation_status, "invalid", "a deadline receipt must match the private native audit");
    supervision.budget_finalization.receipt = originalReceipt;
    await atomicWriteJSON(path.join(trialDirectory, "hitch-native-phases/supervision.json"), supervision);
  }
  await atomicWriteJSON(path.join(verifierDir, "benchmark-rewards.json"), { ...rewards, metrics: { target_reached: 1 } });
  assert.equal((await importEvalTrialRun(options, trial)).observation_status, "invalid");
  await atomicWriteJSON(path.join(verifierDir, "benchmark-rewards.json"), rewards);
  assert.equal((await readNativePhaseObservation(root, evalId, ref)).reward, 0, "source changes cannot rewrite a sealed assessment");
  const phaseFile = path.join(root, "runs", supervision.phases[1].run_id, "result.json"), original = await readFile(phaseFile);
  await writeFile(phaseFile, Buffer.concat([original, Buffer.from(" ")]));
  await assert.rejects(validateEvalTrialReferences(root, evalId, [ref]), /integrity/);
  await writeFile(phaseFile, original);
  await writeFile(path.join(assessmentDirectory, "evidence/verifier/reward.json"), "changed");
  await assert.rejects(readNativePhaseObservation(root, evalId, ref), /evidence changed/);
});
