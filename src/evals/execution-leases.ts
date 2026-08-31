import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ExecutionLeaseStateV1, ExecutionLeaseV1, ResourceVectorV1 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, ensureDir, readJSON, withFileLock } from "../foundation/index.js";

const ACTIVE_STATES = new Set<ExecutionLeaseStateV1>(["offered", "accepted", "running", "releasing"]);
export const DEFAULT_EXECUTION_LEASE_TTL_MS = 45_000;
export const DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS = 10_000;

export interface ExecutionWorkerIdentity {
  workerId: string;
  provider: string;
  collisionDomainId: string;
  parentAllocationId?: string;
}

export interface ExecutionLeaseHandle {
  readonly leaseId: string;
  current(): ExecutionLeaseV1;
  markRunning(expectedEpoch?: number): Promise<ExecutionLeaseV1>;
  heartbeat(expectedEpoch?: number): Promise<ExecutionLeaseV1>;
  release(expectedEpoch?: number): Promise<ExecutionLeaseV1>;
}

export async function createExecutionLease(input: {
  evalDirectory: string;
  evalId: string;
  workId: string;
  worker: ExecutionWorkerIdentity;
  reservation: ResourceVectorV1;
  ttlMs: number;
}): Promise<ExecutionLeaseHandle> {
  validateWorker(input.worker);
  const reservation = parseResourceVector(input.reservation, "execution lease reservation");
  if (!/^eval_[a-f0-9]{32}$/.test(input.evalId) || !/^work_[a-f0-9]{32}$/.test(input.workId)) throw new TypeError("execution lease work identity is invalid");
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1) throw new TypeError("execution lease ttl must be a positive safe integer");
  const leaseId = `lease_${randomUUID().replaceAll("-", "")}`;
  const issuedAt = new Date();
  const file = path.join(await ensureDir(path.join(input.evalDirectory, "leases")), `${leaseId}.json`);
  let lease = parseExecutionLease({
    schema_version: "1",
    lease_id: leaseId,
    work_id: input.workId,
    eval_id: input.evalId,
    worker_id: input.worker.workerId,
    provider: input.worker.provider,
    collision_domain_id: input.worker.collisionDomainId,
    ...(input.worker.parentAllocationId ? { parent_allocation_id: input.worker.parentAllocationId } : {}),
    reservation,
    state: "accepted",
    epoch: 1,
    issued_at: issuedAt.toISOString(),
    accepted_at: issuedAt.toISOString(),
    heartbeat_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + input.ttlMs).toISOString(),
  });
  await atomicWriteJSON(file, lease);
  let tail: Promise<void> = Promise.resolve();
  const update = (operation: () => Promise<ExecutionLeaseV1>): Promise<ExecutionLeaseV1> => {
    let result!: ExecutionLeaseV1;
    const current = tail.then(async () => { result = await operation(); });
    tail = current.catch(() => {});
    return current.then(() => result);
  };
  return {
    leaseId,
    current: () => lease,
    markRunning: (expectedEpoch = lease.epoch) => update(async () => {
      lease = await mutateLease(file, lease.lease_id, expectedEpoch, async (current) => {
        if (current.state === "running") return current;
        if (current.state !== "accepted") throw new TypeError(`execution lease cannot start from ${current.state}`);
        return writeLease(file, renewedLease({ ...current, state: "running" }, input.ttlMs));
      });
      return lease;
    }),
    heartbeat: (expectedEpoch = lease.epoch) => update(async () => {
      lease = await mutateLease(file, lease.lease_id, expectedEpoch, async (current) => {
        assertCanHeartbeat(current);
        return writeLease(file, renewedLease(current, input.ttlMs));
      });
      return lease;
    }),
    release: (expectedEpoch = lease.epoch) => update(async () => {
      lease = await mutateLease(file, lease.lease_id, expectedEpoch, async (current) => {
        if (current.state === "released" || current.state === "lost" || current.state === "expired") return current;
        const now = new Date().toISOString();
        const releasing = await writeLease(file, { ...current, state: "releasing", heartbeat_at: now });
        return writeLease(file, { ...releasing, state: "released", heartbeat_at: now, terminal_at: now });
      });
      return lease;
    }),
  };
}

