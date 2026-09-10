import { cp } from "node:fs/promises";
import path from "node:path";
import type { BackendWorkItemV1, EvalExecutionPlanV1, EvalTrialRefV1, ExecutionLeaseV1, RemotePhysicalExecutionV2, RemoteVerifierOutcomeV2, RemoteVerifierWorkV2 } from "../domain/index.js";
import { parseVerifierScores } from "../domain/index.js";
import { useControllerRuntimeById } from "../controller-runtime/index.js";
import { HitchError, atomicWriteJSON, sha256JSON, statePaths } from "../foundation/index.js";
import { assertRemoteVerifierWork } from "./remote-verifier-contract.js";
import { assertRemoteVerifierOutcome } from "./remote-verifier-outcome.js";
import { loadRemoteVerifierSource } from "./remote-verifier-source.js";
import { frozenRerunBenchmark } from "./verifier-only-rerun.js";
import { scoreWithinRange } from "./benchmark-adapter-manifest.js";
import { detectVerifierInfrastructureFailure, primaryVerifierReward, verifierObservation, verifierResult } from "./verifier-diagnostics.js";
import { regradeTreeDigest, sealRegradeAssessment } from "./regrade-evidence.js";
import { verifierRuntimeRepair } from "./verifier-runtime.js";

export interface RemoteVerifierAssessmentInput {
  root: string; evalDirectory: string; verifier: RemoteVerifierWorkV2; outcome: RemoteVerifierOutcomeV2;
  plan: EvalExecutionPlanV1; work: BackendWorkItemV1; physical: RemotePhysicalExecutionV2; lease: ExecutionLeaseV1;
  resultDigest: string;
}

/** Controller verification is repeated on recovery; a worker cannot replace the canonical candidate. */
export async function validateRemoteVerifierAssessment(input: RemoteVerifierAssessmentInput) {
  const verifier = assertRemoteVerifierWork({ verifier: input.verifier, plan: input.plan, work: input.work,
    physical: input.physical, runtimeId: input.verifier.source_manifest.controller_runtime_id });
  assertRemoteVerifierOutcome({ ...input, verifier });
  if (!/^sha256:[a-f0-9]{64}$/.test(input.resultDigest)) throw invalid();
  const benchmark = await frozenRerunBenchmark(input.evalDirectory);
  if (!benchmark || input.plan.membership !== "known" || benchmark.id !== input.plan.benchmark.id
    || benchmark.revision !== input.plan.benchmark.revision) throw invalid();
  const source = await loadRemoteVerifierSource({ root: input.root, evalDirectory: input.evalDirectory, evalId: input.plan.eval_id,
    provider: input.plan.provider, sourceRef: verifier.source_ref, taskDirectory: path.join(benchmark.tasks, verifier.source_ref.task_id),
    benchmarkId: benchmark.id, benchmarkRevision: benchmark.revision });
  if (sha256JSON(source.manifest) !== sha256JSON(verifier.source_manifest) || sha256JSON(source.sourceTrial) !== sha256JSON(verifier.source_trial)
    || source.canonicalBundleDigest !== verifier.canonical_bundle_digest || source.candidateResultDigest !== verifier.candidate_result_digest) throw invalid();
  const runtime = await useControllerRuntimeById(statePaths(input.root), source.manifest.controller_runtime_id.slice(7));
  const verifierRuntime = await useControllerRuntimeById(statePaths(input.root), verifier.verifier_runtime_id.slice(7));
  const repair = verifierRuntimeRepair(runtime, verifierRuntime);
  if (sha256JSON(input.outcome.runtime_repair ?? null) !== sha256JSON(repair)) throw invalid();
  return { source, benchmark, repair };
}

