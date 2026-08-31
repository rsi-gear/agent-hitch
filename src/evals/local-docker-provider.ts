import { lstat } from "node:fs/promises";
import path from "node:path";
import type {
  BackendWorkItemV1,
  ExecutionLeaseV1,
  ExecutionProvider,
  ExecutionProviderStatusV1,
  ProviderOfferResultV1,
  ProviderPlanInputV1,
  ProviderPlanResultV1,
  ProviderRecoveryResultV1,
} from "../domain/index.js";
import {
  HitchError,
  atomicWriteJSON,
  captureProcessIdentity,
  ensureDir,
  inspectProcessIdentity,
  readJSON,
  validateProcessIdentity,
  withFileLock,
} from "../foundation/index.js";
import type { ProcessIdentityV1 } from "../foundation/index.js";

export interface LocalProviderExecutionRecordV1 {
  schema_version: "1";
  provider: "local-docker";
  worker_id: string;
  eval_id: string;
  work_id: string;
  lease_id: string;
  lease_epoch: number;
  backend_directory: string;
  process: ProcessIdentityV1;
  state: "running" | "terminal" | "released";
  started_at: string;
  completed_at?: string;
  process_exit_code?: number | null;
  signal?: string | null;
}

export interface LocalDockerExecutionProviderOptions {
  root: string;
  workerId: string;
  status: () => ExecutionProviderStatusV1 | Promise<ExecutionProviderStatusV1>;
}

export class LocalDockerExecutionProvider implements ExecutionProvider {
  readonly id = "local-docker";
  private readonly root: string;
  private readonly workerId: string;
  private readonly status: () => ExecutionProviderStatusV1 | Promise<ExecutionProviderStatusV1>;

  constructor({ root, workerId, status }: LocalDockerExecutionProviderOptions) {
    if (!root || !workerId) throw new TypeError("local Docker provider identity is invalid");
    this.root = root;
    this.workerId = workerId;
    this.status = status;
  }

  async inspect(): Promise<ExecutionProviderStatusV1> {
    const status = parseExecutionProviderStatus(await this.status());
    if (status.provider !== this.id || status.worker_id !== this.workerId) throw new TypeError("local Docker provider status identity changed");
    return status;
  }

  async plan(input: ProviderPlanInputV1): Promise<ProviderPlanResultV1> {
    const status = await this.inspect();
    const constraints: string[] = [];
    if (!status.platforms.includes(input.platform)) constraints.push("platform_unavailable");
    if (input.adapter_requirements.needs_docker && !status.features.docker) constraints.push("docker_unavailable");
    if (input.adapter_requirements.needs_model_proxy && !status.features.model_proxy) constraints.push("model_proxy_unavailable");
    return { supported: constraints.length === 0, reservation: { ...input.work.reservation }, constraints };
  }

  async offer(lease: ExecutionLeaseV1, work: BackendWorkItemV1): Promise<ProviderOfferResultV1> {
    if (lease.provider !== this.id || lease.worker_id !== this.workerId) return { accepted: false, rejection_code: "worker_identity_mismatch" };
    if (lease.work_id !== work.work_id) return { accepted: false, rejection_code: "work_identity_mismatch" };
    return { accepted: true, handle: this.handle(lease.lease_id) };
  }

  async processStarted(input: { evalDirectory: string; lease: ExecutionLeaseV1; backendDirectory: string; pid: number }): Promise<LocalProviderExecutionRecordV1> {
    if (input.lease.provider !== this.id || input.lease.worker_id !== this.workerId) throw new TypeError("local provider lease identity is invalid");
    return recordLocalDockerProcessStart({ root: this.root, workerId: this.workerId, ...input });
  }

  async processExited(input: { leaseId: string; epoch: number; code: number | null; signal: NodeJS.Signals | null }): Promise<LocalProviderExecutionRecordV1> {
    return recordLocalDockerProcessExit({ root: this.root, ...input });
  }

  async adoptLeaseEpoch(leaseId: string, expectedEpoch: number, nextEpoch: number): Promise<LocalProviderExecutionRecordV1> {
    return adoptLocalDockerLeaseEpoch({ root: this.root, leaseId, expectedEpoch, nextEpoch });
  }

