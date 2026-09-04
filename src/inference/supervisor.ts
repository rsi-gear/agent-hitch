import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  InferenceLockV1,
  InferenceRuntimeManifestV1,
  InferenceServiceRecordV1,
  LocalModelManifestV1,
  Sha256,
} from "../domain/index.js";
import { HitchError, appendLine, atomicWriteJSON, readJSON, statePaths } from "../foundation/index.js";
import type { SGLangLaunchedService, SGLangLauncher } from "./sglang.js";
import { DockerSGLangLauncher } from "./sglang.js";
import { parseInferenceServiceRecord } from "./manifest.js";

export interface AcquireSGLangServiceInput {
  lock: InferenceLockV1;
  model: LocalModelManifestV1;
  runtime: InferenceRuntimeManifestV1;
  isolationKey: Sha256;
  ownerId: string;
  signal?: AbortSignal;
}

export interface SGLangServiceLease {
  service_id: string;
  inference_id: Sha256;
  epoch: number;
  base_url: string;
  wire_model: string;
  engine_token: string;
  release(): Promise<void>;
}

export interface SGLangServiceSupervisorOptions {
  root: string;
  launcher?: SGLangLauncher;
  onEvent?: (event: Record<string, unknown>) => void;
}

interface ServiceEntry {
  key: string;
  lock: InferenceLockV1;
  record: InferenceServiceRecordV1;
  service: SGLangLaunchedService;
  owners: Map<string, number>;
  idleTimer?: NodeJS.Timeout;
}

export class SGLangServiceSupervisor {
  private readonly root: string;
  private readonly launcher: SGLangLauncher;
  private readonly onEvent: ((event: Record<string, unknown>) => void) | undefined;
  private readonly services = new Map<string, ServiceEntry>();
  private readonly pending = new Map<string, Promise<ServiceEntry>>();
  private epoch = 0;

  constructor(options: SGLangServiceSupervisorOptions) {
    this.root = options.root;
    this.launcher = options.launcher ?? new DockerSGLangLauncher();
    this.onEvent = options.onEvent;
  }

  async acquire(input: AcquireSGLangServiceInput): Promise<SGLangServiceLease> {
    validateAcquire(input);
    const key = `${input.lock.inference_id}:${input.isolationKey}`;
    let entry = this.services.get(key);
    if (!entry) {
      let startup = this.pending.get(key);
      if (!startup) {
        startup = this.start(key, input);
        this.pending.set(key, startup);
        startup.finally(() => { if (this.pending.get(key) === startup) this.pending.delete(key); }).catch(() => {});
      }
      entry = await startup;
    }
    if (entry.record.state !== "ready") throw new HitchError("SGLang service is not ready", { code: "inference_route_unavailable", exitCode: 12 });
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    delete entry.idleTimer;
    entry.owners.set(input.ownerId, (entry.owners.get(input.ownerId) ?? 0) + 1);
    await this.updateOwners(entry);
    await this.emit(entry, "inference.acquired", { owner_id: input.ownerId });
    let released = false;
    return {
      service_id: entry.record.service_id,
      inference_id: entry.record.inference_id,
      epoch: entry.record.epoch,
      base_url: entry.service.base_url,
      wire_model: entry.service.wire_model,
      engine_token: entry.service.engine_token,
      release: async () => {
        if (released) return;
        released = true;
        await this.release(entry as ServiceEntry, input.ownerId);
      },
    };
  }

