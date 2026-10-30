import type { ExecutionEvidenceV1, ObservedContainerResourcesV1, ResourceVectorV1 } from "../domain/index.js";
import { parseContainerMemory, parseMemoryObservation } from "./memory-observation.js";

const RESOURCE_FIELDS = ["cpu_millis", "memory_bytes", "container_slots", "build_slots"] as const;

export function parseExecutionEvidence(value: unknown): ExecutionEvidenceV1 {
  const record = exact(value, [
    "schema_version", "provider", "worker_id", "collision_domain_id", "eval_id", "work_id", "lease_id", "lease_epoch",
    "task_id", "reservation", "enforced", "observed",
  ], "execution evidence");
  if (record.schema_version !== "1" || !validText(record.provider)
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
  ], "execution evidence observation", ["memory"]);
  if ((observedRecord.status !== "partial" && observedRecord.status !== "unavailable")
    || !timestamp(observedRecord.started_at) || !timestamp(observedRecord.collected_at)
    || Date.parse(observedRecord.collected_at as string) < Date.parse(observedRecord.started_at as string)
    || !Number.isSafeInteger(observedRecord.sample_count) || (observedRecord.sample_count as number) < 0
    || !Array.isArray(observedRecord.containers) || observedRecord.containers.length > 256
    || !Array.isArray(observedRecord.unavailable_fields)
    || observedRecord.unavailable_fields.some((entry) => !["cpu_time_ns", "peak_memory_bytes", "exit_status", "image_identity"].includes(entry as string))
    || new Set(observedRecord.unavailable_fields).size !== observedRecord.unavailable_fields.length
    || !Array.isArray(observedRecord.issues) || observedRecord.issues.length > 32
    || observedRecord.issues.some((entry) => !validText(entry, 512))) throw new TypeError("execution evidence observation is invalid");
  const containers = observedRecord.containers.map((entry, index) => container(entry, index));
  if (new Set(containers.map((entry) => entry.container_id)).size !== containers.length
    || (observedRecord.status === "unavailable" && containers.length !== 0)) throw new TypeError("execution evidence containers are invalid");
  const memory = observedRecord.memory === undefined ? undefined : parseMemoryObservation(observedRecord.memory);
  if (memory) {
    const peaks = containers.flatMap(container => container.memory?.sampled_peak_bytes === undefined ? [] : [container.memory.sampled_peak_bytes]);
    if (memory.attempted_cycles < (observedRecord.sample_count as number)
      || memory.max_container_sampled_peak_bytes !== (peaks.length ? Math.max(...peaks) : undefined)
      || memory.sum_container_sampled_peaks_bytes !== (peaks.length ? peaks.reduce((a, b) => a + b, 0) : undefined)) {
      throw new TypeError("execution evidence memory summary differs from its containers");
    }
    if (containers.some(container => container.memory?.samples.some(sample => sample.cycle > memory.attempted_cycles))) {
      throw new TypeError("execution evidence container memory cycle is invalid");
    }
    for (const group of [...memory.groups, ...memory.group_peaks]) {
      const samples = containers.filter(container => group.group_id === "task" || container.memory?.attribution?.group_id === group.group_id)
        .flatMap(container => container.memory?.samples.filter(sample => sample.cycle === group.cycle && sample.memory_bytes !== undefined) ?? []);
      // Older retained cycles may have outlived their bounded container detail.
      if (samples.length && samples.length === group.sampled_container_count
        && samples.reduce((sum, sample) => sum + sample.memory_bytes!, 0) !== group.memory_bytes) {
        throw new TypeError("execution evidence group memory differs from its samples");
      }
    }
  }
  return {
    schema_version: "1",
    provider: record.provider as string,
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
      ...(memory === undefined ? {} : { memory }),
    },
  };
}

