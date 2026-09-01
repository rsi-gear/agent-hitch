import { randomBytes, timingSafeEqual } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type {
  ExecutionProviderStatusV1,
  ExecutionWorkerV1,
  RemoteWorkerHeartbeatV1,
  RemoteWorkerPublicRecordV1,
  RemoteWorkerRegistrationV1,
  ResourceVectorV1,
} from "../domain/index.js";
import { HitchError, atomicWriteJSON, ensureDir, readJSON, sha256Bytes, statePaths, withFileLock } from "../foundation/index.js";
import { validateResourceVector } from "./resources.js";

const WORKER_ID = /^worker_[a-z0-9][a-z0-9_-]{0,62}$/;
const LEASE_ID = /^lease_[a-f0-9]{32}$/;
const DEFAULT_HEARTBEAT_TTL_MS = 45_000;

interface PersistedRemoteWorkerV1 extends RemoteWorkerPublicRecordV1 {
  token_hash: `sha256:${string}`;
}

export interface RemoteWorkerRegistrationResult {
  worker: RemoteWorkerPublicRecordV1;
  token: string;
}

export class RemoteWorkerRegistry {
  private readonly root: string;
  private readonly directory: string;
  private readonly locks: string;
  private readonly heartbeatTtlMs: number;

  constructor(input: { root: string; heartbeatTtlMs?: number }) {
    if (!input.root) throw new TypeError("remote worker registry root is required");
    const ttl = input.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < 1_000) throw new TypeError("remote worker heartbeat TTL is invalid");
    const paths = statePaths(input.root);
    this.root = paths.root;
    this.directory = paths.workers;
    this.locks = paths.workerLocks;
    this.heartbeatTtlMs = ttl;
  }

  async initialize(): Promise<void> {
    await Promise.all([ensureDir(this.directory), ensureDir(this.locks)]);
  }

  async register(value: unknown): Promise<RemoteWorkerRegistrationResult> {
    const registration = parseRemoteWorkerRegistration(value);
    const token = randomBytes(32).toString("hex");
    const tokenHash = sha256Bytes(token);
    const persisted = await withFileLock(this.locks, registration.worker_id, async () => {
      const existing = await this.readPersisted(registration.worker_id);
      if (existing && (existing.worker.provider !== registration.provider
        || existing.worker.collision_domain_id !== registration.collision_domain_id)) {
        throw new HitchError("remote worker identity cannot be rebound", { code: "worker_identity_conflict", exitCode: 2 });
      }
      const now = new Date().toISOString();
      const next = persistedWorker(registration, tokenHash, existing, now);
      await atomicWriteJSON(this.workerPath(registration.worker_id), next);
      return next;
    }, { timeoutCode: "worker_record_locked", timeoutExitCode: 12 });
    return { worker: publicRecord(persisted), token };
  }

  async authenticate(workerId: string, token: string): Promise<boolean> {
    if (!WORKER_ID.test(workerId) || !/^[a-f0-9]{64}$/.test(token)) return false;
    const record = await this.readPersisted(workerId);
    if (!record || record.revoked_at) return false;
    const supplied = Buffer.from(sha256Bytes(token));
    const expected = Buffer.from(record.token_hash);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  async heartbeat(workerId: string, value: unknown): Promise<RemoteWorkerPublicRecordV1> {
    if (!WORKER_ID.test(workerId)) throw invalidWorker("remote worker id is invalid");
    const heartbeat = parseRemoteWorkerHeartbeat(value);
    const persisted = await withFileLock(this.locks, workerId, async () => {
      const current = await this.requirePersisted(workerId);
      if (current.revoked_at) throw new HitchError("remote worker identity is revoked", { code: "worker_revoked", exitCode: 11 });
      if (heartbeat.generation !== current.generation) throw new HitchError("remote worker generation is stale", { code: "worker_generation_mismatch", exitCode: 12 });
      assertWithin(heartbeat.allocated, current.worker.capacity.allocatable, "remote worker allocation exceeds allocatable capacity");
      const next: PersistedRemoteWorkerV1 = {
        ...current,
        worker: {
          ...current.worker,
          status: heartbeat.health === "unavailable" ? "offline" : "ready",
          capacity: { ...current.worker.capacity, allocated: heartbeat.allocated },
        },
        provider_status: {
          ...current.provider_status,
          health: heartbeat.health,
          capacity: { ...current.provider_status.capacity, allocated: heartbeat.allocated },
          heartbeat_at: heartbeat.sent_at,
        },
        active_leases: heartbeat.active_leases,
        heartbeat_at: heartbeat.sent_at,
      };
      await atomicWriteJSON(this.workerPath(workerId), next);
      return next;
    }, { timeoutCode: "worker_record_locked", timeoutExitCode: 12 });
    return publicRecord(persisted);
  }

  async validateHeartbeatGeneration(workerId: string, generation: number): Promise<void> {
    if (!WORKER_ID.test(workerId) || !Number.isSafeInteger(generation) || generation < 1) throw invalidWorker("remote worker heartbeat identity is invalid");
    const current = await this.requirePersisted(workerId);
    if (current.revoked_at) throw new HitchError("remote worker identity is revoked", { code: "worker_revoked", exitCode: 11 });
    if (generation !== current.generation) throw new HitchError("remote worker generation is stale", { code: "worker_generation_mismatch", exitCode: 12 });
  }

  async revoke(workerId: string): Promise<RemoteWorkerPublicRecordV1> {
    if (!WORKER_ID.test(workerId)) throw invalidWorker("remote worker id is invalid");
    const persisted = await withFileLock(this.locks, workerId, async () => {
      const current = await this.requirePersisted(workerId);
      if (current.revoked_at) return current;
      const now = new Date().toISOString();
      const next: PersistedRemoteWorkerV1 = {
        ...current,
        generation: current.generation + 1,
        worker: { ...current.worker, status: "offline" },
        provider_status: { ...current.provider_status, health: "unavailable", heartbeat_at: now },
        active_leases: [],
        revoked_at: now,
        heartbeat_at: now,
      };
      await atomicWriteJSON(this.workerPath(workerId), next);
      return next;
    }, { timeoutCode: "worker_record_locked", timeoutExitCode: 12 });
    return publicRecord(persisted);
  }

  async get(workerId: string, now = Date.now()): Promise<RemoteWorkerPublicRecordV1 | null> {
    if (!WORKER_ID.test(workerId)) throw invalidWorker("remote worker id is invalid");
    const record = await this.readPersisted(workerId);
    return record ? publicRecord(withLiveness(record, now, this.heartbeatTtlMs)) : null;
  }

  async list(now = Date.now()): Promise<RemoteWorkerPublicRecordV1[]> {
    await ensureDir(this.directory);
    const entries = await readdir(this.directory, { withFileTypes: true });
    const records: RemoteWorkerPublicRecordV1[] = [];
    for (const entry of entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))) {
      if (!entry.isFile() || !/^worker_[a-z0-9][a-z0-9_-]{0,62}\.json$/.test(entry.name)) continue;
      const parsed = parsePersistedRemoteWorker(await readJSON(path.join(this.directory, entry.name)));
      records.push(publicRecord(withLiveness(parsed, now, this.heartbeatTtlMs)));
    }
    return records;
  }

  private workerPath(workerId: string): string {
    return path.join(this.directory, `${workerId}.json`);
  }

  private readPersisted(workerId: string): Promise<PersistedRemoteWorkerV1 | null> {
    return readJSON<unknown | null>(this.workerPath(workerId), null).then((value) => value === null ? null : parsePersistedRemoteWorker(value));
  }

  private async requirePersisted(workerId: string): Promise<PersistedRemoteWorkerV1> {
    const record = await this.readPersisted(workerId);
    if (!record) throw new HitchError(`remote worker not found: ${workerId}`, { code: "worker_not_found", exitCode: 3 });
    return record;
  }
}

