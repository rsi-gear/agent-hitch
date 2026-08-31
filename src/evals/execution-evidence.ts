import type { ExecutionEvidenceV1, ObservedContainerResourcesV1, ResourceVectorV1 } from "../domain/index.js";

const RESOURCE_FIELDS = ["cpu_millis", "memory_bytes", "container_slots", "build_slots"] as const;

export function parseExecutionEvidence(value: unknown): ExecutionEvidenceV1 {
  const record = exact(value, [
    "schema_version", "provider", "worker_id", "collision_domain_id", "eval_id", "work_id", "lease_id", "lease_epoch",
    "task_id", "reservation", "enforced", "observed",
  ], "execution evidence");
  if (record.schema_version !== "1" || record.provider !== "local-docker"
    || !validText(record.worker_id) || !validText(record.collision_domain_id)
    || typeof record.eval_id !== "string" || !/^eval_[a-f0-9]{32}$/.test(record.eval_id)
    || typeof record.work_id !== "string" || !/^work_[a-f0-9]{32}$/.test(record.work_id)
    || typeof record.lease_id !== "string" || !/^lease_[a-f0-9]{32}$/.test(record.lease_id)
    || !Number.isSafeInteger(record.lease_epoch) || (record.lease_epoch as number) < 1 || !validText(record.task_id)) {
    throw new TypeError("execution evidence identity is invalid");
  }
  const reservation = resources(record.reservation, "execution evidence reservation");
  const enforcedRecord = exact(record.enforced, ["main_limits", "sidecar_limits"], "execution evidence enforced limits");
  const mainLimits = resources(enforcedRecord.main_limits, "execution evidence main limits");
  const sidecarLimits = sidecars(enforcedRecord.sidecar_limits);
  const observedRecord = exact(record.observed, [
    "status", "started_at", "collected_at", "sample_count", "containers", "unavailable_fields", "issues",
  ], "execution evidence observation");
  if ((observedRecord.status !== "partial" && observedRecord.status !== "unavailable")
    || !timestamp(observedRecord.started_at) || !timestamp(observedRecord.collected_at)
    || Date.parse(observedRecord.collected_at as string) < Date.parse(observedRecord.started_at as string)
    || !Number.isSafeInteger(observedRecord.sample_count) || (observedRecord.sample_count as number) < 0
    || !Array.isArray(observedRecord.containers) || observedRecord.containers.length > 256
    || !Array.isArray(observedRecord.unavailable_fields)
    || observedRecord.unavailable_fields.some((entry) => !["cpu_time_ns", "peak_memory_bytes", "exit_status"].includes(entry as string))
    || new Set(observedRecord.unavailable_fields).size !== observedRecord.unavailable_fields.length
    || !Array.isArray(observedRecord.issues) || observedRecord.issues.length > 32
    || observedRecord.issues.some((entry) => !validText(entry, 512))) throw new TypeError("execution evidence observation is invalid");
  const containers = observedRecord.containers.map((entry, index) => container(entry, index));
  if (new Set(containers.map((entry) => entry.container_id)).size !== containers.length
    || (observedRecord.status === "unavailable" && containers.length !== 0)) throw new TypeError("execution evidence containers are invalid");
  return {
    schema_version: "1",
    provider: "local-docker",
    worker_id: record.worker_id as string,
    collision_domain_id: record.collision_domain_id as string,
    eval_id: record.eval_id,
    work_id: record.work_id,
    lease_id: record.lease_id,
    lease_epoch: record.lease_epoch as number,
    task_id: record.task_id as string,
    reservation,
    enforced: { main_limits: mainLimits, sidecar_limits: sidecarLimits },
    observed: {
      status: observedRecord.status,
      started_at: observedRecord.started_at as string,
      collected_at: observedRecord.collected_at as string,
      sample_count: observedRecord.sample_count as number,
      containers,
      unavailable_fields: [...observedRecord.unavailable_fields] as ExecutionEvidenceV1["observed"]["unavailable_fields"],
      issues: [...observedRecord.issues] as string[],
    },
  };
}

function container(value: unknown, index: number): ObservedContainerResourcesV1 {
  const record = exact(value, ["container_id", "first_observed_at", "last_observed_at"], `execution evidence container ${index}`, [
    "name", "peak_memory_bytes", "oom_killed", "exit_code", "exit_reason",
  ]);
  if (typeof record.container_id !== "string" || !/^[a-f0-9]{12,64}$/.test(record.container_id)
    || (record.name !== undefined && !validText(record.name, 256)) || !timestamp(record.first_observed_at) || !timestamp(record.last_observed_at)
    || Date.parse(record.last_observed_at as string) < Date.parse(record.first_observed_at as string)
    || (record.peak_memory_bytes !== undefined && (!Number.isSafeInteger(record.peak_memory_bytes) || (record.peak_memory_bytes as number) < 0))
    || (record.oom_killed !== undefined && typeof record.oom_killed !== "boolean")
    || (record.exit_code !== undefined && (!Number.isSafeInteger(record.exit_code) || (record.exit_code as number) < 0 || (record.exit_code as number) > 255))
    || (record.exit_reason !== undefined && !validText(record.exit_reason, 512))) throw new TypeError(`execution evidence container ${index} is invalid`);
  return record as unknown as ObservedContainerResourcesV1;
}

function sidecars(value: unknown): Record<string, { cpu_millis: number; memory_bytes: number }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("execution evidence sidecar limits are invalid");
  const result: Record<string, { cpu_millis: number; memory_bytes: number }> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
    const limit = exact(entry, ["cpu_millis", "memory_bytes"], `execution evidence sidecar ${name}`);
    if (!validText(name, 255) || !Number.isSafeInteger(limit.cpu_millis) || (limit.cpu_millis as number) < 1
      || !Number.isSafeInteger(limit.memory_bytes) || (limit.memory_bytes as number) < 1) throw new TypeError("execution evidence sidecar limits are invalid");
    result[name] = { cpu_millis: limit.cpu_millis as number, memory_bytes: limit.memory_bytes as number };
  }
  return result;
}

function resources(value: unknown, label: string): ResourceVectorV1 {
  const record = exact(value, RESOURCE_FIELDS, label);
  if (RESOURCE_FIELDS.some((name) => !Number.isSafeInteger(record[name]) || (record[name] as number) < 0)) throw new TypeError(`${label} is invalid`);
  return record as unknown as ResourceVectorV1;
}

function exact(value: unknown, required: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in record)) || Object.keys(record).some((key) => !allowed.has(key))) throw new TypeError(`${label} fields are invalid`);
  return record;
}

function timestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validText(value: unknown, maximum = 4_096): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\0\r\n]/.test(value);
}
