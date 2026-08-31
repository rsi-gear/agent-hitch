import { randomUUID } from "node:crypto";
import type { ResourceAllocationV1, ResourceVectorV1 } from "../domain/index.js";

export type ResourceKind = ResourceAllocationV1["kind"];

export interface ResourceLease {
  allocation: ResourceAllocationV1;
  release(): void;
}

export interface ResourceLedgerSnapshot {
  capacity: ResourceVectorV1;
  allocated: ResourceVectorV1;
  available: ResourceVectorV1;
  allocations: ResourceAllocationV1[];
}

const RESOURCE_FIELDS = ["cpu_millis", "memory_bytes", "container_slots", "build_slots"] as const;

export class ResourceLedger {
  readonly capacity: ResourceVectorV1;
  private readonly allocations = new Map<string, ResourceAllocationV1>();
  private readonly listeners = new Set<() => void>();

  constructor(capacity: ResourceVectorV1) {
    this.capacity = validateResourceVector(capacity, "resource capacity");
  }

  tryAcquire(ownerId: string, kind: ResourceKind, resources: ResourceVectorV1): ResourceLease | null {
    if (!ownerId) throw new TypeError("resource owner_id must be non-empty");
    const requested = validateResourceVector(resources, "resource request");
    const available = this.available();
    if (!fits(requested, available)) return null;
    const allocation: ResourceAllocationV1 = {
      allocation_id: `allocation_${randomUUID().replaceAll("-", "")}`,
      owner_id: ownerId,
      kind,
      resources: requested,
      acquired_at: new Date().toISOString(),
    };
    this.allocations.set(allocation.allocation_id, allocation);
    let released = false;
    return {
      allocation,
      release: () => {
        if (released) return;
        released = true;
        this.release(allocation.allocation_id);
      },
    };
  }

  canEverFit(resources: ResourceVectorV1): boolean {
    return fits(validateResourceVector(resources, "resource request"), this.capacity);
  }

  maximumUnits(unit: ResourceVectorV1, requested: number): number {
    if (!Number.isSafeInteger(requested) || requested < 0) throw new TypeError("requested units must be a non-negative safe integer");
    const normalized = validateResourceVector(unit, "resource unit");
    const available = this.available();
    let limit = requested;
    for (const field of RESOURCE_FIELDS) {
      const cost = normalized[field];
      if (cost > 0) limit = Math.min(limit, Math.floor(available[field] / cost));
    }
    return limit;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ResourceLedgerSnapshot {
    const allocated = this.allocated();
    return {
      capacity: { ...this.capacity },
      allocated,
      available: subtract(this.capacity, allocated),
      allocations: [...this.allocations.values()].map((allocation) => ({
        ...allocation,
        resources: { ...allocation.resources },
      })),
    };
  }

  private allocated(): ResourceVectorV1 {
    const total = zeroResources();
    for (const allocation of this.allocations.values()) addInto(total, allocation.resources);
    return total;
  }

  private available(): ResourceVectorV1 {
    return subtract(this.capacity, this.allocated());
  }

  private release(allocationId: string): void {
    if (!this.allocations.delete(allocationId)) return;
    for (const listener of this.listeners) queueMicrotask(listener);
  }
}

export function zeroResources(): ResourceVectorV1 {
  return { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
}

export function scaleResources(resources: ResourceVectorV1, units: number): ResourceVectorV1 {
  const normalized = validateResourceVector(resources, "resource vector");
  if (!Number.isSafeInteger(units) || units < 0) throw new TypeError("resource scale must be a non-negative safe integer");
  const result = zeroResources();
  for (const field of RESOURCE_FIELDS) {
    const value = normalized[field] * units;
    if (!Number.isSafeInteger(value)) throw new TypeError(`scaled resource ${field} exceeds the safe integer range`);
    result[field] = value;
  }
  return result;
}

export function validateResourceVector(resources: ResourceVectorV1, label: string): ResourceVectorV1 {
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) throw new TypeError(`${label} must be an object`);
  const result = zeroResources();
  for (const field of RESOURCE_FIELDS) {
    const value = resources[field];
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} ${field} must be a non-negative safe integer`);
    result[field] = value;
  }
  return result;
}

function fits(requested: ResourceVectorV1, available: ResourceVectorV1): boolean {
  return RESOURCE_FIELDS.every((field) => requested[field] <= available[field]);
}

function addInto(target: ResourceVectorV1, value: ResourceVectorV1): void {
  for (const field of RESOURCE_FIELDS) target[field] += value[field];
}

function subtract(left: ResourceVectorV1, right: ResourceVectorV1): ResourceVectorV1 {
  return {
    cpu_millis: left.cpu_millis - right.cpu_millis,
    memory_bytes: left.memory_bytes - right.memory_bytes,
    container_slots: left.container_slots - right.container_slots,
    build_slots: left.build_slots - right.build_slots,
  };
}