export function parseRemoteWorkerRegistration(value: unknown): RemoteWorkerRegistrationV1 {
  const record = exact(value, ["schema_version", "worker_id", "provider", "collision_domain_id", "platforms", "backends", "features", "task_membership", "capacity"], "remote worker registration");
  if (record.schema_version !== "1" || typeof record.worker_id !== "string" || !WORKER_ID.test(record.worker_id)
    || !validText(record.provider) || !validText(record.collision_domain_id)) throw invalidWorker("remote worker registration identity is invalid");
  const platforms = stringSet(record.platforms, "remote worker platforms");
  const memberships = stringSet(record.task_membership, "remote worker task membership");
  if (platforms.length === 0 || memberships.length === 0 || memberships.some((entry) => entry !== "known" && entry !== "opaque")) throw invalidWorker("remote worker capabilities are invalid");
  const backends = parseBackends(record.backends);
  const features = parseFeatures(record.features);
  const capacity = parseRegistrationCapacity(record.capacity);
  return {
    schema_version: "1", worker_id: record.worker_id, provider: record.provider as string,
    collision_domain_id: record.collision_domain_id as string, platforms, backends, features,
    task_membership: memberships as Array<"known" | "opaque">, capacity,
  };
}

export function parseRemoteWorkerHeartbeat(value: unknown): RemoteWorkerHeartbeatV1 {
  const record = exact(value, ["schema_version", "generation", "health", "allocated", "active_leases", "sent_at"], "remote worker heartbeat");
  if (record.schema_version !== "1" || !Number.isSafeInteger(record.generation) || (record.generation as number) < 1
    || !new Set(["healthy", "degraded", "unavailable"]).has(String(record.health))
    || typeof record.sent_at !== "string" || !Number.isFinite(Date.parse(record.sent_at))
    || Math.abs(Date.now() - Date.parse(record.sent_at)) > 5 * 60_000 || !Array.isArray(record.active_leases)) {
    throw invalidWorker("remote worker heartbeat is invalid");
  }
  const leases = parseHeartbeatLeases(record.active_leases);
  return {
    schema_version: "1", generation: record.generation as number,
    health: record.health as RemoteWorkerHeartbeatV1["health"],
    allocated: validateResourceVector(record.allocated as ResourceVectorV1, "remote worker allocated resources"),
    active_leases: leases, sent_at: record.sent_at,
  };
}

