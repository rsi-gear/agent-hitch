import { harborTrialRuntimeContract } from "../backends/index.js";
import type { EnvironmentImageFallbackV1, EnvironmentImageUseV1, EvalExecutionPlanV1, ResourceVectorV1, TaskResourceRequirementV1, TrialRuntimeContractV1 } from "../domain/index.js";
import { DEFAULT_ENVIRONMENT_IMAGE_PLATFORM, planEnvironmentImages } from "./environment-image-planning.js";
import type { EvalEnvironmentImageBuilder, EvalEnvironmentImageResolver } from "./service-types.js";
import { resolveLocalTaskPlanningInputs } from "./task-resources.js";

export interface LocalEvalPlanningResultV1 {
  taskResources?: TaskResourceRequirementV1[];
  environmentImages: EnvironmentImageUseV1[];
  environmentImageFallbacks: EnvironmentImageFallbackV1[];
  /** Canonical task groups that may safely consume the same prepared artifact. */
  taskRuntimeContracts: Array<TrialRuntimeContractV1 & { task_ids: string[] }>;
}

export async function planLocalEvalInputs(input: {
  root: string;
  dataset: string;
  taskIds: readonly string[] | null;
  defaultResources: ResourceVectorV1;
  defaultSource: "submission-default" | "operator-default";
  benchmarkId: string;
  benchmarkRevision: string;
  buildMode: "backend" | "prebuild-preferred" | "prebuild-required";
  resolver?: EvalEnvironmentImageResolver;
  builder?: EvalEnvironmentImageBuilder;
  resumePlan?: EvalExecutionPlanV1;
  harborExecutable?: string;
  harborTaskResourceInspector?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  platform?: string;
}): Promise<LocalEvalPlanningResultV1> {
  const trialDockerPlatform = input.platform ?? DEFAULT_ENVIRONMENT_IMAGE_PLATFORM;
  if (input.taskIds === null) return {
    environmentImages: [],
    environmentImageFallbacks: [],
    taskRuntimeContracts: [runtimeAssignment([], trialDockerPlatform)],
  };
  const tasks = await resolveLocalTaskPlanningInputs({
    root: input.root,
    dataset: input.dataset,
    taskIds: input.taskIds,
    defaultResources: input.defaultResources,
    defaultSource: input.defaultSource,
    ...(input.harborExecutable ? { harborExecutable: input.harborExecutable } : {}),
    ...(input.harborTaskResourceInspector ? { inspectorPath: input.harborTaskResourceInspector } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const taskResources = tasks.map((entry) => entry.resources);
  const taskRuntimeContracts = groupTaskRuntimeContracts(tasks.map((task) => ({
    task_id: task.task_id,
    platform: task.runtime_platform ?? trialDockerPlatform,
  })));
  if (input.resumePlan) return {
    taskResources,
    environmentImages: resumedImages(input.resumePlan),
    environmentImageFallbacks: input.resumePlan.image_fallbacks ?? [],
    taskRuntimeContracts,
  };
  const planned = await planEnvironmentImages({
    tasks,
    mode: input.buildMode,
    benchmarkId: input.benchmarkId,
    benchmarkRevision: input.benchmarkRevision,
    platform: trialDockerPlatform,
    ...(input.resolver ? { resolver: input.resolver } : {}),
    ...(input.builder ? { builder: input.builder } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return { taskResources, environmentImages: planned.uses, environmentImageFallbacks: planned.fallbacks, taskRuntimeContracts };
}

function groupTaskRuntimeContracts(tasks: Array<{ task_id: string; platform: string }>): Array<TrialRuntimeContractV1 & { task_ids: string[] }> {
  const groups = new Map<string, TrialRuntimeContractV1 & { task_ids: string[] }>();
  for (const task of tasks) {
    const assignment = runtimeAssignment([task.task_id], task.platform);
    const key = `${assignment.docker_platform}\0${assignment.artifact_platform}\0${assignment.node_version}`;
    const existing = groups.get(key);
    if (existing) existing.task_ids.push(task.task_id);
    else groups.set(key, assignment);
  }
  return [...groups.values()].map((entry) => ({ ...entry, task_ids: [...entry.task_ids].sort(compare) })).sort((left, right) => compare(left.task_ids[0] ?? "", right.task_ids[0] ?? ""));
}

function runtimeAssignment(taskIds: string[], dockerPlatform: string): TrialRuntimeContractV1 & { task_ids: string[] } {
  const contract = harborTrialRuntimeContract(dockerPlatform);
  return {
    task_ids: [...taskIds],
    docker_platform: contract.dockerPlatform,
    artifact_platform: contract.artifactPlatform,
    node_version: contract.nodeVersion,
  };
}

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function resumedImages(plan: EvalExecutionPlanV1): EnvironmentImageUseV1[] {
  const unique = new Map<string, EnvironmentImageUseV1>();
  for (const item of plan.work_items) for (const image of item.image_refs ?? []) {
    unique.set(`${image.task_ids.join("\0")}\0${image.requested_reference}`, image);
  }
  return [...unique.values()].sort((left, right) => Buffer.compare(
    Buffer.from(`${left.task_ids.join("\0")}\0${left.requested_reference}`),
    Buffer.from(`${right.task_ids.join("\0")}\0${right.requested_reference}`),
  ));
}
