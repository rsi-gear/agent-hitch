import type { BackendWorkItemV1, EvalExecutionPlanV1, HarborPhaseResourceContractV1, TaskResourceComponentV1 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";
import { EGRESS_SERVICE, validatePhaseRequirement, VERIFIER_EGRESS_COMPONENT } from "./phase-resources.js";
import { assertWorkResourceContract } from "./work-resource-contract.js";

export function phaseResourceContractForTask(plan: EvalExecutionPlanV1, work: BackendWorkItemV1, taskId: string): HarborPhaseResourceContractV1 | undefined {
  assertWorkResourceContract(work, plan.task_resources, plan.resource_contract_version);
  const requirement = plan.task_resources?.find(entry => entry.task_id === taskId);
  if (requirement?.resource_model !== "phase-envelope-v1") return undefined;
  validatePhaseRequirement(requirement);
  if (requirement.lifecycle!.verifier_inputs === "shared") return undefined;
  if (work.provider !== "local-docker" || work.task_ids.length !== 1 || work.task_ids[0] !== taskId || work.logical_attempt === null) {
    throw new TypeError("phase execution requires an isolated supported work item");
  }
  const components = requirement.components;
  const service = (component: TaskResourceComponentV1) => ({
    name: component.role === "verifier" ? "main" : component.name === VERIFIER_EGRESS_COMPONENT ? EGRESS_SERVICE : component.name,
    replicas: component.replicas,
  });
  return {
    schema_version: "1", capability: "phase-exclusive-teardown-v1", verifier_mode: "separate",
    plan_digest: sha256JSON(plan), task_id: taskId, attempt: work.logical_attempt,
    agent_services: components.filter(c => c.role !== "verifier" && c.name !== VERIFIER_EGRESS_COMPONENT).map(service),
    verifier_services: components.filter(c => c.role === "verifier" || c.name === VERIFIER_EGRESS_COMPONENT).map(service),
    artifacts: requirement.lifecycle!.artifacts,
  };
}
