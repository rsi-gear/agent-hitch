import { cp, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { benchmarkTreeDigest } from "../benchmarks/index.js";
import type { BenchmarkLockV1, BenchmarkManifestV1, BenchmarkPhaseGroupV1, BenchmarkTaskV1, EvalTrialRefV1, RunObservationV1 } from "../domain/index.js";
import { parseVerifierScores, validateRunObservation } from "../domain/index.js";
import { atomicWriteJSON, ensureDir, readJSON, sha256Bytes, sha256JSON, statePaths, withFileLock } from "../foundation/index.js";
import { benchmarkVerifierIdentity, copySealedPhaseRunBundle, defaultModelIdentity, inspectSealedPhaseRunBundle, readBenchmarkPhaseGroup, sealBenchmarkPhaseGroup } from "../runs/index.js";
import { parseHarnessReference } from "../revisions/index.js";
import type { ImportEvalRunOptions } from "./trial-import.js";
import { regradeTreeDigest } from "./regrade-evidence.js";
import { detectVerifierInfrastructureFailure, primaryVerifierReward, verifierObservation, verifierResult } from "./verifier-diagnostics.js";
import { importTrialInteractionCapture } from "./interaction-capture-import.js";
import { writeTrialExecutionEvidence } from "./trial-execution-evidence.js";
import { writeTrialEnvironmentImageEvidence } from "./trial-environment-evidence.js";
import { writeEvalTrialPublication } from "./trial-publication.js";
import { loadBenchmarkAdapterManifest } from "./benchmark-adapter-manifest.js";

type RecordValue = Record<string, unknown>;
interface PhaseTrialInput extends ImportEvalRunOptions {
  trial: RecordValue; taskId: string; trialId: string; attempt: number; trialDirectory: string;
}
export interface NativePhaseDescriptor {
  task: BenchmarkTaskV1;
  task_digest: string;
  primary_metric: string;
  metrics: BenchmarkManifestV1["metrics"];
  audit_path: string;
  agent_timeout_ms: number;
  standard_total_range?: readonly [number, number];
}
export class NativePhaseBundlePendingError extends Error {}

function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid native phase evidence object");
  return value as RecordValue;
}
async function bytes(directory: string, relative: string, maximum = 16 * 1024 * 1024): Promise<Buffer> {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === "." || part === "..")) throw new Error("invalid native evidence path");
  const root = await realpath(directory), file = path.join(root, relative);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum || await realpath(file) !== file) throw new Error("invalid native evidence file");
  return readFile(file);
}
async function json(directory: string, relative: string): Promise<RecordValue> {
  return object(JSON.parse((await bytes(directory, relative)).toString("utf8")));
}

