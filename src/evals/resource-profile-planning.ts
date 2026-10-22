import { parseEvalArtifactPins, type HarborEnvironmentImageDeclarationV1 } from "../backends/index.js";
import { benchmarkTreeDigest } from "../benchmarks/index.js";
import type { EnvironmentImageUseV1, EvalRequest, ResourceProfileIdentityV1, Sha256, TaskResourceRequirementV1, TrialRuntimeContractV1 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";
import { parseEndpointBinding } from "../model-access/index.js";
import { componentId } from "./phase-resources.js";
import { parseResourceProfileIdentity, resourceProfileIdentityDigest } from "./resource-profile-identity.js";

export async function buildTaskResourceProfileIdentity(input: {
  taskId: string; taskDirectory?: string; taskDigest?: Sha256; taskResources: TaskResourceRequirementV1;
  artifactDigest: Sha256; controllerRuntimeDigest: Sha256; runtimeContract: TrialRuntimeContractV1;
  environmentImages: readonly HarborEnvironmentImageDeclarationV1[]; images: readonly EnvironmentImageUseV1[];
  request: EvalRequest; provider: string; backendVersion?: string; inputScale?: Record<string, unknown>; env?: NodeJS.ProcessEnv;
}): Promise<{ identity?: ResourceProfileIdentityV1; identity_digest?: Sha256; blocked_reasons: string[] }> {
  const blocked: string[] = [];
  const taskDigest = input.taskDigest ?? (input.taskDirectory ? await benchmarkTreeDigest(input.taskDirectory).catch(() => undefined) : undefined);
  if (!taskDigest) blocked.push("task_digest_unavailable");
  if (!input.backendVersion) blocked.push("backend_version_unavailable");
  if (input.provider !== "local-docker") blocked.push("backend_version_unverified_on_provider");
  if (input.taskResources.task_id !== input.taskId) throw new TypeError("profile task resource identity changed");
  const roles: ResourceProfileIdentityV1["role_images"] = [];
  for (const component of input.taskResources.components) {
    const id = componentId(component);
    const declaration = input.environmentImages.find(image => component.role === "main" ? image.source === "task" && image.service === "main"
      : component.role === "verifier" ? image.source === "verifier" && image.service === "main" : image.source === "compose" && image.service === component.name)
      ?? (component.role === "main" ? input.environmentImages.find(image => image.source === "compose" && image.service === "main") : undefined);
    const candidates = input.images.filter(image => image.task_ids.includes(input.taskId)
      && (declaration ? image.requested_reference === declaration.reference : component.role === "main" && image.resolution === "prebuilt"));
    const declaredDigest = declaration?.reference.match(/@(sha256:[a-f0-9]{64})$/)?.[1] as Sha256 | undefined;
    const digests = [...new Set(candidates.map(image => image.manifest_digest))];
    const digest = digests.length === 1 ? digests[0] : digests.length === 0 ? declaredDigest : undefined;
    if (!digest) blocked.push(`image_digest_unavailable:${id}`);
    else roles.push({ component_id: id, image_digest: digest, replicas: component.replicas });
  }
  if (input.request.pass_env.length && !input.env) blocked.push("environment_parameters_unavailable");
  if (blocked.length) return { blocked_reasons: blocked };
  const tasks = [{ task_id: input.taskId, task_digest: taskDigest! }];
  const identity = parseResourceProfileIdentity({ schema_version: "1", tasks, task_set_digest: sha256JSON(tasks),
    harness_artifact_digest: input.artifactDigest, controller_runtime_digest: input.controllerRuntimeDigest,
    runtime_contract_digest: sha256JSON(input.runtimeContract), role_images: roles, platform: input.runtimeContract.docker_platform,
    backend: { id: input.request.backend, version: input.backendVersion!, provider: input.provider,
      lifecycle_digest: sha256JSON(input.taskResources.lifecycle ?? { model: "sum", components: input.taskResources.components.map(componentId) }) },
    input_scale: input.inputScale ?? { source: "frozen-task-content", task_digest: taskDigest },
    resource_parameters: { model: input.request.model, timeout_ms: input.request.timeout_ms, setup_timeout_ms: input.request.setup_timeout_ms,
      agent_args: input.request.agent_args, local_inference: input.request.local_inference ?? null, training_binding: input.request.training_binding ?? null,
      // Endpoint submission freezes ready model binding and generation into this public binding.
      endpoint_binding_digest: input.request.endpoint_binding ? sha256JSON(parseEndpointBinding(input.request.endpoint_binding)) : null,
      environment_binding: input.request.environment_binding ?? null,
      artifact_pins: input.request.artifact_pins ? parseEvalArtifactPins(input.request.artifact_pins) : null,
      environment_digest: sha256JSON(Object.fromEntries(input.request.pass_env.map(name => [name, input.env?.[name] ?? null]))),
      limits: input.taskResources.components.map(component => ({ component_id: componentId(component), replicas: component.replicas, resources: component.resources })) } });
  return { identity, identity_digest: resourceProfileIdentityDigest(identity), blocked_reasons: [] };
}