  async recover(lease: ExecutionLeaseV1): Promise<ProviderRecoveryResultV1> {
    const evalDirectory = evalDirectoryFor(this.root, lease.eval_id);
    const record = await readRecord(evalDirectory, lease.lease_id);
    if (!record || record.eval_id !== lease.eval_id || record.work_id !== lease.work_id || record.lease_epoch !== lease.epoch) return { state: "ambiguous" };
    if (record.state === "released") return { state: "released", handle: this.handle(lease.lease_id) };
    if (record.state === "terminal") return { state: "terminal-uncollected", handle: this.handle(lease.lease_id) };
    const status = await inspectProcessIdentity(record.process);
    if (status === "running") return { state: "running", handle: this.handle(lease.lease_id) };
    if (status === "terminal" || status === "identity-mismatch") return { state: "terminal-uncollected", handle: this.handle(lease.lease_id) };
    return { state: "ambiguous" };
  }

  async cancel(leaseId: string, epoch: number): Promise<void> {
    const { record } = await this.locate(leaseId, epoch);
    if (record.state !== "running" || await inspectProcessIdentity(record.process) !== "running") return;
    try {
      process.kill(process.platform === "win32" ? record.process.pid : -record.process.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  async release(leaseId: string, epoch: number): Promise<void> {
    await releaseLocalDockerProcessRecord({ root: this.root, leaseId, epoch });
  }

  private handle(leaseId: string): { provider: string; worker_id: string; native_id: string } {
    return { provider: this.id, worker_id: this.workerId, native_id: leaseId };
  }

  private async locate(leaseId: string, epoch: number): Promise<{ evalDirectory: string; record: LocalProviderExecutionRecordV1 }> {
    return locateProviderRecord(this.root, leaseId, epoch);
  }
}

export function parseExecutionProviderStatus(value: unknown): ExecutionProviderStatusV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("execution provider status must be an object");
  const status = value as Record<string, unknown>;
  const allowed = new Set(["schema_version", "provider", "worker_id", "collision_domain_id", "health", "platforms", "backends", "features", "capacity", "heartbeat_at"]);
  if (Object.keys(status).some((key) => !allowed.has(key)) || status.schema_version !== "1"
    || typeof status.provider !== "string" || !status.provider || typeof status.worker_id !== "string" || !status.worker_id
    || typeof status.collision_domain_id !== "string" || !status.collision_domain_id
    || !new Set(["healthy", "degraded", "unavailable"]).has(String(status.health))
    || !Array.isArray(status.platforms) || status.platforms.length < 1 || status.platforms.some((entry) => typeof entry !== "string" || !entry)
    || !Array.isArray(status.backends) || status.backends.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry as object).some((key) => key !== "id" && key !== "version")
      || typeof (entry as { id?: unknown }).id !== "string" || !(entry as { id: string }).id
      || typeof (entry as { version?: unknown }).version !== "string" || !(entry as { version: string }).version)
    || typeof status.heartbeat_at !== "string" || !Number.isFinite(Date.parse(status.heartbeat_at))) {
    throw new TypeError("execution provider status identity is invalid");
  }
  const features = exactRecord(status.features, ["docker", "buildkit", "model_proxy", "isolated_same_task_attempts"], "execution provider features");
  if (Object.values(features).some((entry) => typeof entry !== "boolean")) throw new TypeError("execution provider features are invalid");
  const capacity = exactRecord(status.capacity, ["total", "allocatable", "allocated"], "execution provider capacity");
  const total = providerResources(capacity.total, "total");
  const allocatable = providerResources(capacity.allocatable, "allocatable");
  const allocated = providerResources(capacity.allocated, "allocated");
  for (const field of ["cpu_millis", "memory_bytes", "container_slots", "build_slots"] as const) {
    if (allocatable[field] > total[field] || allocated[field] > allocatable[field]) throw new TypeError("execution provider capacity accounting is invalid");
  }
  return {
    ...(status as unknown as Omit<ExecutionProviderStatusV1, "features" | "capacity">),
    features: features as unknown as ExecutionProviderStatusV1["features"],
    capacity: { total, allocatable, allocated },
  };
}

export async function recordLocalDockerProcessStart(input: {
  root: string;
  workerId: string;
  evalDirectory: string;
  lease: ExecutionLeaseV1;
  backendDirectory: string;
  pid: number;
}): Promise<LocalProviderExecutionRecordV1> {
  if (input.lease.provider !== "local-docker" || input.lease.worker_id !== input.workerId) throw new TypeError("local provider lease identity is invalid");
  const processIdentity = await captureProcessIdentity(input.pid);
  if (!processIdentity) throw new HitchError("could not capture Harbor process start identity", { code: "provider_process_identity_unavailable", exitCode: 12 });
  const record = parseLocalProviderExecutionRecord({
    schema_version: "1",
    provider: "local-docker",
    worker_id: input.workerId,
    eval_id: input.lease.eval_id,
    work_id: input.lease.work_id,
    lease_id: input.lease.lease_id,
    lease_epoch: input.lease.epoch,
    backend_directory: relativeDirectory(input.evalDirectory, input.backendDirectory),
    process: processIdentity,
    state: "running",
    started_at: new Date().toISOString(),
  });
  await writeRecord(input.evalDirectory, record);
  await writeLeaseIndex(input.root, record);
  return record;
}

