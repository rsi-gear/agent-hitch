import type { BackendWorkItemV1, EvalExecutionPlanV1, RemotePhysicalExecutionV2, RemoteVerifierWorkV2 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";
import { assertPhysicalWork } from "./physical-work-plan.js";
import { parseEvalTrialRef } from "./progress.js";
import { parseRemoteVerifierSourceManifest } from "./verifier-source.js";

const SHA = /^sha256:[a-f0-9]{64}$/;
const keys = ["schema_version", "kind", "assessment_id", "source_ref", "source_manifest", "source_trial", "candidate_result",
  "candidate_result_digest", "canonical_bundle_digest", "verifier_runtime_id"];

export function parseRemoteVerifierWork(value: unknown): RemoteVerifierWorkV2 {
  if (!object(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
    || value.schema_version !== "2" || value.kind !== "verifier-only"
    || typeof value.assessment_id !== "string" || !/^assessment_[a-f0-9]{32}$/.test(value.assessment_id)
    || ![value.candidate_result_digest, value.canonical_bundle_digest, value.verifier_runtime_id].every(v => typeof v === "string" && SHA.test(v))) throw invalid();
  const original = parseEvalTrialRef(value.source_ref, "remote verifier source"), source = parseRemoteVerifierSourceManifest(value.source_manifest);
  const trial = value.source_trial, candidate = value.candidate_result;
  if (sha256JSON(original) !== sha256JSON(value.source_ref) || original.run_group || original.assessment
    || original.observation_status !== "invalid" || !["verifier_infrastructure_failure", "verifier_result_missing"].includes(original.invalid_reason ?? "")
    || source.status !== "available" || !source.regrade_config_digest || !source.original_result_digest
    || source.task_id !== original.task_id || source.trial_id !== original.trial_id || source.run_id !== original.run_id
    || !object(trial) || Object.hasOwn(trial, "config") || sha256JSON(trial) !== source.source_result_digest
    || trial.trial_name !== source.trial_id || typeof trial.id !== "string" || !trial.id
    || !object(candidate) || candidate.run_id !== source.run_id || candidate.status !== "succeeded"
    || sha256JSON(candidate) !== value.candidate_result_digest) throw invalid();
  const metadata = object(trial.agent_result) && trial.agent_result.metadata;
  if (!object(metadata) || metadata.hitch_run_id !== source.run_id || metadata.controller_runtime_id !== source.controller_runtime_id) throw invalid();
  return structuredClone(value) as unknown as RemoteVerifierWorkV2;
}

export function assertRemoteVerifierWork(input: {
  verifier: unknown; plan: EvalExecutionPlanV1; work: BackendWorkItemV1; physical: RemotePhysicalExecutionV2 | undefined; runtimeId: string;
}): RemoteVerifierWorkV2 {
  const verifier = parseRemoteVerifierWork(input.verifier);
  assertPhysicalWork(input.plan, input.work, input.physical);
  const slot = input.plan.slots.find(s => s.slot_id === input.work.slots[0]);
  if (input.physical?.kind !== "verifier-only" || input.physical.assessment_id !== verifier.assessment_id
    || input.work.slots.length !== 1 || input.work.task_ids.length !== 1
    || !slot || slot.task_id !== verifier.source_ref.task_id || slot.attempt !== verifier.source_ref.attempt
    || input.work.task_ids[0] !== slot.task_id || input.runtimeId !== verifier.source_manifest.controller_runtime_id) throw invalid();
  return verifier;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function invalid(): TypeError { return new TypeError("remote verifier work differs from its original candidate, assessment or frozen slot"); }
