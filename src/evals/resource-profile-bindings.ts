import { access } from "node:fs/promises";
import path from "node:path";
import type { EnvironmentImageUseV1, EvalExecutionPlanV1, EvalRequest, EvalResourceProfilingV1, ResourceProfileIdentityV1, Sha256, TaskResourceRequirementV1 } from "../domain/index.js";
import { atomicWriteJSON, readJSON, sha256JSON } from "../foundation/index.js";
import { configuredResourceStore, readResourceInput, resourceDescriptorDirectory } from "../resources/index.js";
import type { PreparedEvalArtifactAssignment } from "./eval-artifact-planning.js";
import type { LocalTaskPlanningInputV1 } from "./task-resources.js";
import { buildTaskResourceProfileIdentity } from "./resource-profile-planning.js";
import { matchApprovedResourceConfiguration } from "./resource-profile-approval.js";
import { parseResourceProfileIdentity, resourceProfileIdentityDigest } from "./resource-profile-identity.js";

export interface ResourceProfileIdentityManifestV1 {
  schema_version: "1";
  tasks: Array<{ task_id: string; identity?: ResourceProfileIdentityV1; identity_digest?: Sha256; blocked_reasons: string[] }>;
}

export async function planResourceProfileBindings(input: {
  root: string; evalDirectory: string; request: EvalRequest; taskResources?: readonly TaskResourceRequirementV1[] | undefined;
  preparedAssignments: readonly PreparedEvalArtifactAssignment[]; controllerRuntime: { runtime_id: Sha256 };
  environmentImages: readonly EnvironmentImageUseV1[]; taskPlanningInputs?: readonly LocalTaskPlanningInputV1[] | undefined;
  provider: string; backendVersion?: string; env?: NodeJS.ProcessEnv; resumePlan?: EvalExecutionPlanV1;
}): Promise<{ approvals: EvalResourceProfilingV1["approvals"]; identity_manifest_digest?: Sha256 }> {
  if (input.resumePlan) {
    const digest = input.resumePlan.resource_profiling?.identity_manifest_digest;
    if (digest) await loadResourceProfileIdentityManifest(input.evalDirectory, digest);
    return { approvals: input.resumePlan.resource_profiling?.approvals ?? [], ...(digest ? { identity_manifest_digest: digest } : {}) };
  }
  const manifest: ResourceProfileIdentityManifestV1 = { schema_version: "1", tasks: [] };
  const approvals: EvalResourceProfilingV1["approvals"] = [];
  const resource = await readResourceInput(input.request.dataset);
  const store = resource ? (await configuredResourceStore(input.root)).store : undefined;
  const singleTask = await access(path.join(input.request.dataset, "task.toml")).then(() => true, () => false);
  for (const requirement of input.taskResources ?? []) {
    const assignment = input.preparedAssignments.find(entry => entry.taskIds.includes(requirement.task_id));
    if (!assignment) { manifest.tasks.push({ task_id: requirement.task_id, blocked_reasons: ["artifact_assignment_unavailable"] }); continue; }
    const descriptor = resource?.tasks.find(task => task.task_id === requirement.task_id);
    const directory = descriptor && store ? await resourceDescriptorDirectory(store, descriptor)
      : singleTask ? input.request.dataset : path.join(input.request.dataset, requirement.task_id);
    const planned = input.taskPlanningInputs?.find(task => task.task_id === requirement.task_id);
    const result = await buildTaskResourceProfileIdentity({ taskId: requirement.task_id, taskDirectory: directory, taskResources: requirement,
      artifactDigest: assignment.artifact.artifact_id as Sha256, controllerRuntimeDigest: input.controllerRuntime.runtime_id,
      runtimeContract: { docker_platform: assignment.runtimeContract.dockerPlatform, artifact_platform: assignment.runtimeContract.artifactPlatform,
        node_version: assignment.runtimeContract.nodeVersion }, environmentImages: planned?.profile_environment_images ?? planned?.environment_images ?? [], images: input.environmentImages,
      request: input.request, provider: input.provider, ...((planned?.backend_version ?? input.backendVersion) ? { backendVersion: planned?.backend_version ?? input.backendVersion } : {}), ...(input.env ? { env: input.env } : {}) });
    const matched = matchApprovedResourceConfiguration(input.request.resource_config, result.identity, requirement);
    if (matched.matched && input.request.resource_config && result.identity_digest) approvals.push({ task_id: requirement.task_id,
      approval_digest: input.request.resource_config.configuration_digest, identity_digest: result.identity_digest });
    manifest.tasks.push({ task_id: requirement.task_id, ...result,
      blocked_reasons: [...result.blocked_reasons, ...(input.request.resource_config && !matched.matched ? matched.reasons : [])] });
  }
  manifest.tasks.sort((a, b) => a.task_id.localeCompare(b.task_id));
  await atomicWriteJSON(path.join(input.evalDirectory, "resource-profile-identities.json"), manifest);
  return { approvals, identity_manifest_digest: sha256JSON(manifest) };
}

export async function loadResourceProfileIdentityManifest(evalDirectory: string, expected: Sha256): Promise<ResourceProfileIdentityManifestV1> {
  const value = await readJSON<ResourceProfileIdentityManifestV1>(path.join(evalDirectory, "resource-profile-identities.json"));
  if (!value || value.schema_version !== "1" || !Array.isArray(value.tasks) || sha256JSON(value) !== expected) throw new TypeError("frozen resource profile identity manifest changed");
  for (const task of value.tasks) if (task.identity && (resourceProfileIdentityDigest(parseResourceProfileIdentity(task.identity)) !== task.identity_digest
    || !task.identity.tasks.some(entry => entry.task_id === task.task_id))) throw new TypeError("frozen resource profile task identity changed");
  return value;
}
