import type { BackendWorkItemV1, Sha256, TaskResourceRequirementV1 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";

export const PHASE_RESOURCE_CAPABILITY = "phase-exclusive-teardown-v1";
export interface WorkResourceBindingV2 {
  resource_contract_version: "2";
  resource_contract_digest: Sha256;
  required_capabilities: string[];
}
export type WorkResourceContractFields = { schema_version: "1" } | ({ schema_version: "2" } & WorkResourceBindingV2);

/** The complete selected requirements remain in the frozen plan. This binding
 * prevents a reduced reservation from being transported as a legacy work item. */
export function workResourceContractFields(
  taskIds: readonly string[],
  requirements: readonly TaskResourceRequirementV1[] | undefined,
  version?: "2",
): WorkResourceContractFields {
  if (version === undefined) return { schema_version: "1" };
  if (version !== "2" || !requirements || taskIds.length === 0 || new Set(taskIds).size !== taskIds.length) {
    throw new TypeError("work resource contract has no bounded task requirements");
  }
  const selected = taskIds.map(taskId => {
    const matching = requirements.filter(requirement => requirement.task_id === taskId);
    if (matching.length !== 1) throw new TypeError("work resource contract task requirements are missing or duplicated");
    return matching[0]!;
  }).sort((left, right) => Buffer.compare(Buffer.from(left.task_id), Buffer.from(right.task_id)));
  const phases = selected.some(requirement => (requirement as TaskResourceRequirementV1 & { resource_model?: string }).resource_model === "phase-envelope-v1");
  return {
    schema_version: "2",
    resource_contract_version: "2",
    resource_contract_digest: sha256JSON({ resource_contract_version: "2", task_resources: selected }),
    required_capabilities: phases ? [PHASE_RESOURCE_CAPABILITY] : [],
  };
}

/** Validate just the transport binding; the plan parser verifies its digest. */
export function parseWorkResourceContract(value: unknown): WorkResourceContractFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("work resource contract is invalid");
  const record = value as Record<string, unknown>;
  const fields = ["resource_contract_version", "resource_contract_digest", "required_capabilities"];
  if (record.schema_version === "1") {
    if (fields.some(field => Object.hasOwn(record, field))) throw new TypeError("legacy work cannot carry a resource contract v2");
    return { schema_version: "1" };
  }
  if (record.schema_version !== "2" || record.resource_contract_version !== "2"
    || typeof record.resource_contract_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.resource_contract_digest)
    || !Array.isArray(record.required_capabilities) || record.required_capabilities.length > 1
    || record.required_capabilities.some(capability => capability !== PHASE_RESOURCE_CAPABILITY)) {
    throw new TypeError("work resource contract version, digest or capabilities are invalid");
  }
  return { schema_version: "2", resource_contract_version: "2", resource_contract_digest: record.resource_contract_digest as Sha256,
    required_capabilities: [...record.required_capabilities] };
}

export function assertWorkResourceContract(
  work: BackendWorkItemV1,
  requirements: readonly TaskResourceRequirementV1[] | undefined,
  version?: "2",
): void {
  const actual = parseWorkResourceContract(work);
  const expected = workResourceContractFields(work.task_ids, requirements, version);
  if (sha256JSON(actual) !== sha256JSON(expected)) throw new TypeError("work resource contract differs from its frozen plan");
}

export const validateWorkResourceBinding = assertWorkResourceContract;

/** Keep V1 identities byte-for-byte compatible. */
export function workResourceIdentityFields(value: unknown): Partial<WorkResourceBindingV2> {
  const contract = parseWorkResourceContract(value);
  if (contract.schema_version === "1") return {};
  const { schema_version: _version, ...binding } = contract;
  return binding;
}
