import type { EvalResourceProfilingV1, ResourceProfilingPolicyV1 } from "../domain/index.js";
import { resourceProfilingPolicy } from "../foundation/index.js";
import { planResourceProfileBindings } from "./resource-profile-bindings.js";
import { conservativeTaskRequirement } from "./phase-resources.js";

export async function planEvalResourceProfiling(input: Parameters<typeof planResourceProfileBindings>[0] & {
  policy?: ResourceProfilingPolicyV1; scope: "worker" | "process"; requestedParallelism: number; taskSlotPlanning?: boolean;
}): Promise<EvalResourceProfilingV1 | undefined> {
  if (input.resumePlan && !input.resumePlan.resource_profiling) return undefined;
  const requirements = input.provider === "local-docker" && input.taskSlotPlanning ? input.taskResources
    : input.taskResources?.map(requirement => conservativeTaskRequirement(requirement, input.provider === "local-docker" ? "work-item-isolation" : "provider-capability"));
  const bindings = await planResourceProfileBindings({ ...input, ...(requirements ? { taskResources: requirements } : {}) });
  if (input.resumePlan) return structuredClone(input.resumePlan.resource_profiling);
  return { schema_version: "1", ...resourceProfilingPolicy(input.policy, input.env), requested_parallelism: input.requestedParallelism,
    scope: input.scope, ...bindings };
}
