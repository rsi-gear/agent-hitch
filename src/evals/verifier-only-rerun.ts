import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseTOML } from "smol-toml";
import { buildHarborRegradeConfig, runHarborRegrade } from "../backends/index.js";
import { benchmarkTreeDigest } from "../benchmarks/index.js";
import { useControllerRuntimeById } from "../controller-runtime/index.js";
import type { BenchmarkLockV1, EvalProgressV1, EvalRequest, EvalTrialRefV1 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, ensureDir, readJSON, sha256JSON, statePaths } from "../foundation/index.js";
import { loadRunRecord, verifyResultBundleIndex } from "../runs/index.js";
import { parseEvalExecutionPlan } from "./execution-plan.js";
import { runtimeResourcesForTask } from "./execution-plan-resources.js";
import { createExecutionLease } from "./execution-leases.js";
import { dockerOwnershipLabelMap, dockerResourceOwnership } from "./docker-ownership.js";
import { startDockerResourceObserver } from "./docker-resource-observer.js";
import { reapOwnedDockerResources } from "./docker-reaper.js";
import { replaceInvalidEvalProgressTrial, writeEvalProgress } from "./progress.js";
import { regradeTreeDigest, sealRegradeAssessment } from "./regrade-evidence.js";
import type { EvalRerunResult, RerunEvalOptions } from "./rerun-types.js";
import { evalRerunSemantics } from "./rerun-types.js";
import { invalidTrialSlots, uniqueTasks } from "./rerun-slots.js";
import type { EvalTrialSlot } from "./rerun-slots.js";
import { summarizeTrialRefs } from "./result-helpers.js";
import { validateEvalTrialReferences } from "./trial-import.js";
import { detectVerifierInfrastructureFailure, primaryVerifierReward, verifierObservation, verifierResult } from "./verifier-diagnostics.js";

interface Input extends RerunEvalOptions {
  evalDirectory: string; rerunId: string; rerunDirectory: string; startedAt: string;
  request: EvalRequest; progress: EvalProgressV1; previousResult: Record<string, unknown> | null;
  plan: { tasks: string[]; attempts: number; controllerRuntime: Record<string, unknown> };
  selectedTrials: EvalTrialSlot[];
}

/** Validate the immutable compiled package, also restoring its public identity
 * when the underlying local Harbor dataset has a different derived identity. */
export async function frozenRerunBenchmark(evalDirectory: string): Promise<{ id: string; revision: string; tasks: string } | null> {
  const pkg = await readJSON<{ source: string; tasks: string; package_digest: string; compiled_digest: string } | null>(path.join(evalDirectory, "benchmark/package.json"), null);
  if (!pkg) return null;
  // These tasks were already compiled by the pinned source runtime. Validate
  // its saved lock and bytes, without re-resolving them with today's loader.
  const lock = await readJSON<BenchmarkLockV1>(path.join(evalDirectory, "benchmark/benchmark.lock.json"));
  const compiled = await readJSON<{ digest: string; tasks_digest: string }>(path.join(path.dirname(pkg.tasks), "compiled.json"));
  if (lock.protocol !== "hitch-benchmark@1" || pkg.package_digest !== lock.package_digest
    || lock.package_digest !== sha256JSON(lock.files) || lock.package_digest !== await benchmarkTreeDigest(pkg.source)
    || compiled.digest !== pkg.compiled_digest
    || compiled.digest !== sha256JSON({ lock, compiler: "harbor-package@3" })
    || compiled.tasks_digest !== await benchmarkTreeDigest(pkg.tasks)) throw unavailable("compiled benchmark identity changed");
  return { id: lock.benchmark_id, revision: lock.package_digest, tasks: pkg.tasks };
}

