import type { EnvironmentImageFallbackV1, EnvironmentImageUseV1, EvalExecutionPlanV1, ResourceVectorV1, TaskResourceRequirementV1 } from "../domain/index.js";
import { planEnvironmentImages } from "./environment-image-planning.js";
import type { EvalEnvironmentImageBuilder, EvalEnvironmentImageResolver } from "./service-types.js";
import { resolveLocalTaskPlanningInputs } from "./task-resources.js";

export interface LocalEvalPlanningResultV1 {
  taskResources?: TaskResourceRequirementV1[];
  environmentImages: EnvironmentImageUseV1[];
  environmentImageFallbacks: EnvironmentImageFallbackV1[];
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
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<LocalEvalPlanningResultV1> {
  if (input.taskIds === null) return { environmentImages: [], environmentImageFallbacks: [] };
  const tasks = await resolveLocalTaskPlanningInputs({
    root: input.root,
    dataset: input.dataset,
    taskIds: input.taskIds,
    defaultResources: input.defaultResources,
    defaultSource: input.defaultSource,
    ...(input.harborExecutable ? { harborExecutable: input.harborExecutable } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const taskResources = tasks.map((entry) => entry.resources);
  if (input.resumePlan) return {
    taskResources,
    environmentImages: resumedImages(input.resumePlan),
    environmentImageFallbacks: input.resumePlan.image_fallbacks ?? [],
  };
  const planned = await planEnvironmentImages({
    tasks,
    mode: input.buildMode,
    benchmarkId: input.benchmarkId,
    benchmarkRevision: input.benchmarkRevision,
    ...(input.resolver ? { resolver: input.resolver } : {}),
    ...(input.builder ? { builder: input.builder } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return { taskResources, environmentImages: planned.uses, environmentImageFallbacks: planned.fallbacks };
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
