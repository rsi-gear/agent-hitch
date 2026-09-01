import type { DockerResourceOwnershipV1, ResourceVectorV1 } from "../../domain/index.js";
import { HitchError, invalidInput } from "../../foundation/index.js";

const HITCH_DOCKER_ENVIRONMENT = "hitch_harbor_environment:HitchHarborDockerEnvironment";

export type HarborDockerServiceLimitsV1 = Record<string, { cpu_millis: number; memory_bytes: number }>;

export function harborEnvironmentConfig(
  resources?: ResourceVectorV1,
  ownership?: DockerResourceOwnershipV1,
  serviceLimits?: HarborDockerServiceLimitsV1,
  resolvedImages?: Record<string, string>,
  prebuiltTaskImage?: string,
  modelProxyHostGateway = false,
): Record<string, unknown> {
  const environment: Record<string, unknown> = { type: "docker", delete: true };
  if (resources) {
    if (Object.values(resources).some((value) => !Number.isSafeInteger(value) || value < 0)) throw invalidInput("Harbor execution resources are invalid");
    const mib = 1024 * 1024;
    if (resources.cpu_millis % 1_000 !== 0 || resources.memory_bytes % mib !== 0) {
      throw new HitchError("Harbor cannot represent the requested CPU or memory limit", { code: "resource_limit_unrepresentable", exitCode: 10 });
    }
    const cpus = resources.cpu_millis / 1_000;
    const memoryMb = resources.memory_bytes / mib;
    if (cpus > 0) Object.assign(environment, { cpu_enforcement_policy: "limit", override_cpus: cpus });
    if (memoryMb > 0) Object.assign(environment, { memory_enforcement_policy: "limit", override_memory_mb: memoryMb });
  }
  if (serviceLimits && !ownership) throw invalidInput("Harbor sidecar limits require Docker ownership");
  const images = resolvedImages ? parseResolvedImages(resolvedImages) : {};
  if (prebuiltTaskImage !== undefined && !/^sha256:[a-f0-9]{64}$/.test(prebuiltTaskImage)) throw invalidInput("Harbor prebuilt task image is invalid");
  if (ownership || Object.keys(images).length > 0 || prebuiltTaskImage || modelProxyHostGateway) Object.assign(environment, {
    import_path: HITCH_DOCKER_ENVIRONMENT,
    kwargs: {
      ...(ownership ? { hitch_ownership_labels: harborOwnershipLabels(ownership) } : {}),
      ...(serviceLimits && Object.keys(serviceLimits).length > 0 ? { hitch_service_resource_limits: parseServiceLimits(serviceLimits) } : {}),
      ...(Object.keys(images).length > 0 ? { hitch_resolved_images: images } : {}),
      ...(prebuiltTaskImage ? { hitch_prebuilt_task_image: prebuiltTaskImage } : {}),
      ...(modelProxyHostGateway ? { hitch_model_proxy_host_gateway: true } : {}),
    },
  });
  if (ownership) environment.delete = false;
  return environment;
}

function parseResolvedImages(value: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [requested, resolved] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (!validImageReference(requested) || !validImageReference(resolved)
      || !/@sha256:[a-f0-9]{64}$/.test(resolved) || repositoryOf(requested) !== repositoryOf(resolved)) {
      throw invalidInput("Harbor resolved image mapping is invalid");
    }
    result[requested] = resolved;
  }
  return result;
}

function validImageReference(value: string): boolean {
  return Boolean(value) && value.length <= 1_024 && !/[\s\0]/.test(value) && !value.includes("://") && !value.includes("$");
}

function repositoryOf(reference: string): string {
  const withoutDigest = reference.split("@")[0] as string;
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

function parseServiceLimits(value: HarborDockerServiceLimitsV1): HarborDockerServiceLimitsV1 {
  const result: HarborDockerServiceLimitsV1 = {};
  for (const [name, resources] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (!name || name === "main" || name.length > 255 || /[\0\r\n]/.test(name)
      || !resources || Object.keys(resources).some((field) => field !== "cpu_millis" && field !== "memory_bytes")
      || !Number.isSafeInteger(resources.cpu_millis) || resources.cpu_millis < 1
      || !Number.isSafeInteger(resources.memory_bytes) || resources.memory_bytes < 1) throw invalidInput("Harbor sidecar resource limits are invalid");
    result[name] = { cpu_millis: resources.cpu_millis, memory_bytes: resources.memory_bytes };
  }
  return result;
}

function harborOwnershipLabels(value: DockerResourceOwnershipV1): Record<string, string> {
  if (!/^[a-f0-9]{24}$/.test(value.root_id) || !value.provider || value.provider.length > 128 || !/^[a-z0-9][a-z0-9._-]*$/.test(value.provider)
    || !/^eval_[a-f0-9]{32}$/.test(value.eval_id) || !/^work_[a-f0-9]{32}$/.test(value.work_id)
    || !/^lease_[a-f0-9]{32}$/.test(value.lease_id) || !Number.isSafeInteger(value.lease_epoch) || value.lease_epoch < 1
    || (value.task_id !== undefined && (!value.task_id || value.task_id.length > 4_096 || /[\0\r\n]/.test(value.task_id)))) {
    throw invalidInput("Harbor Docker ownership is invalid");
  }
  return {
    "io.hitch.root-id": value.root_id,
    "io.hitch.provider": value.provider,
    "io.hitch.eval-id": value.eval_id,
    "io.hitch.work-id": value.work_id,
    "io.hitch.lease-id": value.lease_id,
    "io.hitch.lease-epoch": String(value.lease_epoch),
    ...(value.task_id === undefined ? {} : { "io.hitch.task-id": value.task_id }),
  };
}