export async function verifierOnlyEvalRerun(input: Input): Promise<EvalRerunResult> {
  const execution = parseEvalExecutionPlan(await readJSON(path.join(input.evalDirectory, "execution-plan.json")));
  const benchmark = await frozenRerunBenchmark(input.evalDirectory);
  if (!benchmark || execution.provider !== "local-docker" || execution.membership !== "known"
    || execution.eval_id !== input.evalId || benchmark.id !== input.request.benchmark_id || benchmark.revision !== input.request.benchmark_revision) {
    throw unavailable("verifier-only currently requires a frozen standard benchmark on local Docker");
  }
  const runtimeId = String(input.plan.controllerRuntime.runtime_id);
  const runtime = await useControllerRuntimeById(statePaths(input.root), runtimeId.replace(/^sha256:/, ""));
  if (runtime.runtime_id !== runtimeId || runtime.manifest_digest !== input.plan.controllerRuntime.manifest_digest) throw unavailable("controller runtime changed");
  let progress = input.progress;
  const repaired: EvalTrialSlot[] = [];
  const sources: NonNullable<EvalRerunResult["sources"]> = [];
  for (const slot of input.selectedTrials) {
    if (input.signal?.aborted) throw unavailable("verifier-only was aborted");
    const original = progress.trials.find(ref => ref.task_id === slot.task_id && ref.attempt === slot.attempt);
    if (!original || original.assessment || original.observation_status !== "invalid"
      || !["verifier_infrastructure_failure", "verifier_result_missing"].includes(original.invalid_reason ?? "")) throw unavailable("selected slot has no verifier-invalid original candidate");
    await validateEvalTrialReferences(input.root, input.evalId, [original], { benchmarkId: benchmark.id, benchmarkRevision: benchmark.revision });
    const runDirectory = path.join(statePaths(input.root).runs, original.run_id);
    const bundleIndex = await verifyResultBundleIndex(runDirectory);
    const candidate = await loadRunRecord(runDirectory, { verifyTrajectory: true });
    if (candidate.record.status !== "succeeded" || candidate.record_status !== "valid" || candidate.trajectory_status !== "valid") throw unavailable("candidate evidence is incomplete or corrupt");
    const plannedSlot = execution.slots.find(s => s.task_id === slot.task_id && s.attempt === slot.attempt);
    const work = plannedSlot && execution.work_items.find(w => w.slots.includes(plannedSlot.slot_id));
    if (!work || work.task_ids.length !== 1) throw unavailable("source has no isolated work item");
    const workDirectory = path.join(input.evalDirectory, "harbor/work-items", work.work_id);
    let sourceDirectory: string | undefined;
    for (const epoch of (await readdir(workDirectory)).filter(name => /^epoch-[0-9]{6}$/.test(name)).sort().reverse()) {
      const possible = path.join(workDirectory, epoch, "job", original.trial_id);
      const result = await readJSON<Record<string, unknown> | null>(path.join(possible, "result.json"), null);
      if (result?.trial_name === original.trial_id) { sourceDirectory = possible; break; }
    }
    if (!sourceDirectory) throw unavailable("original Harbor trial outputs are missing");
    const sourceConfig = await readJSON<Record<string, unknown>>(path.join(sourceDirectory, "config.json"));
    const sourceResult = await readJSON<Record<string, unknown>>(path.join(sourceDirectory, "result.json"));
    const agentResult = sourceResult.agent_result as { metadata?: { hitch_run_id?: string } } | undefined;
    if (agentResult?.metadata?.hitch_run_id !== original.run_id) throw unavailable("Harbor source candidate identity mismatch");
    const taskPath = path.join(benchmark.tasks, slot.task_id);
    if ((sourceConfig.task as { path?: string })?.path !== taskPath) throw unavailable("Harbor task identity mismatch");
    const task = parseTOML(await readFile(path.join(taskPath, "task.toml"), "utf8"));
    const taskName = (task.task as Record<string, unknown> | undefined)?.name ?? slot.task_id;
    if (sourceResult.task_name !== taskName) throw unavailable("Harbor task name mismatch");
    const verifier = task.verifier as Record<string, unknown> | undefined;
    if (task.steps || verifier?.environment_mode !== "separate") throw unavailable("artifact regrade requires a single-step task with its original separate verifier");
    const sourceDigest = await regradeTreeDigest(sourceDirectory);
    const taskDigest = await regradeTreeDigest(taskPath);
    const artifactsDigest = await regradeTreeDigest(path.join(sourceDirectory, "artifacts"));
    const assessmentId = `assessment_${randomUUID().replaceAll("-", "")}`;
    const directory = path.join(await ensureDir(path.join(input.evalDirectory, "assessments")), assessmentId);
    await mkdir(directory);
    const evidence = await ensureDir(path.join(directory, "evidence"));
    const artifactSnapshot = path.join(evidence, "source-artifacts");
    await cp(path.join(sourceDirectory, "artifacts"), artifactSnapshot, { recursive: true, force: false, errorOnExist: true });
    if (await regradeTreeDigest(artifactSnapshot) !== artifactsDigest) throw unavailable("source artifacts changed during capture");
    const source = { trial_id: original.trial_id, run_id: original.run_id, work_id: work.work_id,
      backend_directory: path.relative(input.evalDirectory, path.dirname(path.dirname(sourceDirectory))).split(path.sep).join("/"),
      bundle_index_digest: sha256JSON(bundleIndex), trial_tree_digest: sourceDigest, artifacts_digest: artifactsDigest, task_tree_digest: taskDigest,
      artifact_capture_at: new Date().toISOString() };
    await atomicWriteJSON(path.join(evidence, "source.json"), source);
    sources.push({ source_trial_id: original.trial_id, source_run_id: original.run_id, source_work_id: work.work_id, source_backend_directory: source.backend_directory });
    const lease = await createExecutionLease({ evalDirectory: input.evalDirectory, evalId: input.evalId,
      workId: `work_${randomUUID().replaceAll("-", "")}`, worker: { workerId: "local-regrade", provider: "local-docker", collisionDomainId: "local-docker" },
      reservation: work.reservation, ttlMs: 45_000 });
    const ownership = dockerResourceOwnership(input.root, lease.current(), slot.task_id);
    const resources = runtimeResourcesForTask(execution, slot.task_id, work.reservation);
    const env = input.env ?? process.env;
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const heartbeat = setInterval(() => { void lease.heartbeat().catch(() => controller.abort()); }, 10_000);
    heartbeat.unref();
    const observer = startDockerResourceObserver({ ownership, workerId: "local-regrade", collisionDomainId: "local-docker", reservation: work.reservation,
      mainLimits: resources.mainLimits, sidecarLimits: resources.sidecarLimits, env, intervalMs: 1000 });
    const trialName = `${slot.task_id.slice(0, 32)}__regrade_${assessmentId.slice(-12)}`;
    let config: Record<string, unknown>;
    let outcome: Awaited<ReturnType<typeof runHarborRegrade>>;
    try {
      config = buildHarborRegradeConfig({ sourceConfig, sourceResult, sourceDirectory, outputDirectory: path.join(evidence, "trials"), trialName, ownershipLabels: dockerOwnershipLabelMap(ownership) });
      await lease.markRunning();
      outcome = await runHarborRegrade({ root: input.root, directory: evidence, config, runtimeDirectory: runtime.directory, env,
        ...(input.harborExecutable ? { harborExecutable: input.harborExecutable } : {}), signal });
    } finally {
      clearInterval(heartbeat);
      await atomicWriteJSON(path.join(evidence, "execution.json"), await observer.stop());
      await lease.release();
      await atomicWriteJSON(path.join(evidence, "cleanup.json"), await reapOwnedDockerResources({ root: input.root, env, leaseIds: [lease.leaseId] }));
    }
    if (sourceDigest !== await regradeTreeDigest(sourceDirectory) || taskDigest !== await regradeTreeDigest(taskPath)
      || sha256JSON(await verifyResultBundleIndex(runDirectory)) !== source.bundle_index_digest) throw unavailable("regrade source changed during verification");
    const trialDirectory = path.join(String(config.trials_dir), trialName);
    if (outcome.trial.trial_name !== trialName || outcome.trial.task_name !== taskName
      || sha256JSON(outcome.trial.agent_result) !== sha256JSON(sourceResult.agent_result)) throw unavailable("regrade result candidate identity changed");
    const result = verifierResult(outcome.trial);
    if (result) await atomicWriteJSON(path.join(evidence, "verifier-result.json"), result);
    const observation = verifierObservation({ trial: outcome.backend.process_exit_code === 0 ? outcome.trial : { ...outcome.trial, exception_info: "harbor-process-failed" },
      runStatus: candidate.record.status, trajectoryStatus: candidate.trajectory_status, recordStatus: candidate.record_status,
      verifierRef: result ? "evidence/verifier-result.json" : undefined,
      infrastructure: await detectVerifierInfrastructureFailure(trialDirectory, primaryVerifierReward(outcome.trial)) });
    const assessment = await sealRegradeAssessment(directory, { eval_id: input.evalId, task_id: slot.task_id, attempt: slot.attempt, rerun_id: input.rerunId,
      source, controller_runtime_id: runtimeId, backend: outcome.backend, observation, completed_at: new Date().toISOString() });
    if (observation.status === "valid") {
      const ref: EvalTrialRefV1 = { trial_id: original.trial_id, run_id: original.run_id, task_id: slot.task_id, attempt: slot.attempt,
        observation_status: "valid", reward: observation.reward!, verifier_result_ref: observation.verifier_result_ref!, assessment };
      await validateEvalTrialReferences(input.root, input.evalId, [ref], { benchmarkId: benchmark.id, benchmarkRevision: benchmark.revision });
      progress = replaceInvalidEvalProgressTrial(progress, ref);
      await writeEvalProgress(input.evalDirectory, progress);
      repaired.push(slot);
    }
  }
  const remaining = invalidTrialSlots(input.plan.tasks, input.plan.attempts, progress);
  const completed = new Date().toISOString();
  const output: EvalRerunResult = { schema_version: "1", kind: "eval-rerun", rerun_id: input.rerunId, rerun_type: "verifier-only", semantics: evalRerunSemantics("verifier-only"),
    eval_id: input.evalId, status: "completed", selected_tasks: uniqueTasks(input.selectedTrials), selected_trials: input.selectedTrials,
    repaired_tasks: uniqueTasks(repaired), repaired_trials: repaired, remaining_invalid_tasks: uniqueTasks(remaining), remaining_invalid_trials: remaining, sources,
    eval_status: remaining.length ? "failed" : "succeeded", started_at: input.startedAt, completed_at: completed };
  const result = { ...input.previousResult, status: output.eval_status, exit_code: remaining.length ? 13 : 0, generation: progress.generation,
    trials: progress.trials, summary: summarizeTrialRefs(progress.trials), completed_at: completed };
  if (!remaining.length) delete (result as Record<string, unknown>).error;
  await atomicWriteJSON(path.join(input.evalDirectory, "result.json"), result);
  await atomicWriteJSON(path.join(input.rerunDirectory, "state.json"), { ...output, tasks: output.selected_tasks, trials: input.selectedTrials, updated_at: completed });
  return output;
}

function unavailable(message: string): HitchError { return new HitchError(message, { code: "eval_verifier_only_unavailable", exitCode: 2 }); }