/** The private descriptor must belong to the immutable compiled package. */
export async function nativePhaseDescriptor(input: ImportEvalRunOptions, taskId: string): Promise<NativePhaseDescriptor | null> {
  const pkg = await readJSON<{ tasks: string; source: string; package_digest: string; compiled_digest: string } | null>(path.join(input.evalDirectory, "benchmark/package.json"), null);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(taskId)) return null;
  if (!pkg) {
    if (typeof input.request.dataset !== "string" || !input.request.dataset) return null;
    const manifest = await loadBenchmarkAdapterManifest(input.request.dataset);
    if (!manifest || manifest.benchmark.id !== input.benchmarkId || manifest.dataset_digest !== input.benchmarkRevision) return null;
    const descriptor = await readJSON<RecordValue | null>(path.join(input.request.dataset, taskId, ".hitch-benchmark.json"), null);
    if (!descriptor) return null;
    const task = descriptor.task as BenchmarkTaskV1;
    if (task?.driver?.kind !== "tool-server" || !task.driver.config.native_phases) return null;
    const contract = descriptor.score_contract as RecordValue | undefined;
    if (descriptor.task_id !== taskId || typeof descriptor.task_digest !== "string"
      || descriptor.primary_metric !== manifest.scoring.total_score.source_metric
      || !contract || Object.keys(contract).length !== 1 || contract.total_score !== descriptor.primary_metric) {
      throw new Error("native standardized descriptor is invalid");
    }
    return {
      task,
      task_digest: descriptor.task_digest,
      primary_metric: String(descriptor.primary_metric),
      metrics: descriptor.metrics as BenchmarkManifestV1["metrics"],
      audit_path: task.driver.config.native_phases.audit_path,
      agent_timeout_ms: Number(descriptor.agent_timeout_sec) * 1000,
      standard_total_range: manifest.scoring.total_score.range,
    };
  }
  const descriptor = await readJSON<RecordValue | null>(path.join(pkg.tasks, taskId, ".hitch-benchmark.json"), null);
  if (!descriptor) return null;
  const task = descriptor.task as BenchmarkTaskV1;
  if (task?.driver?.kind !== "tool-server" || !task.driver.config.native_phases) return null;
  const lock = await readJSON<BenchmarkLockV1>(path.join(input.evalDirectory, "benchmark/benchmark.lock.json"));
  const compiled = await readJSON<{ digest: string; tasks_digest: string }>(path.join(path.dirname(pkg.tasks), "compiled.json"));
  const lockedTask = lock.tasks.find(item => item.task_id === taskId);
  const standardCompiler = compiled.digest === sha256JSON({ lock, compiler: "harbor-package@6" });
  const standardManifest = standardCompiler ? await loadBenchmarkAdapterManifest(pkg.tasks) : null;
  const revisionMatches = standardManifest
    ? standardManifest.benchmark.id === input.benchmarkId && standardManifest.dataset_digest === input.benchmarkRevision
    : lock.package_digest === input.benchmarkRevision;
  if (lock.protocol !== "hitch-benchmark@1" || lock.benchmark_id !== input.benchmarkId || !revisionMatches
    || pkg.package_digest !== lock.package_digest || lock.package_digest !== sha256JSON(lock.files)
    || lock.package_digest !== await benchmarkTreeDigest(pkg.source) || compiled.digest !== pkg.compiled_digest
    || !["harbor-package@4", "harbor-package@5", "harbor-package@6"].some(compiler => compiled.digest === sha256JSON({ lock, compiler })) || compiled.tasks_digest !== await benchmarkTreeDigest(pkg.tasks)
    || !lockedTask || descriptor.task_digest !== lockedTask.task_digest || descriptor.package_digest !== lock.package_digest
    || descriptor.task_id !== taskId || task.source_task_id !== lockedTask.source_task_id) throw new Error("native compiled benchmark identity changed");
  return { task, task_digest: lockedTask.task_digest, primary_metric: String(descriptor.primary_metric),
    metrics: descriptor.metrics as BenchmarkManifestV1["metrics"], audit_path: task.driver.config.native_phases.audit_path,
    agent_timeout_ms: Number(descriptor.agent_timeout_sec) * 1000,
    ...(standardManifest ? { standard_total_range: standardManifest.scoring.total_score.range } : {}) };
}

function budgetReceipt(supervision: RecordValue, protocol: unknown): RecordValue | undefined {
  if (!supervision.budget_finalization) return undefined;
  const finalization = object(supervision.budget_finalization), receipt = object(finalization.receipt);
  const started = Date.parse(String(supervision.started_at)), requested = Date.parse(String(finalization.requested_at));
  if (protocol !== "hitch-native-phase-control@2" || finalization.status !== "completed" || receipt.budget_exhausted !== true
    || !Number.isSafeInteger(supervision.timeout_ms) || Number(supervision.timeout_ms) <= 0 || !Number.isFinite(started) || !Number.isFinite(requested)
    || !Number.isSafeInteger(finalization.elapsed_ms) || Number(finalization.elapsed_ms) < Number(supervision.timeout_ms)
    || typeof receipt.pending_prediction !== "boolean" || typeof receipt.action_submitted !== "boolean") throw new Error("native deadline finalization is unproven");
  return receipt;
}

