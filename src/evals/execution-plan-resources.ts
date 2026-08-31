import type {
  ResourceRequirementFieldV1,
  ResourceRequirementSourceV1,
  ResourceVectorV1,
  TaskResourceComponentV1,
  TaskResourceRequirementV1,
} from "../domain/index.js";

const RESOURCE_FIELDS = ["cpu_millis", "memory_bytes", "container_slots", "build_slots"] as const;
const SOURCES = new Set<ResourceRequirementSourceV1>([
  "task", "compose", "submission-default", "operator-default", "provider-policy", "derived-components",
]);

export function parseTaskResourceRequirements(value: unknown, taskIds: readonly string[]): TaskResourceRequirementV1[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("execution plan task resources must be an array");
  const requirements = value.map((entry, index) => parseRequirement(entry, index));
  const actual = requirements.map((entry) => entry.task_id);
  const expected = [...taskIds].sort(compareBytes);
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError("execution plan task resources do not exactly match tasks");
  }
  return requirements;
}

export function reservationForTasks(
  taskIds: readonly string[],
  parallelism: number,
  defaults: ResourceVectorV1,
  requirements?: readonly TaskResourceRequirementV1[],
): ResourceVectorV1 {
  if (!requirements) return scaleResources(defaults, parallelism);
  const byTask = new Map(requirements.map((entry) => [entry.task_id, entry.reservation]));
  const selected = taskIds.map((taskId) => {
    const resource = byTask.get(taskId);
    if (!resource) throw new TypeError(`execution plan has no resources for task: ${taskId}`);
    return resource;
  });
  return Object.fromEntries(RESOURCE_FIELDS.map((name) => [name, selected
    .map((entry) => entry[name])
    .sort((left, right) => right - left)
    .slice(0, parallelism)
    .reduce((sum, entry) => sum + entry, 0)])) as unknown as ResourceVectorV1;
}

export function resourceRequirementForTask(
  plan: { task_resources?: readonly TaskResourceRequirementV1[] },
  taskId: string,
): TaskResourceRequirementV1 | undefined {
  return plan.task_resources?.find((entry) => entry.task_id === taskId);
}

export function runtimeResourcesForTask(
  plan: { task_resources?: readonly TaskResourceRequirementV1[] },
  taskId: string,
  fallback: ResourceVectorV1,
): { mainLimits: ResourceVectorV1; sidecarLimits: Record<string, { cpu_millis: number; memory_bytes: number }> } {
  const requirement = resourceRequirementForTask(plan, taskId);
  const sidecarLimits = Object.fromEntries((requirement?.components ?? [])
    .filter((entry) => entry.role === "task-sidecar" || entry.role === "provider-sidecar")
    .map((entry) => [entry.name, {
      cpu_millis: entry.fields.cpu_millis.value,
      memory_bytes: entry.fields.memory_bytes.value,
    }]));
  return { mainLimits: requirement?.main_limits ?? fallback, sidecarLimits };
}

function parseRequirement(value: unknown, index: number): TaskResourceRequirementV1 {
  const record = exactRecord(value, ["task_id", "reservation", "main_limits", "fields", "components", "diagnostics"], `task resources ${index}`);
  if (typeof record.task_id !== "string" || !record.task_id) throw new TypeError(`task resources ${index} identity is invalid`);
  const reservation = parseVector(record.reservation, `task resources ${index} reservation`);
  const mainLimits = parseVector(record.main_limits, `task resources ${index} main limits`);
  if (mainLimits.container_slots !== 1 || mainLimits.build_slots !== 0) throw new TypeError(`task resources ${index} main limits are invalid`);
  const fieldsRecord = exactRecord(record.fields, RESOURCE_FIELDS, `task resources ${index} fields`);
  const fields = Object.fromEntries(RESOURCE_FIELDS.map((name) => [name, parseField(fieldsRecord[name], `task resources ${index} ${name}`)])) as unknown as TaskResourceRequirementV1["fields"];
  if (RESOURCE_FIELDS.some((name) => fields[name].value !== reservation[name])
    || fields.cpu_millis.source !== "derived-components" || fields.memory_bytes.source !== "derived-components"
    || fields.container_slots.source !== "derived-components" || fields.build_slots.source !== "derived-components") {
    throw new TypeError(`task resources ${index} field evidence does not match reservation`);
  }
  if (!Array.isArray(record.components) || record.components.length === 0) throw new TypeError(`task resources ${index} components are invalid`);
  const components = record.components.map((entry, componentIndex) => parseComponent(entry, index, componentIndex));
  if (components.filter((entry) => entry.role === "main").length !== 1 || new Set(components.map((entry) => `${entry.role}:${entry.name}`)).size !== components.length) {
    throw new TypeError(`task resources ${index} component identities are invalid`);
  }
  const sum = sumComponents(components);
  if (RESOURCE_FIELDS.some((name) => sum[name] !== reservation[name])) throw new TypeError(`task resources ${index} components do not match reservation`);
  for (const component of components.filter((entry) => entry.role === "main" || entry.role === "verifier")) {
    if (component.fields.cpu_millis.value > mainLimits.cpu_millis || component.fields.memory_bytes.value > mainLimits.memory_bytes) {
      throw new TypeError(`task resources ${index} main limits do not cover runtime components`);
    }
  }
  if (!Array.isArray(record.diagnostics) || record.diagnostics.some((entry) => typeof entry !== "string" || !entry)
    || new Set(record.diagnostics).size !== record.diagnostics.length) throw new TypeError(`task resources ${index} diagnostics are invalid`);
  return {
    task_id: record.task_id,
    reservation,
    main_limits: mainLimits,
    fields,
    components,
    diagnostics: [...record.diagnostics] as string[],
  };
}

