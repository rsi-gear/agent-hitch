import type { BackendWorkItemV1, EvalExecutionPlanV1, ExecutionLeaseV1, RemoteVerifierOutcomeV2, RemoteVerifierWorkV2 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";
import { parseExecutionEvidence } from "./execution-evidence.js";
import { runtimeResourcesForTask } from "./execution-plan-resources.js";

const SHA = /^sha256:[a-f0-9]{64}$/;
export function parseRemoteVerifierOutcome(value: unknown): RemoteVerifierOutcomeV2 {
  if (!object(value)) throw invalid();
  const keys = ["trial", "backend", "execution", "config_digest", "controller_runtime_id", ...(value.runtime_repair === undefined ? [] : ["runtime_repair"])];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
    || !object(value.trial) || Object.hasOwn(value.trial, "config")
    || value.trial.agent_setup != null || value.trial.agent_execution != null
    || typeof value.trial.trial_name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value.trial.trial_name)
    || !object(value.backend) || Object.keys(value.backend).sort().join(",") !== "process_exit_code,signal"
    || !(value.backend.process_exit_code === null || Number.isSafeInteger(value.backend.process_exit_code)
      && Number(value.backend.process_exit_code) >= 0 && Number(value.backend.process_exit_code) <= 255)
    || !(value.backend.signal === null || typeof value.backend.signal === "string" && /^SIG[A-Z0-9]{1,24}$/.test(value.backend.signal))
    || ![value.config_digest, value.controller_runtime_id].every(v => typeof v === "string" && SHA.test(v))
    || value.runtime_repair !== undefined && !validRepair(value.runtime_repair, value.controller_runtime_id)) throw invalid();
  return { ...structuredClone(value), execution: parseExecutionEvidence(value.execution) } as unknown as RemoteVerifierOutcomeV2;
}

export function assertRemoteVerifierOutcome(input: {
  outcome: RemoteVerifierOutcomeV2; verifier: RemoteVerifierWorkV2; plan: EvalExecutionPlanV1; work: BackendWorkItemV1; lease: ExecutionLeaseV1;
}): void {
  const o = parseRemoteVerifierOutcome(input.outcome), v = input.verifier, e = o.execution, l = input.lease;
  const limits = runtimeResourcesForTask(input.plan, v.source_ref.task_id, input.work.reservation);
  if (input.work.eval_id !== l.eval_id || input.work.work_id !== l.work_id || input.work.provider !== l.provider
    || e.eval_id !== l.eval_id || e.work_id !== l.work_id || e.lease_id !== l.lease_id || e.lease_epoch !== l.epoch
    || e.worker_id !== l.worker_id || e.provider !== l.provider || e.collision_domain_id !== l.collision_domain_id
    || e.task_id !== v.source_ref.task_id || sha256JSON(e.reservation) !== sha256JSON(input.work.reservation)
    || sha256JSON(l.reservation) !== sha256JSON(e.reservation)
    || sha256JSON(e.enforced.main_limits) !== sha256JSON(limits.mainLimits) || sha256JSON(e.enforced.sidecar_limits) !== sha256JSON(limits.sidecarLimits)
    || o.controller_runtime_id !== v.verifier_runtime_id || o.trial.task_name !== v.source_trial.task_name
    || o.trial.trial_name !== remoteVerifierTrialName(v.assessment_id)
    || sha256JSON(o.trial.agent_result) !== sha256JSON(v.source_trial.agent_result)) throw invalid();
}

export function remoteVerifierTrialName(assessmentId: string): string {
  if (!/^assessment_[a-f0-9]{32}$/.test(assessmentId)) throw invalid();
  return `regrade__${assessmentId}`;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function validRepair(value: unknown, runtimeId: unknown): boolean {
  const keys = ["schema_version", "kind", "source_runtime_id", "replacement_runtime_id", "path", "source_sha256", "replacement_sha256", "unchanged_file_count"];
  return object(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
    && value.schema_version === "1" && value.kind === "verifier-environment-runtime-repair"
    && value.path === "integrations/harbor/hitch_harbor_environment.py" && value.replacement_runtime_id === runtimeId
    && [value.source_runtime_id, value.replacement_runtime_id, value.source_sha256, value.replacement_sha256].every(v => typeof v === "string" && SHA.test(v))
    && Number.isSafeInteger(value.unchanged_file_count) && Number(value.unchanged_file_count) >= 0;
}
function invalid(): TypeError { return new TypeError("remote verifier outcome differs from its scoring work, candidate or execution lease"); }