export async function recordLocalDockerProcessExit(input: {
  root: string;
  leaseId: string;
  epoch: number;
  code: number | null;
  signal: NodeJS.Signals | null;
}): Promise<LocalProviderExecutionRecordV1> {
  return mutateProviderRecord(input.root, input.leaseId, input.epoch, (record) => {
    if (record.state !== "running") throw new HitchError(`local provider process cannot exit from ${record.state}`, { code: "provider_process_not_running", exitCode: 12 });
    return {
      ...record,
      state: "terminal",
      process_exit_code: input.code,
      signal: input.signal,
      completed_at: new Date().toISOString(),
    };
  });
}

export async function releaseLocalDockerProcessRecord(input: { root: string; leaseId: string; epoch: number }): Promise<LocalProviderExecutionRecordV1> {
  return mutateProviderRecord(input.root, input.leaseId, input.epoch, (record) => {
    if (record.state === "running") throw new HitchError("cannot release a running local provider process", { code: "provider_release_active", exitCode: 12 });
    return { ...record, state: "released", completed_at: record.completed_at ?? new Date().toISOString() };
  });
}

export async function adoptLocalDockerLeaseEpoch(input: { root: string; leaseId: string; expectedEpoch: number; nextEpoch: number }): Promise<LocalProviderExecutionRecordV1> {
  if (!Number.isSafeInteger(input.nextEpoch) || input.nextEpoch !== input.expectedEpoch + 1) throw new TypeError("local provider next lease epoch is invalid");
  return mutateProviderRecord(input.root, input.leaseId, input.expectedEpoch, (record) => ({ ...record, lease_epoch: input.nextEpoch }));
}

export function parseLocalProviderExecutionRecord(value: unknown): LocalProviderExecutionRecordV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("local provider execution record must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["schema_version", "provider", "worker_id", "eval_id", "work_id", "lease_id", "lease_epoch", "backend_directory", "process", "state", "started_at", "completed_at", "process_exit_code", "signal"]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || record.schema_version !== "1" || record.provider !== "local-docker"
    || typeof record.worker_id !== "string" || !record.worker_id
    || typeof record.eval_id !== "string" || !/^eval_[a-f0-9]{32}$/.test(record.eval_id)
    || typeof record.work_id !== "string" || !/^work_[a-f0-9]{32}$/.test(record.work_id)
    || typeof record.lease_id !== "string" || !/^lease_[a-f0-9]{32}$/.test(record.lease_id)
    || !Number.isSafeInteger(record.lease_epoch) || (record.lease_epoch as number) < 1
    || !safeRelativeDirectory(record.backend_directory)
    || !new Set(["running", "terminal", "released"]).has(String(record.state))
    || typeof record.started_at !== "string" || !Number.isFinite(Date.parse(record.started_at))) {
    throw new TypeError("local provider execution record identity is invalid");
  }
  if (record.completed_at !== undefined && (typeof record.completed_at !== "string" || !Number.isFinite(Date.parse(record.completed_at)))) throw new TypeError("local provider completion time is invalid");
  if (record.process_exit_code !== undefined && record.process_exit_code !== null && !Number.isSafeInteger(record.process_exit_code)) throw new TypeError("local provider exit code is invalid");
  if (record.signal !== undefined && record.signal !== null && typeof record.signal !== "string") throw new TypeError("local provider signal is invalid");
  if ((record.state === "terminal" || record.state === "released") !== (record.completed_at !== undefined)) throw new TypeError("local provider terminal state is inconsistent");
  return { ...record, process: validateProcessIdentity(record.process) } as unknown as LocalProviderExecutionRecordV1;
}

async function writeRecord(evalDirectory: string, record: LocalProviderExecutionRecordV1): Promise<void> {
  const directory = await ensureDir(path.join(evalDirectory, "provider", "leases"));
  await atomicWriteJSON(path.join(directory, `${record.lease_id}.json`), parseLocalProviderExecutionRecord(record));
}

async function readRecord(evalDirectory: string, leaseId: string): Promise<LocalProviderExecutionRecordV1 | null> {
  validateLeaseMutation(leaseId, 1, false);
  const file = path.join(evalDirectory, "provider", "leases", `${leaseId}.json`);
  if (!await regularFileOrMissing(file)) return null;
  return parseLocalProviderExecutionRecord(await readJSON<unknown>(file));
}