export async function heartbeatExecutionLease(input: {
  evalDirectory: string;
  leaseId: string;
  expectedEpoch: number;
  ttlMs?: number;
}): Promise<ExecutionLeaseV1> {
  if (!/^lease_[a-f0-9]{32}$/.test(input.leaseId)) throw new TypeError("execution lease id is invalid");
  const ttlMs = input.ttlMs ?? DEFAULT_EXECUTION_LEASE_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError("execution lease ttl must be a positive safe integer");
  const file = path.join(input.evalDirectory, "leases", `${input.leaseId}.json`);
  return mutateLease(file, input.leaseId, input.expectedEpoch, async (lease) => {
    assertCanHeartbeat(lease);
    return writeLease(file, renewedLease(lease, ttlMs));
  });
}

export async function reissueExecutionLease(input: {
  evalDirectory: string;
  leaseId: string;
  expectedEpoch: number;
  ttlMs?: number;
}): Promise<ExecutionLeaseV1> {
  const { file, ttlMs } = leaseMutationInput(input);
  return mutateLease(file, input.leaseId, input.expectedEpoch, async (lease) => {
    if (lease.state !== "accepted" && lease.state !== "running" && lease.state !== "expired") {
      throw new HitchError(`execution lease cannot be reissued from ${lease.state}`, { code: "lease_not_recoverable", exitCode: 12 });
    }
    const { terminal_at: _terminalAt, ...active } = lease;
    return writeLease(file, renewedLease({ ...active, state: "running", epoch: lease.epoch + 1 }, ttlMs));
  });
}

export async function markExecutionLeaseLost(input: {
  evalDirectory: string;
  leaseId: string;
  expectedEpoch: number;
}): Promise<ExecutionLeaseV1> {
  const { file } = leaseMutationInput(input);
  return mutateLease(file, input.leaseId, input.expectedEpoch, async (lease) => {
    if (!ACTIVE_STATES.has(lease.state)) return lease;
    const now = new Date().toISOString();
    return writeLease(file, {
      ...lease,
      state: "lost",
      epoch: lease.epoch + 1,
      heartbeat_at: now,
      terminal_at: now,
    });
  });
}

export async function readExecutionLeases(evalDirectory: string): Promise<ExecutionLeaseV1[]> {
  const directory = path.join(evalDirectory, "leases");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const leases: ExecutionLeaseV1[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/^lease_[a-f0-9]{32}\.json$/.test(entry.name)) continue;
    leases.push(parseExecutionLease(await readJSON<unknown>(path.join(directory, entry.name))));
  }
  return leases.sort((left, right) => left.issued_at.localeCompare(right.issued_at) || left.lease_id.localeCompare(right.lease_id));
}

export async function recoverExecutionLeases(evalDirectory: string): Promise<ExecutionLeaseV1[]> {
  const leases = await readExecutionLeases(evalDirectory);
  const recovered: ExecutionLeaseV1[] = [];
  for (const lease of leases) {
    if (!ACTIVE_STATES.has(lease.state)) continue;
    recovered.push(await markExecutionLeaseLost({
      evalDirectory,
      leaseId: lease.lease_id,
      expectedEpoch: lease.epoch,
    }));
  }
  return recovered;
}

export function parseExecutionLease(value: unknown): ExecutionLeaseV1 {
  if (!isRecord(value)) throw new TypeError("execution lease must be an object");
  assertOnlyKeys(value, [
    "schema_version", "lease_id", "work_id", "eval_id", "worker_id", "provider", "collision_domain_id",
    "parent_allocation_id", "reservation", "state", "epoch", "issued_at", "accepted_at", "heartbeat_at",
    "expires_at", "terminal_at",
  ]);
  const states = new Set<ExecutionLeaseStateV1>(["offered", "accepted", "running", "releasing", "released", "expired", "lost"]);
  if (value.schema_version !== "1" || typeof value.lease_id !== "string" || !/^lease_[a-f0-9]{32}$/.test(value.lease_id)
    || typeof value.work_id !== "string" || !/^work_[a-f0-9]{32}$/.test(value.work_id)
    || typeof value.eval_id !== "string" || !/^eval_[a-f0-9]{32}$/.test(value.eval_id)
    || typeof value.worker_id !== "string" || !value.worker_id || typeof value.provider !== "string" || !value.provider
    || typeof value.collision_domain_id !== "string" || !value.collision_domain_id
    || !states.has(value.state as ExecutionLeaseStateV1) || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1
    || !timestamp(value.issued_at) || !timestamp(value.expires_at)) {
    throw new TypeError("execution lease identity is invalid");
  }
  if (value.parent_allocation_id !== undefined && (typeof value.parent_allocation_id !== "string" || !/^allocation_[a-f0-9]{32}$/.test(value.parent_allocation_id))) {
    throw new TypeError("execution lease parent allocation is invalid");
  }
  for (const name of ["accepted_at", "heartbeat_at", "terminal_at"] as const) {
    if (value[name] !== undefined && !timestamp(value[name])) throw new TypeError(`execution lease ${name} is invalid`);
  }
  const terminal = value.state === "released" || value.state === "expired" || value.state === "lost";
  if (terminal !== (value.terminal_at !== undefined)) throw new TypeError("execution lease terminal state is inconsistent");
  return {
    schema_version: "1",
    lease_id: value.lease_id,
    work_id: value.work_id,
    eval_id: value.eval_id,
    worker_id: value.worker_id,
    provider: value.provider,
    collision_domain_id: value.collision_domain_id,
    ...(value.parent_allocation_id === undefined ? {} : { parent_allocation_id: value.parent_allocation_id }),
    reservation: parseResourceVector(value.reservation, "execution lease reservation"),
    state: value.state as ExecutionLeaseStateV1,
    epoch: value.epoch as number,
    issued_at: value.issued_at,
    ...(value.accepted_at === undefined ? {} : { accepted_at: value.accepted_at as string }),
    ...(value.heartbeat_at === undefined ? {} : { heartbeat_at: value.heartbeat_at as string }),
    expires_at: value.expires_at,
    ...(value.terminal_at === undefined ? {} : { terminal_at: value.terminal_at as string }),
  };
}

