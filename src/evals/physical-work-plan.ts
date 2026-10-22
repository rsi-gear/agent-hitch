import type { BackendWorkItemV1, EvalExecutionPlanV1, RemotePhysicalExecutionV2 } from "../domain/index.js";
import { HitchError, sha256JSON } from "../foundation/index.js";
import { assertWorkResourceContract, parseWorkResourceContract } from "./work-resource-contract.js";
import { validatePhaseRequirement } from "./phase-resources.js";
import { physicalRetryWorkItemForTriggerIds } from "./physical-retry-work.js";

/** Validate a physical execution without changing the frozen logical plan or its digest. */
export function assertPhysicalWork(plan: EvalExecutionPlanV1, work: BackendWorkItemV1, value?: RemotePhysicalExecutionV2): void {
  const proof = value === undefined ? undefined : parsePhysicalExecution(value);
  const source = plan.work_items.find(item => item.work_id === (proof?.source_work_id ?? work.work_id));
  if (!source || proof && plan.training_binding) throw new TypeError("physical work has no permitted frozen logical source");
  const expected = !proof ? source : proof.kind === "candidate-restart"
    ? candidateRestartWorkItem(source, proof.rerun_id)
    : proof.kind === "verifier-only" ? verifierOnlyWorkItem(source, proof.rerun_id, proof.assessment_id, plan)
    : physicalRetryWorkItemForTriggerIds(source, proof.retry_index, proof.trigger_trial_ids);
  if (sha256JSON(expected) !== sha256JSON(work)) throw new TypeError("physical work changed its frozen execution contract");
}

export function candidateRestartWorkItem(source: BackendWorkItemV1, rerunId: string): BackendWorkItemV1 {
  if (!/^rerun_[a-f0-9]{32}$/.test(rerunId)) throw new TypeError("candidate restart rerun ID is invalid");
  return { ...source, work_id: `work_${sha256JSON({ execution_kind: "candidate-restart", rerun_id: rerunId,
    source_work_id: source.work_id, slots: source.slots }).slice(7, 39)}` };
}

export function verifierOnlyWorkItem(source: BackendWorkItemV1, rerunId: string, assessmentId: string, plan?: EvalExecutionPlanV1): BackendWorkItemV1 {
  if (!/^rerun_[a-f0-9]{32}$/.test(rerunId) || !/^assessment_[a-f0-9]{32}$/.test(assessmentId)
    || source.task_ids.length !== 1 || source.slots.length !== 1) throw new TypeError("verifier-only requires an assessment and isolated logical slot");
  const reservation = verifierOnlyReservation(source, plan);
  const binding = source.schema_version === "2" ? { resource_contract_digest: sha256JSON({
    resource_contract_version: "2", execution_kind: "verifier-only", source_resource_contract_digest: source.resource_contract_digest,
    task_ids: source.task_ids, reservation,
  }) } : {};
  return { ...source, ...binding, reservation, work_id: `work_${sha256JSON({ execution_kind: "verifier-only", rerun_id: rerunId,
    assessment_id: assessmentId, source_work_id: source.work_id, slots: source.slots, ...binding }).slice(7, 39)}` };
}

/** Only a frozen, supported local phase contract authorizes a smaller regrade
 * work item. Disk and GPU keep the original conservative whole-trial sum. */
export function verifierOnlyReservation(source: BackendWorkItemV1, plan?: EvalExecutionPlanV1): BackendWorkItemV1["reservation"] {
  if (parseWorkResourceContract(source).schema_version === "1") return source.reservation;
  if (!plan || source.provider !== "local-docker" || source.task_ids.length !== 1 || source.slots.length !== 1) {
    throw new HitchError("phase resource verifier-only requires a frozen local plan and independently admitted verifier contract", {
      code: "eval_verifier_only_unavailable", exitCode: 2,
    });
  }
  assertWorkResourceContract(source, plan.task_resources, plan.resource_contract_version);
  const requirement = plan.task_resources?.find(item => item.task_id === source.task_ids[0]);
  if (requirement?.resource_model !== "phase-envelope-v1") return source.reservation;
  validatePhaseRequirement(requirement);
  const verifier = requirement.lifecycle!.phases.find(phase => phase.id === "verifier");
  if (!verifier || requirement.lifecycle!.verifier_inputs !== "artifacts-only") {
    throw new HitchError("phase resource regrade requires an artifacts-only verifier stage", { code: "eval_verifier_only_unavailable", exitCode: 2 });
  }
  return { ...source.reservation, cpu_millis: verifier.demand.cpu_millis, memory_bytes: verifier.demand.memory_bytes,
    container_slots: verifier.demand.container_slots };
}

export function parsePhysicalExecution(value: unknown): RemotePhysicalExecutionV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("physical execution must be an object");
  const record = value as Record<string, unknown>;
  const keys = ["schema_version", "kind", "source_work_id", ...(record.kind === "verifier-only" ? ["rerun_id", "assessment_id"]
    : record.kind === "candidate-restart" ? ["rerun_id"] : ["retry_index", "trigger_trial_ids"])];
  if (Object.keys(record).length !== keys.length || Object.keys(record).some(key => !keys.includes(key))
    || record.schema_version !== "2" || typeof record.source_work_id !== "string" || !/^work_[a-f0-9]{32}$/.test(record.source_work_id)) {
    throw new TypeError("physical execution fields are invalid");
  }
  if (record.kind === "candidate-restart" || record.kind === "verifier-only") {
    if (typeof record.rerun_id !== "string" || !/^rerun_[a-f0-9]{32}$/.test(record.rerun_id)) throw new TypeError("physical execution rerun ID is invalid");
    if (record.kind === "verifier-only" && (typeof record.assessment_id !== "string" || !/^assessment_[a-f0-9]{32}$/.test(record.assessment_id))) throw new TypeError("physical execution assessment ID is invalid");
  } else if (record.kind === "physical-infrastructure-retry") {
    const ids = record.trigger_trial_ids;
    if (!Number.isSafeInteger(record.retry_index) || (record.retry_index as number) < 1 || !Array.isArray(ids) || ids.length < 1 || ids.length > 10_000
      || ids.some(id => typeof id !== "string" || !id || id.length > 4_096 || /[\0\r\n]/.test(id))
      || new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify([...ids].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))))) {
      throw new TypeError("physical execution retry trigger is invalid");
    }
  } else throw new TypeError("physical execution kind is invalid");
  return record as unknown as RemotePhysicalExecutionV2;
}
