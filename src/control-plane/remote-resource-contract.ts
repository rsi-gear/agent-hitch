import type { BackendWorkItemV1 } from "../domain/index.js";
import { parseWorkResourceContract } from "../evals/index.js";
import { HitchError } from "../foundation/index.js";

/** P0 certifies local execution only. A remote endpoint must not receive the
 * smaller envelope until its own provider can enforce the phase barrier. */
export function assertLegacyRemoteResourceWork(work: BackendWorkItemV1, plan?: unknown): void {
  const contract = parseWorkResourceContract(work);
  const value = plan && typeof plan === "object" && !Array.isArray(plan) ? plan as Record<string, unknown> : undefined;
  if (contract.schema_version === "2" || value?.resource_contract_version !== undefined
    || Array.isArray(value?.task_resources) && value.task_resources.some(requirement => requirement && typeof requirement === "object"
      && Object.hasOwn(requirement, "resource_model"))) {
    throw new HitchError("remote worker does not support resource contract v2 or phase-exclusive-teardown-v1", {
      code: "resource_contract_unsupported", exitCode: 10,
    });
  }
}