/** Verify the independently collected channel, not a caller-selected group prefix. */
async function verifyNativeChannel(artifacts: string, auditPath: string, group: BenchmarkPhaseGroupV1, supervision: RecordValue, protocol: unknown): Promise<void> {
  const relative = auditPath.replace(/^\//, "");
  const text = (await bytes(artifacts, relative, 128 * 1024 * 1024)).toString("utf8");
  if (!text.endsWith("\n")) throw new Error("native channel audit is incomplete");
  const lines = text.trimEnd().split("\n");
  if (lines.length > 100_000) throw new Error("native channel audit exceeds limits");
  let generation = 0, sequence = 0, bound = false, pending = false, completed = false;
  const phases = supervision.phases as RecordValue[];
  const first = new Set<number>(), bindings = new Set<number>(), receipt = budgetReceipt(supervision, protocol);
  let budgetSeen = false;
  for (const line of lines) {
    if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error("native channel record exceeds limits");
    const event = object(JSON.parse(line));
    if (completed || budgetSeen && event.event !== "completed" || !Number.isSafeInteger(event.generation) || !Number.isSafeInteger(event.sequence)) throw new Error("native channel sequence is invalid");
    if (event.event === "context_required") {
      if (pending || generation > 0 && !bound || event.generation !== generation + 1 || event.sequence !== sequence
        || generation >= group.phases.length + (receipt ? 1 : 0)) throw new Error("native phase coverage mismatch");
      generation += 1; bound = false;
      if (generation > 1) {
        const boundary = object(phases[generation - 2]!.boundary);
        const finalDeadlineBoundary = receipt && generation === group.phases.length + 1 && boundary.state === "completed";
        if ((!finalDeadlineBoundary && boundary.state !== "context_required") || boundary.generation !== generation || !Number.isSafeInteger(boundary.sequence)
          || Number(boundary.sequence) < sequence || Number(boundary.sequence) > sequence + 1) throw new Error("supervisor reset differs from native audit");
      }
      continue;
    }
    if (event.generation !== generation || generation < 1 || event.sequence !== (event.event === "prediction" ? sequence + 1 : sequence)) throw new Error("native audit generation or sequence mismatch");
    if (event.event === "prediction") {
      if (pending || typeof event.screenshot_file !== "string" || !/^observation-[0-9]{6,}\.png$/.test(event.screenshot_file)
        || typeof event.screenshot_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(event.screenshot_sha256)) throw new Error("invalid native prediction");
      sequence += 1; pending = true;
      const screenshot = await bytes(artifacts, path.posix.join(path.posix.dirname(relative), event.screenshot_file), 4 * 1024 * 1024);
      if (sha256Bytes(screenshot) !== `sha256:${event.screenshot_sha256}`) throw new Error("native screenshot changed");
      if (!first.has(generation)) {
        const phase = phases[generation - 1];
        if (phase && (phase.first_prediction_sequence !== sequence || phase.first_screenshot_sha256 !== event.screenshot_sha256)) throw new Error("supervisor first prediction differs from native audit");
        if (!phase && (!receipt || generation !== group.phases.length + 1)) throw new Error("unrepresented native candidate phase");
        first.add(generation);
      }
    } else if (event.event === "context_bound") {
      if (!pending || bound || !group.phases[generation - 1] || event.run_id !== group.phases[generation - 1]!.run_id) throw new Error("native binding differs from phase group");
      bound = true; bindings.add(generation);
    } else if (event.event === "action_submitted") {
      if (!pending || !bound || event.run_id !== group.phases[generation - 1]!.run_id) throw new Error("native action has no matching bound prediction");
      pending = false;
    } else if (event.event === "budget_exhausted") {
      const expected = { event: "budget_exhausted", generation, sequence, run_id: bound ? group.phases[generation - 1]!.run_id : null,
        pending_prediction: pending || event.action_submitted === true, action_submitted: event.action_submitted };
      const { event: _event, ...fields } = expected;
      if (!receipt || !isDeepStrictEqual(event, expected) || event.action_submitted === true && (!bound || pending)
        || !isDeepStrictEqual(receipt, { ...fields, budget_exhausted: true })) throw new Error("native deadline receipt differs from audit");
      pending = false; budgetSeen = true;
    } else if (event.event === "completed") {
      if (pending || !budgetSeen && (!bound || generation !== group.phases.length)
        || budgetSeen && (generation < group.phases.length || generation > group.phases.length + 1)) throw new Error("native completion is incomplete");
      const boundary = object(budgetSeen ? supervision.final_native_state : phases[generation - 1]!.boundary);
      if (boundary.state !== "completed" || boundary.generation !== generation || boundary.sequence !== sequence) throw new Error("supervisor completion differs from native audit");
      completed = true;
    } else throw new Error("native channel did not complete normally");
  }
  if (!completed || Boolean(receipt) !== budgetSeen || group.phases.some((_, i) => !first.has(i + 1) || !bindings.has(i + 1))) throw new Error("native channel does not prove all phases completed");
}

interface MetricContract {
  task_digest: string; source_task_id: string; primary_metric: string;
  metrics: BenchmarkManifestV1["metrics"]; metric_map: Record<string, string>;
}
function metricContract(descriptor: NativePhaseDescriptor): MetricContract {
  return { task_digest: descriptor.task_digest, source_task_id: descriptor.task.source_task_id, primary_metric: descriptor.primary_metric,
    metrics: descriptor.metrics, metric_map: descriptor.task.grading.metric_map };
}
function verifyMetrics(value: RecordValue, descriptor: MetricContract, reward: number | undefined): void {
  const metrics = object(value.metrics), raw = object(value.raw);
  if (value.primary_metric !== descriptor.primary_metric || value.source_task_id !== descriptor.source_task_id || value.task_digest !== descriptor.task_digest
    || !isDeepStrictEqual(Object.keys(metrics).sort(), Object.keys(descriptor.metrics).sort())) throw new Error("native metric identity mismatch");
  for (const [name, spec] of Object.entries(descriptor.metrics)) {
    const score = metrics[name];
    if (typeof score !== "number" || !Number.isFinite(score) || score < spec.range[0] || score > spec.range[1]
      || spec.type === "binary" && score !== 0 && score !== 1 || score !== raw[descriptor.metric_map[name]!]) throw new Error("native metric is invalid");
  }
  if (metrics[descriptor.primary_metric] !== reward) throw new Error("native primary metric differs from Harbor reward");
}

function verifyReplacements(receipts: RecordValue[], group: BenchmarkPhaseGroupV1, service: string, unusedReplacement = false): void {
  if (receipts.length !== group.phases.length - 1 + Number(unusedReplacement)) throw new Error("candidate retirement receipts are incomplete");
  let previous: RecordValue | undefined;
  const candidates = new Set<string>();
  for (const [offset, receipt] of receipts.entries()) {
    const ownership = object(receipt.ownership), sidecars = object(receipt.sidecars);
    if (receipt.schema_version !== "hitch-candidate-recycle@1" || receipt.scope !== "environment-only" || receipt.status !== "completed" || receipt.phase_index !== offset + 1
      || !/^[a-f0-9]{64}$/.test(String(receipt.old_container_id)) || !/^[a-f0-9]{64}$/.test(String(receipt.new_container_id)) || receipt.old_container_id === receipt.new_container_id
      || !/^sha256:[a-f0-9]{64}$/.test(String(receipt.image)) || !/^sha256:[a-f0-9]{64}$/.test(String(receipt.configuration_digest))
      || ownership["io.hitch.eval-id"] !== group.eval_id || ownership["io.hitch.task-id"] !== group.task_id
      || typeof ownership["io.hitch.lease-id"] !== "string" || !ownership["io.hitch.lease-id"] || !/^[1-9][0-9]*$/.test(String(ownership["io.hitch.lease-epoch"]))
      || !sidecars[service] || object(receipt.archives)["/logs/agent"] !== `phase-${String(offset + 1).padStart(4, "0")}/agent`) throw new Error("candidate retirement identity mismatch");
    for (const value of Object.values(sidecars)) {
      const sidecar = object(value);
      if (!/^[a-f0-9]{64}$/.test(String(sidecar.id)) || !/^sha256:[a-f0-9]{64}$/.test(String(sidecar.image))
        || !Number.isFinite(Date.parse(String(sidecar.started_at))) || sidecar.id === receipt.old_container_id || sidecar.id === receipt.new_container_id) throw new Error("invalid preserved native sidecar");
    }
    if (previous && (previous.new_container_id !== receipt.old_container_id || previous.image !== receipt.image || previous.configuration_digest !== receipt.configuration_digest
      || !isDeepStrictEqual(previous.ownership, ownership) || !isDeepStrictEqual(previous.sidecars, sidecars))) throw new Error("native environment changed across phase replacements");
    if (!previous) candidates.add(String(receipt.old_container_id));
    if (candidates.has(String(receipt.new_container_id))) throw new Error("candidate container identity reused");
    candidates.add(String(receipt.new_container_id)); previous = receipt;
  }
}

export async function importNativePhaseTrial(input: PhaseTrialInput, descriptor: NativePhaseDescriptor): Promise<EvalTrialRefV1> {
  let supervision: RecordValue;
  try { supervision = await json(input.trialDirectory, "hitch-native-phases/supervision.json"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && input.requireCompleteMarker && !input.allowMissingBundleDiagnostic) throw new NativePhaseBundlePendingError();
    throw error;
  }
  if (supervision.status === "running" && input.requireCompleteMarker && !input.allowMissingBundleDiagnostic) throw new NativePhaseBundlePendingError();
  if (supervision.schema_version !== "hitch-native-phase-supervision@1" || supervision.scope !== "candidate-evidence-only" || supervision.status !== "completed"
    || supervision.task_digest !== descriptor.task_digest || typeof supervision.run_group_id !== "string" || !/^run_group_[a-f0-9]{32}$/.test(supervision.run_group_id)
    || !Array.isArray(supervision.phases) || !supervision.phases.length || supervision.phases.length > 10000) throw new Error("native phase supervision is incomplete");
  const phases = supervision.phases.map(object);
  const control = descriptor.task.driver.kind === "tool-server" ? descriptor.task.driver.config.native_phases! : undefined;
  const deadline = budgetReceipt(supervision, control?.protocol);
  if (deadline && (supervision.timeout_ms !== Math.min(descriptor.agent_timeout_ms, input.request.timeout_ms > 0 ? input.request.timeout_ms : descriptor.agent_timeout_ms)
    || object(supervision.budget_finalization).timeout_ms !== control?.finalization_timeout_ms)) throw new Error("native deadline differs from frozen task budget");
  const unusedReplacement = Boolean(deadline && phases[phases.length - 1]!.replacement_receipt_ref);
  const runIds: string[] = [];
  const runs = await ensureDir(statePaths(input.root).runs);
  for (const [offset, phase] of phases.entries()) {
    const source = offset === phases.length - 1 && !unusedReplacement ? "agent/hitch-run-bundle" : `hitch-candidate-phases/phase-${String(offset + 1).padStart(4, "0")}/agent/hitch-run-bundle`;
    if (phase.phase_index !== offset + 1 || phase.generation !== offset + 1 || phase.status !== "sealed" || phase.bundle_ref !== source
      || typeof phase.run_id !== "string" || !/^run_[a-f0-9]{32}$/.test(phase.run_id) || runIds.includes(phase.run_id)) throw new Error("invalid phase group membership");
    const expected = { run_id: phase.run_id, revision_identity: input.resolvedRevision.identity,
      context: { kind: "benchmark_phase", benchmark_id: input.benchmarkId, benchmark_revision: input.benchmarkRevision,
        task_id: input.taskId, task_digest: descriptor.task_digest, verifier_identity: benchmarkVerifierIdentity(input.benchmarkId, input.benchmarkRevision),
        run_group_id: supervision.run_group_id, phase_index: offset + 1 },
      parent: { kind: "eval", eval_id: input.evalId, trial_id: input.trialId, attempt: input.attempt } };
    const sourceDirectory = path.join(input.trialDirectory, source);
    const proof = await inspectSealedPhaseRunBundle({ sourceDirectory, expected });
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(proof)), phase.evidence)) throw new Error("phase bundle proof differs from supervisor");
    if (proof.model.requested_id !== defaultModelIdentity(input.request.model, input.resolvedRevision.harness_id).requested_id) throw new Error("phase model differs from the frozen candidate");
    if (parseHarnessReference(proof.harness.requested_ref).canonical !== parseHarnessReference(input.request.harness_ref).canonical) throw new Error("phase harness reference differs from the frozen candidate");
    if (!["succeeded", "cancelled"].includes(proof.process_status) && !(deadline && offset === phases.length - 1 && proof.process_status === "timed_out")) throw new Error("native phase candidate did not finish or cancel at its boundary");
    const destinationDirectory = path.join(runs, phase.run_id);
    await withFileLock(path.join(statePaths(input.root).temporary, "phase-import-locks"), phase.run_id, async () => {
      try {
        const existing = await inspectSealedPhaseRunBundle({ sourceDirectory: destinationDirectory, expected });
        if (!isDeepStrictEqual(existing, proof)) throw new Error("existing phase run conflicts with exported evidence");
      } catch (error) {
        // Only an absent destination may be created. Never repair/reseal a
        // partial existing run as a side effect of an import retry.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try { await lstat(destinationDirectory); throw new Error("existing phase destination is incomplete"); }
        catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing; }
        await copySealedPhaseRunBundle({ sourceDirectory, destinationDirectory, expected });
      }
    });
    runIds.push(phase.run_id);
  }
  const reference = await sealBenchmarkPhaseGroup({ root: input.root, runIds });
  const group = await readBenchmarkPhaseGroup({ root: input.root, evalId: input.evalId, reference });
  const receipts: RecordValue[] = [];
  for (let index = 0; index < phases.length - 1 + Number(unusedReplacement); index++) {
    const ref = `hitch-candidate-phases/phase-${String(index + 1).padStart(4, "0")}/receipt.json`;
    if (phases[index]!.replacement_receipt_ref !== ref) throw new Error("candidate retirement receipt reference mismatch");
    receipts.push(await json(input.trialDirectory, ref));
  }
  const service = descriptor.task.driver.kind === "tool-server" ? descriptor.task.driver.config.service : "";
  verifyReplacements(receipts, group, service, unusedReplacement);
  await verifyNativeChannel(path.join(input.trialDirectory, "artifacts"), descriptor.audit_path, group, supervision, control?.protocol);
  const lifecycle = await json(input.trialDirectory, "benchmark-lifecycle.json");
  if (lifecycle.failure || !["prepare", "quiesce", "snapshot"].every(name => object(object(lifecycle.phases)[name]).status === "ok")) throw new Error("native lifecycle snapshot is incomplete");
  const reward = primaryVerifierReward(input.trial);
  const verifier = verifierResult(input.trial);
  const infrastructure = await detectVerifierInfrastructureFailure(input.trialDirectory, reward);
  // The independent native task completed; phase process statuses remain
  // unchanged in their bundles (often cancelled at a native boundary).
  const observation = verifierObservation({ trial: input.trial, runStatus: "succeeded", trajectoryStatus: "valid", recordStatus: "valid",
    verifierRef: verifier ? "evidence/verifier/result.json" : undefined, infrastructure });
  const scores = observation.status === "valid" && descriptor.standard_total_range !== undefined ? parseVerifierScores(verifier) : undefined;
  if (observation.status === "valid" && descriptor.standard_total_range !== undefined && (!scores || scores.normalization !== "standard"
    || scores.process_score !== undefined || scores.total_score !== reward
    || scores.total_score < descriptor.standard_total_range[0] || scores.total_score > descriptor.standard_total_range[1])) {
    throw new Error("native standardized score contract is invalid");
  }
  const publishedScores = observation.status === "valid" ? scores : undefined;
  const contract = metricContract(descriptor);
  if (observation.status === "valid") verifyMetrics(await json(input.trialDirectory, "verifier/benchmark-rewards.json"), contract, reward);
  const artifactsDigest = await regradeTreeDigest(path.join(input.trialDirectory, "artifacts"));
  const verifierDigest = await regradeTreeDigest(path.join(input.trialDirectory, "verifier"));
  const sourceDigest = sha256JSON({ supervision, lifecycle, receipts, verifier, observation, artifacts: artifactsDigest, verifier_files: verifierDigest });
  const id = "assessment_" + sha256JSON({ eval: input.evalId, trial: input.trialId, group: reference }).slice(7, 39);
  const directory = path.join(await ensureDir(path.join(input.evalDirectory, "assessments")), id);
  return withFileLock(path.join(statePaths(input.root).temporary, "phase-assessment-locks"), id, async () => {
    const existing = await readJSON<RecordValue | null>(path.join(directory, "assessment.json"), null);
    if (existing) {
      if (existing.source_digest !== sourceDigest) throw new Error("native assessment source changed after publication");
      const ref = trialRef(input, reference, { id, digest: sha256Bytes(await bytes(directory, "assessment.json")) }, observation, publishedScores);
      await readNativePhaseObservation(input.root, input.evalId, ref);
      return ref;
    }
    await mkdir(directory); // No overwrite, including an incomplete prior import.
    const evidence = await ensureDir(path.join(directory, "evidence"));
    await cp(path.join(input.trialDirectory, "artifacts"), path.join(evidence, "artifacts"), { recursive: true, force: false, errorOnExist: true });
    await cp(path.join(input.trialDirectory, "verifier"), path.join(evidence, "verifier"), { recursive: true, force: false, errorOnExist: true });
    if (await regradeTreeDigest(path.join(evidence, "artifacts")) !== artifactsDigest || await regradeTreeDigest(path.join(input.trialDirectory, "artifacts")) !== artifactsDigest
      || await regradeTreeDigest(path.join(evidence, "verifier")) !== verifierDigest || await regradeTreeDigest(path.join(input.trialDirectory, "verifier")) !== verifierDigest
      || !isDeepStrictEqual(await json(input.trialDirectory, "hitch-native-phases/supervision.json"), supervision)
      || !isDeepStrictEqual(await json(input.trialDirectory, "benchmark-lifecycle.json"), lifecycle)) throw new Error("native assessment source changed during capture");
    await atomicWriteJSON(path.join(evidence, "supervision.json"), supervision);
    await atomicWriteJSON(path.join(evidence, "benchmark-lifecycle.json"), lifecycle);
    await atomicWriteJSON(path.join(evidence, "candidate-replacements.json"), { receipts });
    if (observation.status === "valid") verifyMetrics(await json(evidence, "verifier/benchmark-rewards.json"), contract, reward);
    if (verifier) await atomicWriteJSON(path.join(evidence, "verifier/result.json"), verifier);
    for (const runId of runIds) await importTrialInteractionCapture(input, runId, await ensureDir(path.join(evidence, "phase-captures", runId)));
    await writeTrialExecutionEvidence(evidence, input.executionEvidence, { evalId: input.evalId, taskId: input.taskId });
    await writeTrialEnvironmentImageEvidence(evidence, input.taskId, input.environmentImages);
    await verifyNativeChannel(path.join(evidence, "artifacts"), descriptor.audit_path, group, supervision, control?.protocol);
    const record = { schema_version: "1", kind: "native-phase-assessment", eval_id: input.evalId, trial_id: input.trialId,
      task_id: input.taskId, attempt: input.attempt, benchmark_id: input.benchmarkId, benchmark_revision: input.benchmarkRevision,
      task_digest: descriptor.task_digest, verifier_identity: group.verifier_identity, run_group: reference, observation,
      ...(publishedScores === undefined ? {} : { scores: publishedScores }),
      publication_mode: input.publicationMode ?? "settle",
      metric_contract: contract, controller_service: service, native_control_protocol: control?.protocol, unused_candidate_replacement: unusedReplacement,
      native_audit_path: descriptor.audit_path, source_digest: sourceDigest, evidence_digest: await regradeTreeDigest(evidence), created_at: new Date().toISOString() };
    await atomicWriteJSON(path.join(directory, "assessment.json"), record);
    const ref = trialRef(input, reference, { id, digest: sha256Bytes(await bytes(directory, "assessment.json")) }, observation, publishedScores);
    await readNativePhaseObservation(input.root, input.evalId, ref);
    // Publication is separate from every original candidate bundle.
    await writeEvalTrialPublication(directory, input.evalId, input.publicationMode ?? "settle", ref);
    return ref;
  });
}