function container(value: unknown, index: number): ObservedContainerResourcesV1 {
  const record = exact(value, ["container_id", "first_observed_at", "last_observed_at"], `execution evidence container ${index}`, [
    "name", "service", "role", "image_reference", "image_config_digest", "peak_memory_bytes", "cpu_time_ns", "oom_killed", "exit_code", "exit_reason", "memory",
  ]);
  if (typeof record.container_id !== "string" || !/^[a-f0-9]{12,64}$/.test(record.container_id)
    || (record.name !== undefined && !validText(record.name, 256)) || !timestamp(record.first_observed_at) || !timestamp(record.last_observed_at)
    || (record.image_reference !== undefined && !validText(record.image_reference, 1_024))
    || (record.service !== undefined && (typeof record.service !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(record.service)))
    || (record.role !== undefined && record.role !== "candidate" && record.role !== "verifier")
    || (record.image_config_digest !== undefined && (typeof record.image_config_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.image_config_digest)))
    || Date.parse(record.last_observed_at as string) < Date.parse(record.first_observed_at as string)
    || (record.peak_memory_bytes !== undefined && (!Number.isSafeInteger(record.peak_memory_bytes) || (record.peak_memory_bytes as number) < 0))
    || (record.cpu_time_ns !== undefined && (!Number.isSafeInteger(record.cpu_time_ns) || (record.cpu_time_ns as number) < 0))
    || (record.oom_killed !== undefined && typeof record.oom_killed !== "boolean")
    || (record.exit_code !== undefined && (!Number.isSafeInteger(record.exit_code) || (record.exit_code as number) < 0 || (record.exit_code as number) > 255))
    || (record.exit_reason !== undefined && !validText(record.exit_reason, 512))) throw new TypeError(`execution evidence container ${index} is invalid`);
  if (record.memory !== undefined) {
    const memory = parseContainerMemory(record.memory);
    if (record.peak_memory_bytes !== memory.sampled_peak_bytes) throw new TypeError("execution evidence sampled memory peak differs from compatibility field");
    return { ...record, memory } as unknown as ObservedContainerResourcesV1;
  }
  return record as unknown as ObservedContainerResourcesV1;
}

function sidecars(value: unknown): Record<string, { cpu_millis: number; memory_bytes: number; gpu_count?: number }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("execution evidence sidecar limits are invalid");
  const result: Record<string, { cpu_millis: number; memory_bytes: number; gpu_count?: number }> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
    const limit = exact(entry, ["cpu_millis", "memory_bytes"], `execution evidence sidecar ${name}`, ["gpu_count"]);
    if (!validText(name, 255) || !Number.isSafeInteger(limit.cpu_millis) || (limit.cpu_millis as number) < 1
      || !Number.isSafeInteger(limit.memory_bytes) || (limit.memory_bytes as number) < 1
      || (limit.gpu_count !== undefined && (!Number.isSafeInteger(limit.gpu_count) || (limit.gpu_count as number) < 1))) throw new TypeError("execution evidence sidecar limits are invalid");
    result[name] = { cpu_millis: limit.cpu_millis as number, memory_bytes: limit.memory_bytes as number, ...(limit.gpu_count === undefined ? {} : { gpu_count: limit.gpu_count as number }) };
  }
  return result;
}

function resources(value: unknown, label: string): ResourceVectorV1 {
  const record = exact(value, RESOURCE_FIELDS, label, ["gpu_count", "ephemeral_disk_bytes"]);
  if (RESOURCE_FIELDS.some((name) => !Number.isSafeInteger(record[name]) || (record[name] as number) < 0)) throw new TypeError(`${label} is invalid`);
  if (record.gpu_count !== undefined && (!Number.isSafeInteger(record.gpu_count) || (record.gpu_count as number) < 0)) throw new TypeError(`${label} is invalid`);
  if (record.ephemeral_disk_bytes !== undefined && (!Number.isSafeInteger(record.ephemeral_disk_bytes) || (record.ephemeral_disk_bytes as number) < 0)) throw new TypeError(`${label} is invalid`);
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