function parseComponent(value: unknown, requirementIndex: number, componentIndex: number): TaskResourceComponentV1 {
  const label = `task resources ${requirementIndex} component ${componentIndex}`;
  const record = exactRecord(value, ["name", "role", "replicas", "resources", "fields"], label);
  if (typeof record.name !== "string" || !record.name
    || !["main", "task-sidecar", "verifier", "provider-sidecar"].includes(record.role as string)
    || !Number.isSafeInteger(record.replicas) || (record.replicas as number) < 1) throw new TypeError(`${label} identity is invalid`);
  const resources = parseVector(record.resources, `${label} resources`);
  const fieldsRecord = exactRecord(record.fields, ["cpu_millis", "memory_bytes"], `${label} fields`);
  const fields = {
    cpu_millis: parseField(fieldsRecord.cpu_millis, `${label} cpu_millis`),
    memory_bytes: parseField(fieldsRecord.memory_bytes, `${label} memory_bytes`),
  };
  const replicas = record.replicas as number;
  if (resources.cpu_millis !== fields.cpu_millis.value * replicas || resources.memory_bytes !== fields.memory_bytes.value * replicas
    || resources.container_slots !== replicas || resources.build_slots !== 0) throw new TypeError(`${label} resource totals are invalid`);
  return { name: record.name, role: record.role as TaskResourceComponentV1["role"], replicas, resources, fields };
}

function parseField(value: unknown, label: string): ResourceRequirementFieldV1 {
  const record = exactRecord(value, ["value", "source", "estimated"], label);
  if (!Number.isSafeInteger(record.value) || (record.value as number) < 0 || !SOURCES.has(record.source as ResourceRequirementSourceV1)
    || typeof record.estimated !== "boolean") throw new TypeError(`${label} evidence is invalid`);
  return { value: record.value as number, source: record.source as ResourceRequirementSourceV1, estimated: record.estimated };
}

function parseVector(value: unknown, label: string): ResourceVectorV1 {
  const record = exactRecord(value, RESOURCE_FIELDS, label);
  if (RESOURCE_FIELDS.some((name) => !Number.isSafeInteger(record[name]) || (record[name] as number) < 0)) throw new TypeError(`${label} is invalid`);
  return Object.fromEntries(RESOURCE_FIELDS.map((name) => [name, record[name]])) as unknown as ResourceVectorV1;
}

function sumComponents(components: TaskResourceComponentV1[]): ResourceVectorV1 {
  return Object.fromEntries(RESOURCE_FIELDS.map((name) => [name, components.reduce((sum, entry) => sum + entry.resources[name], 0)])) as unknown as ResourceVectorV1;
}

function scaleResources(resources: ResourceVectorV1, count: number): ResourceVectorV1 {
  return Object.fromEntries(RESOURCE_FIELDS.map((name) => [name, resources[name] * count])) as unknown as ResourceVectorV1;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (keys.some((key) => !(key in record)) || Object.keys(record).some((key) => !keys.includes(key))) throw new TypeError(`${label} fields are invalid`);
  return record;
}

function compareBytes(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}
