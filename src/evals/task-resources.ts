import { access } from "node:fs/promises";
import path from "node:path";
import { inspectHarborTaskResources } from "../backends/index.js";
import type { HarborTaskResourceDeclarationV1 } from "../backends/index.js";
import type {
  ResourceRequirementFieldV1,
  ResourceRequirementSourceV1,
  ResourceVectorV1,
  TaskResourceComponentV1,
  TaskResourceRequirementV1,
} from "../domain/index.js";
import { HitchError } from "../foundation/index.js";

const MIB = 1024 * 1024;
export const HARBOR_EGRESS_SIDECAR_RESOURCES: ResourceVectorV1 = {
  cpu_millis: 250,
  memory_bytes: 128 * MIB,
  container_slots: 1,
  build_slots: 0,
};

export async function resolveLocalTaskResourceRequirements(input: {
  root: string;
  dataset: string;
  taskIds: readonly string[];
  defaultResources: ResourceVectorV1;
  defaultSource: "submission-default" | "operator-default";
  harborExecutable?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<TaskResourceRequirementV1[]> {
  const dataset = path.resolve(input.dataset);
  const singleTask = await exists(path.join(dataset, "task.toml"));
  return Promise.all(input.taskIds.map(async (taskId) => {
    const taskDirectory = singleTask ? dataset : path.join(dataset, taskId);
    let declaration: HarborTaskResourceDeclarationV1;
    try {
      declaration = await inspectHarborTaskResources({
        root: input.root,
        taskDirectory,
        ...(input.harborExecutable ? { harborExecutable: input.harborExecutable } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      if (!await mayUseDefaultOnly(taskDirectory, error)) throw error;
      declaration = emptyDeclaration();
    }
    return deriveTaskResourceRequirement({
      taskId,
      declaration,
      defaultResources: input.defaultResources,
      defaultSource: input.defaultSource,
    });
  }));
}

export function deriveTaskResourceRequirement(input: {
  taskId: string;
  declaration: HarborTaskResourceDeclarationV1;
  defaultResources: ResourceVectorV1;
  defaultSource: "submission-default" | "operator-default";
}): TaskResourceRequirementV1 {
  const diagnostics: string[] = [];
  const mainCompose = input.declaration.compose_services.find((service) => service.name === "main");
  if (mainCompose && mainCompose.replicas !== 1) throw resourceError("Harbor main service must have exactly one replica");
  const mainCpu = chooseDeclared("cpu_millis", input.declaration.task.cpu_millis, mainCompose?.cpu_millis, input.defaultResources.cpu_millis, input.defaultSource, diagnostics);
  const mainMemory = chooseDeclared("memory_bytes", input.declaration.task.memory_bytes, mainCompose?.memory_bytes, input.defaultResources.memory_bytes, input.defaultSource, diagnostics);
  let runtimeCpu = mainCpu.value;
  let runtimeMemory = mainMemory.value;
  let verifierCpu: ResourceRequirementFieldV1 | undefined;
  let verifierMemory: ResourceRequirementFieldV1 | undefined;
  if (input.declaration.verifier.separate) {
    verifierCpu = chooseSingle(input.declaration.verifier.environment?.cpu_millis, "task", input.defaultResources.cpu_millis, input.defaultSource);
    verifierMemory = chooseSingle(input.declaration.verifier.environment?.memory_bytes, "task", input.defaultResources.memory_bytes, input.defaultSource);
    runtimeCpu = Math.max(runtimeCpu, verifierCpu.value);
    runtimeMemory = Math.max(runtimeMemory, verifierMemory.value);
  }
  const mainRuntimeFields = {
    cpu_millis: withRuntimeMaximum(mainCpu, runtimeCpu),
    memory_bytes: withRuntimeMaximum(mainMemory, runtimeMemory),
  };
  const components: TaskResourceComponentV1[] = [component("main", "main", 1, mainRuntimeFields)];
  for (const service of input.declaration.compose_services.filter((entry) => entry.name !== "main")) {
    components.push(component(service.name, "task-sidecar", service.replicas, {
      cpu_millis: chooseSingle(service.cpu_millis, "compose", input.defaultResources.cpu_millis, input.defaultSource),
      memory_bytes: chooseSingle(service.memory_bytes, "compose", input.defaultResources.memory_bytes, input.defaultSource),
    }));
  }
  if (input.declaration.verifier.separate) {
    components.push(component("verifier", "verifier", 1, {
      cpu_millis: withRuntimeMaximum(verifierCpu as ResourceRequirementFieldV1, runtimeCpu),
      memory_bytes: withRuntimeMaximum(verifierMemory as ResourceRequirementFieldV1, runtimeMemory),
    }));
  }
  const providerSidecars = Number(input.declaration.provider_sidecars.main_egress) + Number(input.declaration.provider_sidecars.verifier_egress);
  if (providerSidecars > 0) {
    components.push(component("harbor-docker-egress-control-sidecar", "provider-sidecar", providerSidecars, {
      cpu_millis: field(HARBOR_EGRESS_SIDECAR_RESOURCES.cpu_millis, "provider-policy", false),
      memory_bytes: field(HARBOR_EGRESS_SIDECAR_RESOURCES.memory_bytes, "provider-policy", false),
    }));
  }
  const reservation = sumComponents(components);
  const estimated = components.some((entry) => entry.fields.cpu_millis.estimated || entry.fields.memory_bytes.estimated);
  return {
    task_id: input.taskId,
    reservation,
    main_limits: { cpu_millis: runtimeCpu, memory_bytes: runtimeMemory, container_slots: 1, build_slots: 0 },
    fields: {
      cpu_millis: field(reservation.cpu_millis, "derived-components", estimated),
      memory_bytes: field(reservation.memory_bytes, "derived-components", estimated),
      container_slots: field(reservation.container_slots, "derived-components", false),
      build_slots: field(0, "derived-components", false),
    },
    components,
    diagnostics: [...new Set(diagnostics)].sort(),
  };
}

function chooseDeclared(
  name: "cpu_millis" | "memory_bytes",
  taskValue: number | undefined,
  composeValue: number | undefined,
  fallback: number,
  fallbackSource: "submission-default" | "operator-default",
  diagnostics: string[],
): ResourceRequirementFieldV1 {
  if (taskValue !== undefined && composeValue !== undefined) {
    if (taskValue !== composeValue) diagnostics.push(`resource_declaration_conflict:${name}`);
    return field(Math.max(taskValue, composeValue), taskValue >= composeValue ? "task" : "compose", false);
  }
  if (taskValue !== undefined) return field(taskValue, "task", false);
  if (composeValue !== undefined) return field(composeValue, "compose", false);
  return field(fallback, fallbackSource, true);
}

function chooseSingle(
  declared: number | undefined,
  source: ResourceRequirementSourceV1,
  fallback: number,
  fallbackSource: "submission-default" | "operator-default",
): ResourceRequirementFieldV1 {
  return declared === undefined ? field(fallback, fallbackSource, true) : field(declared, source, false);
}

function withRuntimeMaximum(original: ResourceRequirementFieldV1, maximum: number): ResourceRequirementFieldV1 {
  return maximum === original.value ? original : field(maximum, "derived-components", original.estimated);
}

function component(
  name: string,
  role: TaskResourceComponentV1["role"],
  replicas: number,
  fields: TaskResourceComponentV1["fields"],
): TaskResourceComponentV1 {
  return {
    name,
    role,
    replicas,
    resources: {
      cpu_millis: fields.cpu_millis.value * replicas,
      memory_bytes: fields.memory_bytes.value * replicas,
      container_slots: replicas,
      build_slots: 0,
    },
    fields,
  };
}

function sumComponents(components: TaskResourceComponentV1[]): ResourceVectorV1 {
  const total = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
  for (const entry of components) for (const key of Object.keys(total) as Array<keyof ResourceVectorV1>) total[key] += entry.resources[key];
  if (Object.values(total).some((value) => !Number.isSafeInteger(value))) throw resourceError("derived task resources exceed the safe integer range");
  return total;
}

function field(value: number, source: ResourceRequirementSourceV1, estimated: boolean): ResourceRequirementFieldV1 {
  if (!Number.isSafeInteger(value) || value < 0) throw resourceError("task resource value is invalid");
  return { value, source, estimated };
}

async function mayUseDefaultOnly(taskDirectory: string, error: unknown): Promise<boolean> {
  if ((error as { code?: string }).code !== "task_resource_inspection_unavailable") return false;
  if (await exists(path.join(taskDirectory, "environment", "docker-compose.yaml"))) return false;
  const task = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(taskDirectory, "task.toml"), "utf8"));
  return !/(^|\n)\s*(cpus|memory_mb|network_mode|environment_mode)\s*=/m.test(task);
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

function emptyDeclaration(): HarborTaskResourceDeclarationV1 {
  return {
    schema_version: "1",
    task: {},
    verifier: { separate: false },
    compose_services: [{ name: "main", replicas: 1 }],
    provider_sidecars: { main_egress: false, verifier_egress: false },
  };
}

function resourceError(message: string): HitchError {
  return new HitchError(message, { code: "task_resource_derivation_failed", exitCode: 10 });
}