/** The caller supplies an isolated evidence directory, then atomically publishes the sealed assessment. */
export async function sealRemoteVerifierAssessment(input: RemoteVerifierAssessmentInput & { directory: string }) {
  const { source, benchmark, repair } = await validateRemoteVerifierAssessment(input);
  const evidence = path.join(input.directory, "evidence");
  const record = { trial_id: source.original.trial_id, run_id: source.original.run_id, work_id: source.execution.work_id, logical_work_id: input.physical.source_work_id,
    controller_runtime_id: source.manifest.controller_runtime_id, bundle_index_digest: source.canonicalBundleDigest,
    source_manifest_digest: sha256JSON(source.manifest), source_kind: "remote-verifier-source-v2",
    snapshot_digest: source.manifest.snapshot_digest, artifacts_digest: source.manifest.artifacts_digest, task_tree_digest: source.manifest.task_digest,
    backend_directory: path.relative(input.evalDirectory, path.dirname(path.dirname(source.trialDirectory))).split(path.sep).join("/") };
  await cp(path.join(source.sourceSnapshotDirectory, "artifacts"), path.join(evidence, "source-artifacts"), { recursive: true, force: false, errorOnExist: true });
  if (await regradeTreeDigest(path.join(evidence, "source-artifacts")) !== source.manifest.artifacts_digest) throw invalid();
  await atomicWriteJSON(path.join(evidence, "source.json"), record);
  await atomicWriteJSON(path.join(evidence, "execution.json"), input.outcome.execution);
  await atomicWriteJSON(path.join(evidence, "trial.json"), input.outcome.trial);
  if (repair) await atomicWriteJSON(path.join(evidence, "runtime-repair.json"), repair);
  const result = verifierResult(input.outcome.trial);
  if (result) await atomicWriteJSON(path.join(evidence, "verifier-result.json"), result);
  const observation = verifierObservation({ trial: input.outcome.backend.process_exit_code === 0 && input.outcome.backend.signal === null
    ? input.outcome.trial : { ...input.outcome.trial, exception_info: "harbor-process-failed" },
    runStatus: "succeeded", trajectoryStatus: "valid", recordStatus: "valid",
    verifierRef: result ? "evidence/verifier-result.json" : undefined,
    infrastructure: await detectVerifierInfrastructureFailure(evidence, primaryVerifierReward(input.outcome.trial)) });
  const scores = observation.status === "valid" && benchmark.standard ? parseVerifierScores(result) : undefined;
  if (observation.status === "valid" && benchmark.standard && (!scores || scores.normalization !== "standard" || scores.process_score !== undefined
    || !benchmark.scoring || !scoreWithinRange(scores.total_score, benchmark.scoring.total_score))) throw invalid();
  if (input.physical.kind !== "verifier-only") throw invalid();
  const publication: EvalTrialRefV1 = observation.status === "valid" ? { trial_id: source.original.trial_id, run_id: source.original.run_id,
    task_id: source.original.task_id, attempt: source.original.attempt, observation_status: "valid", reward: observation.reward!,
    verifier_result_ref: observation.verifier_result_ref!, ...(scores ? { scores } : {}) } : source.original;
  await atomicWriteJSON(path.join(input.directory, "publication.json"), publication);
  // Recheck all immutable inputs after reading/copying evidence and before sealing.
  await validateRemoteVerifierAssessment(input);
  const assessment = { ...await sealRegradeAssessment(input.directory, { eval_id: input.plan.eval_id, task_id: source.original.task_id,
    attempt: source.original.attempt, rerun_id: input.physical.rerun_id, source: record,
    controller_runtime_id: input.verifier.verifier_runtime_id, ...(repair ? { runtime_repair: repair } : {}),
    backend: input.outcome.backend, config_digest: input.outcome.config_digest, remote_result_digest: input.resultDigest,
    remote_verifier_work_digest: sha256JSON(input.verifier), remote_publication_digest: sha256JSON(publication),
    observation, completed_at: new Date().toISOString() }), id: input.verifier.assessment_id };
  const ref: EvalTrialRefV1 = observation.status === "valid" ? { ...publication, assessment } : source.original;
  return { ref, assessment, observation };
}
function invalid(): HitchError { return new HitchError("remote verifier assessment differs from its source, score or runtime contract", { code: "remote_verifier_result_invalid", exitCode: 12 }); }