async function writeLease(file: string, value: ExecutionLeaseV1): Promise<ExecutionLeaseV1> {
  const lease = parseExecutionLease(value);
  await atomicWriteJSON(file, lease);
  return lease;
}

async function mutateLease(
  file: string,
  leaseId: string,
  expectedEpoch: number,
  operation: (lease: ExecutionLeaseV1) => Promise<ExecutionLeaseV1>,
): Promise<ExecutionLeaseV1> {
  return withFileLock(path.join(path.dirname(file), ".locks"), leaseId, async () => {
    const persisted = parseExecutionLease(await readJSON<unknown>(file));
    if (persisted.lease_id !== leaseId) throw new HitchError("execution lease identity changed", { code: "lease_identity_mismatch", exitCode: 12 });
    assertEpoch(persisted, expectedEpoch);
    return operation(persisted);
  }, { timeoutCode: "lease_update_locked", timeoutExitCode: 12 });
}

function renewedLease(lease: ExecutionLeaseV1, ttlMs: number): ExecutionLeaseV1 {
  const now = new Date();
  return {
    ...lease,
    heartbeat_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

function leaseMutationInput(input: {
  evalDirectory: string;
  leaseId: string;
  ttlMs?: number;
}): { file: string; ttlMs: number } {
  if (!/^lease_[a-f0-9]{32}$/.test(input.leaseId)) throw new TypeError("execution lease id is invalid");
  const ttlMs = input.ttlMs ?? DEFAULT_EXECUTION_LEASE_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError("execution lease ttl must be a positive safe integer");
  return { file: path.join(input.evalDirectory, "leases", `${input.leaseId}.json`), ttlMs };
}

function assertEpoch(lease: ExecutionLeaseV1, expectedEpoch: number): void {
  if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1 || expectedEpoch !== lease.epoch) {
    throw new HitchError(`execution lease epoch mismatch: expected ${lease.epoch}, received ${expectedEpoch}`, {
      code: "lease_epoch_mismatch",
      exitCode: 12,
    });
  }
}

function assertCanHeartbeat(lease: ExecutionLeaseV1): void {
  if (lease.state !== "accepted" && lease.state !== "running") {
    throw new HitchError(`execution lease cannot heartbeat from ${lease.state}`, { code: "lease_not_active", exitCode: 12 });
  }
}

function validateWorker(worker: ExecutionWorkerIdentity): void {
  if (!worker.workerId || !worker.provider || !worker.collisionDomainId) throw new TypeError("execution worker identity is invalid");
  if (worker.parentAllocationId !== undefined && !/^allocation_[a-f0-9]{32}$/.test(worker.parentAllocationId)) {
    throw new TypeError("execution worker parent allocation is invalid");
  }
}

function parseResourceVector(value: unknown, label: string): ResourceVectorV1 {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const fields = ["cpu_millis", "memory_bytes", "container_slots", "build_slots"] as const;
  if (Object.keys(value).some((key) => !fields.includes(key as typeof fields[number]))) throw new TypeError(`${label} has unknown fields`);
  for (const field of fields) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) throw new TypeError(`${label} ${field} is invalid`);
  }
  return Object.fromEntries(fields.map((field) => [field, value[field]])) as unknown as ResourceVectorV1;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unexpected) throw new TypeError(`execution lease has unknown field: ${unexpected}`);
}