function trialRef(input: PhaseTrialInput, group: NonNullable<EvalTrialRefV1["run_group"]>, assessment: NonNullable<EvalTrialRefV1["assessment"]>, observation: RunObservationV1, scores?: EvalTrialRefV1["scores"]): EvalTrialRefV1 {
  return { trial_id: input.trialId, task_id: input.taskId, attempt: input.attempt, run_group: group, assessment,
    observation_status: observation.status, ...(observation.reward !== undefined ? { reward: observation.reward } : {}),
    ...(scores === undefined ? {} : { scores }),
    ...(observation.invalid_reason ? { invalid_reason: observation.invalid_reason } : {}),
    ...(observation.verifier_result_ref ? { verifier_result_ref: observation.verifier_result_ref } : {}) };
}

export async function readNativePhaseObservation(root: string, evalId: string, trial: EvalTrialRefV1,
  expected?: { benchmarkId: string; benchmarkRevision: string }): Promise<RunObservationV1> {
  if (!trial.run_group || trial.run_id !== undefined || !trial.assessment || !/^assessment_[a-f0-9]{32}$/.test(trial.assessment.id)) throw new Error("invalid native phase assessment reference");
  const directory = path.join(statePaths(root).evals, evalId, "assessments", trial.assessment.id);
  const raw = await bytes(directory, "assessment.json");
  if (sha256Bytes(raw) !== trial.assessment.digest) throw new Error("native assessment digest mismatch");
  const record = object(JSON.parse(raw.toString("utf8")));
  const group = await readBenchmarkPhaseGroup({ root, evalId, reference: trial.run_group });
  if (record.schema_version !== "1" || record.kind !== "native-phase-assessment" || record.eval_id !== evalId || record.trial_id !== trial.trial_id
    || record.task_id !== trial.task_id || record.attempt !== trial.attempt || !isDeepStrictEqual(record.run_group, trial.run_group)
    || group.trial_id !== trial.trial_id || group.task_id !== trial.task_id || group.attempt !== trial.attempt || group.task_digest !== record.task_digest
    || group.benchmark_id !== record.benchmark_id || group.benchmark_revision !== record.benchmark_revision || group.verifier_identity !== record.verifier_identity
    || expected && (group.benchmark_id !== expected.benchmarkId || group.benchmark_revision !== expected.benchmarkRevision
      || group.verifier_identity !== benchmarkVerifierIdentity(expected.benchmarkId, expected.benchmarkRevision))) throw new Error("native assessment identity mismatch");
  if (record.evidence_digest !== await regradeTreeDigest(path.join(directory, "evidence"))) throw new Error("native assessment evidence changed");
  const supervision = await json(path.join(directory, "evidence"), "supervision.json");
  await verifyNativeChannel(path.join(directory, "evidence/artifacts"), String(record.native_audit_path), group, supervision, record.native_control_protocol);
  const receipts = await json(path.join(directory, "evidence"), "candidate-replacements.json");
  if (!Array.isArray(receipts.receipts)) throw new Error("missing candidate replacement evidence");
  verifyReplacements(receipts.receipts.map(object), group, String(record.controller_service), record.unused_candidate_replacement === true);
  const observation = validateRunObservation(record.observation);
  if (observation.status === "valid") verifyMetrics(await json(path.join(directory, "evidence"), "verifier/benchmark-rewards.json"), record.metric_contract as MetricContract, observation.reward);
  if (!isDeepStrictEqual(record.scores, trial.scores)) throw new Error("native assessment score channels mismatch");
  if (trial.scores !== undefined) {
    const result = await json(path.join(directory, "evidence"), "verifier/result.json");
    if (!isDeepStrictEqual(parseVerifierScores(result), trial.scores)) throw new Error("native assessment score evidence mismatch");
  }
  return observation;
}