function parseHeartbeatLeases(value: unknown): Array<{ lease_id: string; epoch: number }> {
  if (!Array.isArray(value)) throw invalidWorker("remote worker heartbeat leases are invalid");
  const leases = value.map((value) => {
    const lease = exact(value, ["lease_id", "epoch"], "remote worker heartbeat lease");
    if (typeof lease.lease_id !== "string" || !LEASE_ID.test(lease.lease_id)
      || !Number.isSafeInteger(lease.epoch) || (lease.epoch as number) < 1) throw invalidWorker("remote worker heartbeat lease is invalid");
    return { lease_id: lease.lease_id, epoch: lease.epoch as number };
  }).sort((left, right) => left.lease_id.localeCompare(right.lease_id));
  if (new Set(leases.map((lease) => lease.lease_id)).size !== leases.length) throw invalidWorker("remote worker heartbeat leases are duplicated");
  return leases;
}

function persistedWorker(registration: RemoteWorkerRegistrationV1, tokenHash: `sha256:${string}`, existing: PersistedRemoteWorkerV1 | null, now: string): PersistedRemoteWorkerV1 {
  const allocated = zero();
  const worker: ExecutionWorkerV1 = {
    schema_version: "1", worker_id: registration.worker_id, provider: registration.provider, status: "ready",
    collision_domain_id: registration.collision_domain_id,
    capabilities: {
      backends: registration.backends.map((entry) => entry.id), platforms: registration.platforms,
      task_membership: registration.task_membership,
      isolated_same_task_attempts: registration.features.isolated_same_task_attempts, remote: true,
    },
    capacity: { ...registration.capacity, allocated },
  };
  const providerStatus: ExecutionProviderStatusV1 = {
    schema_version: "1", provider: registration.provider, worker_id: registration.worker_id,
    collision_domain_id: registration.collision_domain_id, health: "healthy", platforms: registration.platforms,
    backends: registration.backends, features: registration.features,
    capacity: { total: registration.capacity.total, allocatable: registration.capacity.allocatable, allocated }, heartbeat_at: now,
  };
  return {
    schema_version: "1", generation: (existing?.generation ?? 0) + 1, worker, provider_status: providerStatus,
    active_leases: [], token_hash: tokenHash, registered_at: existing?.registered_at ?? now, heartbeat_at: now,
  };
}

function parsePersistedRemoteWorker(value: unknown): PersistedRemoteWorkerV1 {
  const record = exact(value, ["schema_version", "generation", "worker", "provider_status", "active_leases", "token_hash", "registered_at", "heartbeat_at", "revoked_at"], "persisted remote worker");
  if (record.schema_version !== "1" || !Number.isSafeInteger(record.generation) || (record.generation as number) < 1
    || typeof record.token_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.token_hash)
    || !validTimestamp(record.registered_at) || !validTimestamp(record.heartbeat_at)
    || record.revoked_at !== undefined && !validTimestamp(record.revoked_at)) throw invalidWorker("persisted remote worker identity is invalid");
  const worker = parsePersistedWorker(record.worker);
  const provider = parsePersistedProvider(record.provider_status);
  const activeLeases = parseHeartbeatLeases(record.active_leases);
  if (worker.worker_id !== provider.worker_id || worker.provider !== provider.provider || worker.collision_domain_id !== provider.collision_domain_id
    || JSON.stringify(worker.capacity.allocated) !== JSON.stringify(provider.capacity.allocated)) throw invalidWorker("persisted remote worker views are inconsistent");
  return {
    schema_version: "1", generation: record.generation as number, worker, provider_status: provider,
    active_leases: activeLeases, token_hash: record.token_hash as `sha256:${string}`,
    registered_at: record.registered_at as string, heartbeat_at: record.heartbeat_at as string,
    ...(record.revoked_at === undefined ? {} : { revoked_at: record.revoked_at as string }),
  };
}

