import type { ResourceLedgerSnapshot } from "../control-plane/index.js";
import type { ExecutionProviderStatusV1, RemoteWorkerPublicRecordV1, ResourceVectorV1 } from "../domain/index.js";

export function healthResources(snapshot: ResourceLedgerSnapshot | null): Record<string, unknown> | null {
  if (!snapshot) return null;
  const fields: Array<keyof ResourceVectorV1> = [
    "cpu_millis", "memory_bytes", "container_slots", "build_slots", "gpu_count", "ephemeral_disk_bytes",
  ];
  return Object.fromEntries(fields.flatMap((field) => {
    const allocatable = snapshot.capacity[field];
    if (allocatable === undefined) return [];
    const allocated = snapshot.allocated[field] ?? 0;
    return [[field, {
      allocated,
      allocatable,
      available: snapshot.available[field] ?? 0,
      utilization: allocatable === 0 ? 0 : allocated / allocatable,
    }]];
  }));
}

export function healthParallelism(snapshot: Record<string, unknown> | null): Record<string, number> {
  const active = Array.isArray(snapshot?.active) ? snapshot.active : [];
  let requested = 0;
  let admitted = 0;
  for (const value of active) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    requested += safeMetric(record.requested_parallelism);
    admitted += safeMetric(record.admitted_parallelism);
  }
  return { requested, admitted, effective: admitted };
}

export function workerHealth(records: RemoteWorkerPublicRecordV1[], local: ExecutionProviderStatusV1 | undefined, localActiveLeases: number): Record<string, unknown> {
  let healthy = 0;
  let degraded = 0;
  let unavailable = 0;
  let oldestHeartbeatAgeSeconds = 0;
  const now = Date.now();
  if (local) {
    if (local.health === "healthy") healthy += 1;
    else if (local.health === "degraded") degraded += 1;
    else unavailable += 1;
    oldestHeartbeatAgeSeconds = Math.max(0, Math.floor((now - Date.parse(local.heartbeat_at)) / 1_000));
  }
  for (const record of records) {
    if (record.provider_status.health === "healthy") healthy += 1;
    else if (record.provider_status.health === "degraded") degraded += 1;
    else unavailable += 1;
    oldestHeartbeatAgeSeconds = Math.max(oldestHeartbeatAgeSeconds, Math.max(0, Math.floor((now - Date.parse(record.heartbeat_at)) / 1_000)));
  }
  return {
    total: records.length + Number(local !== undefined), healthy, degraded, lost: unavailable, unavailable,
    active_leases: safeMetric(localActiveLeases) + records.reduce((count, record) => count + record.active_leases.length, 0),
    oldest_heartbeat_age_seconds: oldestHeartbeatAgeSeconds,
  };
}

function safeMetric(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}
