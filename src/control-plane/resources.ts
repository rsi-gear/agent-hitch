import { randomUUID } from "node:crypto";
import type { ResourceAllocationV1, ResourceVectorV1, ResourceProfilingPolicyV1, WorkResourceProfilingV1 } from "../domain/index.js";
import { resourceProfilingPolicy, UnknownResourceBudget } from "../foundation/index.js";

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
  resource_profiling: ReturnType<UnknownResourceBudget["snapshot"]>;
}

const REQUIRED_RESOURCE_FIELDS = ["cpu_millis", "memory_bytes", "container_slots", "build_slots"] as const;
const OPTIONAL_RESOURCE_FIELDS = ["gpu_count", "ephemeral_disk_bytes"] as const;
const RESOURCE_FIELDS = [...REQUIRED_RESOURCE_FIELDS, ...OPTIONAL_RESOURCE_FIELDS] as const;

export class ResourceLedger {
  readonly capacity: ResourceVectorV1;
  readonly resourceProfilingPolicy: ResourceProfilingPolicyV1;
  private readonly unknownBudget: UnknownResourceBudget;
  private readonly unknownReleases = new Map<string, () => void>();
  private readonly allocations = new Map<string, ResourceAllocationV1>();
  private readonly listeners = new Set<() => void>();

  constructor(capacity: ResourceVectorV1, profiling?: ResourceProfilingPolicyV1) {
    this.capacity = validateResourceVector(capacity, "resource capacity");
    this.resourceProfilingPolicy = resourceProfilingPolicy(profiling, {});
    this.unknownBudget = new UnknownResourceBudget(this.resourceProfilingPolicy.unknown_max_parallelism);
  }