function parsePersistedWorker(value: unknown): ExecutionWorkerV1 {
  const record = exact(value, ["schema_version", "worker_id", "provider", "status", "collision_domain_id", "capabilities", "capacity"], "persisted execution worker");
  const capabilities = exact(record.capabilities, ["backends", "platforms", "task_membership", "isolated_same_task_attempts", "remote"], "persisted worker capabilities");
  const capacity = exact(record.capacity, ["total", "reserved_for_system", "allocatable", "allocated"], "persisted worker capacity");
  const registration = parseRemoteWorkerRegistration({
    schema_version: record.schema_version, worker_id: record.worker_id, provider: record.provider,
    collision_domain_id: record.collision_domain_id, platforms: capabilities.platforms,
    backends: stringSet(capabilities.backends, "persisted worker backends").map((id) => ({ id, version: "unknown" })),
    features: { docker: true, buildkit: false, model_proxy: false, isolated_same_task_attempts: capabilities.isolated_same_task_attempts },
    task_membership: capabilities.task_membership,
    capacity: { total: capacity.total, reserved_for_system: capacity.reserved_for_system, allocatable: capacity.allocatable },
  });
  if (!new Set(["ready", "draining", "offline"]).has(String(record.status)) || capabilities.remote !== true) throw invalidWorker("persisted execution worker status is invalid");
  const allocated = validateResourceVector(capacity.allocated as ResourceVectorV1, "persisted worker allocated resources");
  assertWithin(allocated, registration.capacity.allocatable, "persisted worker allocation exceeds capacity");
  return {
    schema_version: "1", worker_id: registration.worker_id, provider: registration.provider,
    status: record.status as ExecutionWorkerV1["status"], collision_domain_id: registration.collision_domain_id,
    capabilities: {
      backends: stringSet(capabilities.backends, "persisted worker backends"), platforms: registration.platforms,
      task_membership: registration.task_membership, isolated_same_task_attempts: registration.features.isolated_same_task_attempts, remote: true,
    }, capacity: { ...registration.capacity, allocated },
  };
}

function parsePersistedProvider(value: unknown): ExecutionProviderStatusV1 {
  const record = exact(value, ["schema_version", "provider", "worker_id", "collision_domain_id", "health", "platforms", "backends", "features", "capacity", "heartbeat_at"], "persisted provider status");
  const capacity = exact(record.capacity, ["total", "allocatable", "allocated"], "persisted provider capacity");
  const total = validateResourceVector(capacity.total as ResourceVectorV1, "persisted provider total resources");
  const allocatable = validateResourceVector(capacity.allocatable as ResourceVectorV1, "persisted provider allocatable resources");
  assertWithin(allocatable, total, "persisted provider allocatable resources exceed total capacity");
  const registration = parseRemoteWorkerRegistration({
    schema_version: record.schema_version, worker_id: record.worker_id, provider: record.provider,
    collision_domain_id: record.collision_domain_id, platforms: record.platforms, backends: record.backends,
    features: record.features, task_membership: ["known"],
    capacity: { total, allocatable, reserved_for_system: subtract(total, allocatable) },
  });
  const allocated = validateResourceVector(capacity.allocated as ResourceVectorV1, "persisted provider allocated resources");
  assertWithin(allocated, registration.capacity.allocatable, "persisted provider allocation exceeds capacity");
  if (!new Set(["healthy", "degraded", "unavailable"]).has(String(record.health)) || !validTimestamp(record.heartbeat_at)) throw invalidWorker("persisted provider status is invalid");
  return {
    schema_version: "1", provider: registration.provider, worker_id: registration.worker_id,
    collision_domain_id: registration.collision_domain_id, health: record.health as ExecutionProviderStatusV1["health"],
    platforms: registration.platforms, backends: registration.backends, features: registration.features,
    capacity: { total: registration.capacity.total, allocatable: registration.capacity.allocatable, allocated }, heartbeat_at: record.heartbeat_at as string,
  };
}