  async list(): Promise<InferenceServiceRecordV1[]> {
    const persisted = await readServiceRecords(this.root);
    const current = new Map(persisted.map((record) => [record.service_id, record]));
    for (const entry of this.services.values()) current.set(entry.record.service_id, entry.record);
    return [...current.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async stop(serviceId?: string, force = false): Promise<void> {
    const entries = [...this.services.values()].filter((entry) => serviceId === undefined || entry.record.service_id === serviceId);
    if (serviceId && entries.length === 0) throw new HitchError(`inference service not found: ${serviceId}`, { code: "inference_route_unavailable", exitCode: 2 });
    if (!force && entries.some((entry) => totalOwners(entry) > 0)) {
      throw new HitchError("inference service has active leases", { code: "inference_in_use", exitCode: 2 });
    }
    await Promise.all(entries.map((entry) => this.stopEntry(entry)));
  }

  async recover(): Promise<void> {
    for (const record of await readServiceRecords(this.root)) {
      if (!new Set(["starting", "ready", "draining"]).has(record.state)) continue;
      const status = this.launcher.stopOrphan ? await this.launcher.stopOrphan(this.root, record) : "ambiguous";
      const now = new Date().toISOString();
      if (status === "ambiguous") {
        await writeRecord(this.root, {
          ...record,
          state: "failed",
          lease_owner_ids: [],
          updated_at: now,
          error: { code: "inference_recovery_ambiguous", message: "could not verify ownership of the prior service" },
        });
      } else {
        await writeRecord(this.root, { ...record, state: "stopped", lease_owner_ids: [], updated_at: now });
      }
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.services.values()].map((entry) => this.stopEntry(entry)));
  }

  private async start(key: string, input: AcquireSGLangServiceInput): Promise<ServiceEntry> {
    const now = new Date().toISOString();
    const serviceId = `inference_${randomUUID().replaceAll("-", "")}`;
    const record: InferenceServiceRecordV1 = {
      schema_version: "1",
      service_id: serviceId,
      inference_id: input.lock.inference_id,
      isolation_key: input.isolationKey,
      state: "starting",
      epoch: ++this.epoch,
      owner_id: input.ownerId,
      lease_owner_ids: [],
      backend: input.lock.execution.platform.backend,
      started_at: now,
      updated_at: now,
    };
    await writeRecord(this.root, record);
    await this.emitRecord(record, "inference.starting");
    try {
      const launched = await this.launcher.start({
        root: this.root, serviceId, lock: input.lock, model: input.model, runtime: input.runtime,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const ready: InferenceServiceRecordV1 = {
        ...record,
        state: "ready",
        container_id: launched.container_id,
        base_url: launched.base_url,
        updated_at: new Date().toISOString(),
      };
      const entry: ServiceEntry = { key, lock: input.lock, record: ready, service: launched, owners: new Map() };
      this.services.set(key, entry);
      await writeRecord(this.root, ready);
      await this.emit(entry, "inference.ready");
      return entry;
    } catch (error) {
      const failed: InferenceServiceRecordV1 = {
        ...record,
        state: "failed",
        updated_at: new Date().toISOString(),
        error: { code: (error as { code?: string }).code || "inference_process_exited", message: (error as Error).message },
      };
      await writeRecord(this.root, failed);
      await this.emitRecord(failed, "inference.failed", { error: failed.error });
      throw error;
    }
  }

  private async release(entry: ServiceEntry, ownerId: string): Promise<void> {
    if (this.services.get(entry.key) !== entry) return;
    const count = entry.owners.get(ownerId) ?? 0;
    if (count <= 1) entry.owners.delete(ownerId); else entry.owners.set(ownerId, count - 1);
    await this.updateOwners(entry);
    await this.emit(entry, "inference.released", { owner_id: ownerId });
    if (totalOwners(entry) > 0 || entry.idleTimer) return;
    entry.idleTimer = setTimeout(() => { this.stopEntry(entry).catch(() => {}); }, entry.lock.execution.idle_ttl_ms);
    entry.idleTimer.unref?.();
  }

  private async updateOwners(entry: ServiceEntry): Promise<void> {
    entry.record = { ...entry.record, lease_owner_ids: [...entry.owners.keys()].sort(), updated_at: new Date().toISOString() };
    await writeRecord(this.root, entry.record);
  }

  private async stopEntry(entry: ServiceEntry): Promise<void> {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    delete entry.idleTimer;
    if (!this.services.has(entry.key)) return;
    entry.record = { ...entry.record, state: "draining", updated_at: new Date().toISOString() };
    await writeRecord(this.root, entry.record);
    await this.emit(entry, "inference.draining");
    try {
      await entry.service.stop();
      entry.record = { ...entry.record, state: "stopped", lease_owner_ids: [], updated_at: new Date().toISOString() };
      await writeRecord(this.root, entry.record);
      await this.emit(entry, "inference.stopped");
    } finally {
      this.services.delete(entry.key);
    }
  }

  private emit(entry: ServiceEntry, type: string, extra: Record<string, unknown> = {}): Promise<void> {
    return this.emitRecord(entry.record, type, extra);
  }

  private async emitRecord(record: InferenceServiceRecordV1, type: string, extra: Record<string, unknown> = {}): Promise<void> {
    const event = {
      schema_version: "1", type, service_id: record.service_id, inference_id: record.inference_id,
      epoch: record.epoch, owner_id: record.owner_id, timestamp: new Date().toISOString(), ...extra,
    };
    await appendLine(path.join(serviceDirectory(this.root, record.service_id), "events.jsonl"), JSON.stringify(event));
    this.onEvent?.(event);
  }
}

async function readServiceRecords(root: string): Promise<InferenceServiceRecordV1[]> {
  const directory = statePaths(root).inferenceServices;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: InferenceServiceRecordV1[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^inference_[a-f0-9]{32}$/.test(entry.name)) continue;
    const file = path.join(directory, entry.name, "state.json");
    try { if ((await lstat(file)).isFile()) records.push(parseInferenceServiceRecord(await readJSON(file))); } catch {}
  }
  return records;
}

function writeRecord(root: string, record: InferenceServiceRecordV1): Promise<void> {
  return atomicWriteJSON(path.join(serviceDirectory(root, record.service_id), "state.json"), record);
}

function serviceDirectory(root: string, serviceId: string): string {
  return path.join(statePaths(root).inferenceServices, serviceId);
}

function totalOwners(entry: ServiceEntry): number {
  return [...entry.owners.values()].reduce((total, count) => total + count, 0);
}

function validateAcquire(input: AcquireSGLangServiceInput): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(input.isolationKey) || !input.ownerId
    || input.lock.model_id !== input.model.model_id || input.lock.runtime_id !== input.runtime.runtime_id) {
    throw new TypeError("SGLang service acquisition identity is invalid");
  }
}