  tryAcquire(ownerId: string, kind: ResourceKind, resources: ResourceVectorV1, profiling?: WorkResourceProfilingV1): ResourceLease | null {
    if (!ownerId) throw new TypeError("resource owner_id must be non-empty");
    const requested = validateResourceVector(resources, "resource request");
    const available = this.available();
    if (!fits(requested, available)) return null;
    const releaseUnknown = this.unknownBudget.tryAcquire(profiling);
    if (!releaseUnknown) return null;
    const allocation: ResourceAllocationV1 = {
      allocation_id: `allocation_${randomUUID().replaceAll("-", "")}`,
      owner_id: ownerId,
      kind,
      resources: requested,
      acquired_at: new Date().toISOString(),
      ...(profiling ? { resource_profiling: structuredClone(profiling) } : {}),
    };
    this.allocations.set(allocation.allocation_id, allocation);
    this.unknownReleases.set(allocation.allocation_id, releaseUnknown);
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

  canEverFit(resources: ResourceVectorV1, profiling?: WorkResourceProfilingV1): boolean {
    return fits(validateResourceVector(resources, "resource request"), this.capacity) && this.unknownBudget.canEverFit(profiling);
  }

  /** Read-only admission check for callers that must acquire collision locks first. */
  canAcquire(resources: ResourceVectorV1, profiling?: WorkResourceProfilingV1): boolean {
    if (!fits(validateResourceVector(resources, "resource request"), this.available()) || !this.unknownBudget.canEverFit(profiling)) return false;
    if (!profiling?.unknown) return true;
    const budget = this.unknownBudget.snapshot();
    return budget.active_unknown_slots + profiling.unknown_slots <= Math.min(budget.effective_limit, profiling.unknown_max_parallelism);
  }

  maximumUnits(unit: ResourceVectorV1, requested: number): number {
    if (!Number.isSafeInteger(requested) || requested < 0) throw new TypeError("requested units must be a non-negative safe integer");
    const normalized = validateResourceVector(unit, "resource unit");
    const available = this.available();
    let limit = requested;
    for (const field of RESOURCE_FIELDS) {
      const cost = resourceValue(normalized, field);
      if (cost > 0) limit = Math.min(limit, Math.floor(resourceValue(available, field) / cost));
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
      resource_profiling: this.unknownBudget.snapshot(),
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
    for (const field of OPTIONAL_RESOURCE_FIELDS) if (this.capacity[field] !== undefined) total[field] = 0;
    for (const allocation of this.allocations.values()) addInto(total, allocation.resources);
    return total;
  }

  private available(): ResourceVectorV1 {
    return subtract(this.capacity, this.allocated());
  }

  private release(allocationId: string): void {
    if (!this.allocations.delete(allocationId)) return;
    this.unknownReleases.get(allocationId)?.();
    this.unknownReleases.delete(allocationId);
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
  for (const field of REQUIRED_RESOURCE_FIELDS) {
    const value = normalized[field] * units;
    if (!Number.isSafeInteger(value)) throw new TypeError(`scaled resource ${field} exceeds the safe integer range`);
    result[field] = value;
  }
  for (const field of OPTIONAL_RESOURCE_FIELDS) if (normalized[field] !== undefined) {
    const value = normalized[field] * units;
    if (!Number.isSafeInteger(value)) throw new TypeError(`scaled resource ${field} exceeds the safe integer range`);
    result[field] = value;
  }
  return result;
}

export function validateResourceVector(resources: ResourceVectorV1, label: string): ResourceVectorV1 {
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) throw new TypeError(`${label} must be an object`);
  const result = zeroResources();
  if (Object.keys(resources).some((field) => !RESOURCE_FIELDS.includes(field as typeof RESOURCE_FIELDS[number]))) {
    throw new TypeError(`${label} has unknown fields`);
  }
  for (const field of REQUIRED_RESOURCE_FIELDS) {
    const value = resources[field];
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} ${field} must be a non-negative safe integer`);
    result[field] = value;
  }
  for (const field of OPTIONAL_RESOURCE_FIELDS) if (resources[field] !== undefined) {
    if (!Number.isSafeInteger(resources[field]) || (resources[field] as number) < 0) throw new TypeError(`${label} ${field} must be a non-negative safe integer`);
    result[field] = resources[field];
  }
  return result;
}

function fits(requested: ResourceVectorV1, available: ResourceVectorV1): boolean {
  return RESOURCE_FIELDS.every((field) => resourceValue(requested, field) <= resourceValue(available, field));
}

function addInto(target: ResourceVectorV1, value: ResourceVectorV1): void {
  for (const field of REQUIRED_RESOURCE_FIELDS) target[field] += value[field];
  for (const field of OPTIONAL_RESOURCE_FIELDS) if (value[field] !== undefined || target[field] !== undefined) {
    target[field] = (target[field] ?? 0) + (value[field] ?? 0);
  }
}

function subtract(left: ResourceVectorV1, right: ResourceVectorV1): ResourceVectorV1 {
  const result: ResourceVectorV1 = {
    cpu_millis: left.cpu_millis - right.cpu_millis,
    memory_bytes: left.memory_bytes - right.memory_bytes,
    container_slots: left.container_slots - right.container_slots,
    build_slots: left.build_slots - right.build_slots,
  };
  for (const field of OPTIONAL_RESOURCE_FIELDS) if (left[field] !== undefined || right[field] !== undefined) {
    result[field] = (left[field] ?? 0) - (right[field] ?? 0);
  }
  return result;
}

export function resourceValue(resources: ResourceVectorV1, field: keyof ResourceVectorV1): number {
  return resources[field] ?? 0;
}

export function sumResourceVectors(resources: readonly ResourceVectorV1[]): ResourceVectorV1 {
  const result = zeroResources();
  for (const value of resources) addInto(result, value);
  return result;
}

export function maxResourceVectors(left: ResourceVectorV1, right: ResourceVectorV1): ResourceVectorV1 {
  const result: ResourceVectorV1 = {
    cpu_millis: Math.max(left.cpu_millis, right.cpu_millis),
    memory_bytes: Math.max(left.memory_bytes, right.memory_bytes),
    container_slots: Math.max(left.container_slots, right.container_slots),
    build_slots: Math.max(left.build_slots, right.build_slots),
  };
  for (const field of OPTIONAL_RESOURCE_FIELDS) if (left[field] !== undefined || right[field] !== undefined) {
    result[field] = Math.max(left[field] ?? 0, right[field] ?? 0);
  }
  return result;
}

export function subtractResourceVectors(left: ResourceVectorV1, right: ResourceVectorV1): ResourceVectorV1 {
  return subtract(left, right);
}