function parseRegistrationCapacity(value: unknown): RemoteWorkerRegistrationV1["capacity"] {
  const capacity = exact(value, ["total", "reserved_for_system", "allocatable"], "remote worker capacity");
  const total = validateResourceVector(capacity.total as ResourceVectorV1, "remote worker total capacity");
  const reserved = validateResourceVector(capacity.reserved_for_system as ResourceVectorV1, "remote worker reserved capacity");
  const allocatable = validateResourceVector(capacity.allocatable as ResourceVectorV1, "remote worker allocatable capacity");
  for (const field of resourceFields()) if (resourceValue(reserved, field) + resourceValue(allocatable, field) !== resourceValue(total, field)) throw invalidWorker("remote worker capacity accounting is invalid");
  return { total, reserved_for_system: reserved, allocatable };
}

function parseBackends(value: unknown): Array<{ id: string; version: string }> {
  if (!Array.isArray(value) || value.length === 0) throw invalidWorker("remote worker backends are invalid");
  const result = value.map((entry) => {
    const backend = exact(entry, ["id", "version"], "remote worker backend");
    if (!validText(backend.id) || !validText(backend.version)) throw invalidWorker("remote worker backend is invalid");
    return { id: backend.id as string, version: backend.version as string };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(result.map((entry) => entry.id)).size !== result.length) throw invalidWorker("remote worker backends are duplicated");
  return result;
}

function parseFeatures(value: unknown): RemoteWorkerRegistrationV1["features"] {
  const features = exact(value, ["docker", "buildkit", "model_proxy", "isolated_same_task_attempts"], "remote worker features");
  if (Object.values(features).some((entry) => typeof entry !== "boolean")) throw invalidWorker("remote worker features are invalid");
  return features as unknown as RemoteWorkerRegistrationV1["features"];
}

function withLiveness(record: PersistedRemoteWorkerV1, now: number, ttl: number): PersistedRemoteWorkerV1 {
  if (record.revoked_at || now - Date.parse(record.heartbeat_at) <= ttl) return record;
  return { ...record, worker: { ...record.worker, status: "offline" }, provider_status: { ...record.provider_status, health: "unavailable" } };
}

function publicRecord(record: PersistedRemoteWorkerV1): RemoteWorkerPublicRecordV1 {
  const { token_hash: _tokenHash, ...visible } = record;
  return structuredClone(visible);
}

function exact(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidWorker(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw invalidWorker(`${label} has unknown fields`);
  return record;
}

function stringSet(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => !validText(entry))) throw invalidWorker(`${label} are invalid`);
  const result = [...value as string[]].sort();
  if (new Set(result).size !== result.length) throw invalidWorker(`${label} are duplicated`);
  return result;
}

function assertWithin(value: ResourceVectorV1, limit: ResourceVectorV1, message: string): void {
  for (const field of resourceFields()) if (resourceValue(value, field) > resourceValue(limit, field)) throw invalidWorker(message);
}

function resourceFields(): Array<keyof ResourceVectorV1> {
  return ["cpu_millis", "memory_bytes", "container_slots", "build_slots", "gpu_count", "ephemeral_disk_bytes"];
}

function zero(): ResourceVectorV1 {
  return { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
}

function subtract(left: ResourceVectorV1, right: ResourceVectorV1): ResourceVectorV1 {
  const result: ResourceVectorV1 = {
    cpu_millis: left.cpu_millis - right.cpu_millis,
    memory_bytes: left.memory_bytes - right.memory_bytes,
    container_slots: left.container_slots - right.container_slots,
    build_slots: left.build_slots - right.build_slots,
  };
  if (left.gpu_count !== undefined || right.gpu_count !== undefined) result.gpu_count = (left.gpu_count ?? 0) - (right.gpu_count ?? 0);
  if (left.ephemeral_disk_bytes !== undefined || right.ephemeral_disk_bytes !== undefined) result.ephemeral_disk_bytes = (left.ephemeral_disk_bytes ?? 0) - (right.ephemeral_disk_bytes ?? 0);
  return result;
}

function resourceValue(resources: ResourceVectorV1, field: keyof ResourceVectorV1): number { return resources[field] ?? 0; }

function validText(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 && !/[\0\r\n]/.test(value);
}

function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function invalidWorker(message: string): HitchError {
  return new HitchError(message, { code: "worker_protocol_invalid", exitCode: 2 });
}