async function writeLeaseIndex(root: string, record: LocalProviderExecutionRecordV1): Promise<void> {
  const directory = await ensureDir(path.join(root, "providers", "local-docker", "leases"));
  await atomicWriteJSON(path.join(directory, `${record.lease_id}.json`), { schema_version: "1", lease_id: record.lease_id, eval_id: record.eval_id });
}

async function readLeaseIndex(root: string, leaseId: string): Promise<{ eval_id: string } | null> {
  const file = path.join(root, "providers", "local-docker", "leases", `${leaseId}.json`);
  if (!await regularFileOrMissing(file)) return null;
  const value = await readJSON<Record<string, unknown> | null>(file, null);
  if (!value) return null;
  if (Object.keys(value).some((key) => !new Set(["schema_version", "lease_id", "eval_id"]).has(key)) || value.schema_version !== "1" || value.lease_id !== leaseId
    || typeof value.eval_id !== "string" || !/^eval_[a-f0-9]{32}$/.test(value.eval_id)) throw new TypeError("local provider lease index is invalid");
  return { eval_id: value.eval_id };
}

async function mutateProviderRecord(root: string, leaseId: string, epoch: number, update: (record: LocalProviderExecutionRecordV1) => LocalProviderExecutionRecordV1): Promise<LocalProviderExecutionRecordV1> {
  validateLeaseMutation(leaseId, epoch);
  return withFileLock(path.join(root, "providers", "local-docker", ".locks"), leaseId, async () => {
    const { evalDirectory, record } = await locateProviderRecord(root, leaseId, epoch);
    const next = parseLocalProviderExecutionRecord(update(record));
    await writeRecord(evalDirectory, next);
    return next;
  }, { timeoutCode: "provider_record_locked", timeoutExitCode: 12 });
}

async function locateProviderRecord(root: string, leaseId: string, epoch: number): Promise<{ evalDirectory: string; record: LocalProviderExecutionRecordV1 }> {
  validateLeaseMutation(leaseId, epoch);
  const index = await readLeaseIndex(root, leaseId);
  if (!index) throw new HitchError(`local provider lease not found: ${leaseId}`, { code: "provider_lease_not_found", exitCode: 3 });
  const evalDirectory = evalDirectoryFor(root, index.eval_id);
  const record = await readRecord(evalDirectory, leaseId);
  if (!record) throw new HitchError(`local provider record not found: ${leaseId}`, { code: "provider_record_not_found", exitCode: 3 });
  if (record.lease_epoch !== epoch) throw new HitchError("local provider lease epoch mismatch", { code: "lease_epoch_mismatch", exitCode: 12 });
  return { evalDirectory, record };
}

function evalDirectoryFor(root: string, evalId: string): string {
  if (!/^eval_[a-f0-9]{32}$/.test(evalId)) throw new TypeError("local provider eval id is invalid");
  return path.join(root, "evals", evalId);
}

function relativeDirectory(evalDirectory: string, backendDirectory: string): string {
  const relative = path.relative(evalDirectory, backendDirectory).split(path.sep).join("/");
  if (!safeRelativeDirectory(relative)) throw new TypeError("local provider backend directory escapes the eval");
  return relative;
}

function safeRelativeDirectory(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function validateLeaseMutation(leaseId: string, epoch: number, validateEpoch = true): void {
  if (!/^lease_[a-f0-9]{32}$/.test(leaseId)) throw new TypeError("local provider lease id is invalid");
  if (validateEpoch && (!Number.isSafeInteger(epoch) || epoch < 1)) throw new TypeError("local provider lease epoch is invalid");
}

async function regularFileOrMissing(file: string): Promise<boolean> {
  try { return (await lstat(file)).isFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function exactRecord(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record)) || Object.keys(record).some((key) => !keys.includes(key))) {
    throw new TypeError(`${label} fields are invalid`);
  }
  return record;
}

function providerResources(value: unknown, label: string): ExecutionProviderStatusV1["capacity"]["total"] {
  const record = exactRecord(value, ["cpu_millis", "memory_bytes", "container_slots", "build_slots"], `execution provider ${label} resources`);
  for (const entry of Object.values(record)) if (!Number.isSafeInteger(entry) || (entry as number) < 0) throw new TypeError(`execution provider ${label} resources are invalid`);
  return record as unknown as ExecutionProviderStatusV1["capacity"]["total"];
}
