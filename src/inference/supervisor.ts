import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  InferenceRuntimeObservation,
  InferenceLockV1,
  InferenceRuntimeManifestV1,
  InferenceServiceRecordV1,
  LocalModelManifestV1,
  Sha256,
} from "../domain/index.js";
import { HitchError, appendLine, atomicWriteJSON, readJSON, sha256JSON, statePaths } from "../foundation/index.js";
import type { SGLangLaunchedService, SGLangLauncher } from "./sglang.js";
import { ManagedSGLangLauncher } from "./managed-launcher.js";
import { parseInferenceServiceRecord } from "./manifest.js";
import { readServiceAttachment, writeServiceAttachment } from "./service-attachment.js";

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
  observation?: InferenceRuntimeObservation;
  isReady(): boolean;
  release(): Promise<void>;
}

export interface SGLangServiceSupervisorOptions {
  root: string;
  launcher?: SGLangLauncher;
  onEvent?: (event: Record<string, unknown>) => void;
  healthIntervalMs?: number;
}

/** The controller must first verify these owners against durable active work. */
export interface SGLangRecoveryClaim { service_id: string; owner_ids: string[] }
export interface ReattachedSGLangService {
  record: InferenceServiceRecordV1;
  lock: InferenceLockV1;
  owners: Map<string, SGLangServiceLease>;
}

interface ServiceEntry {
  key: string;
  lock: InferenceLockV1;
  record: InferenceServiceRecordV1;
  service: SGLangLaunchedService;
  owners: Map<string, number>;
  idleTimer?: NodeJS.Timeout;
  healthTimer?: NodeJS.Timeout;
  checking?: Promise<void>;
  stopping?: Promise<void>;
}

export class SGLangServiceSupervisor {
  private readonly root: string;
  private readonly launcher: SGLangLauncher;
  private readonly onEvent: ((event: Record<string, unknown>) => void) | undefined;
  private readonly services = new Map<string, ServiceEntry>();
  private readonly pending = new Map<string, Promise<ServiceEntry>>();
  private epoch = 0;
  private closed = false;
  private readonly healthIntervalMs: number;
  private readonly terminalListeners = new Set<(record: InferenceServiceRecordV1, released: boolean) => Promise<void>>();
  private readonly startups = new Set<AbortController>();
  private readonly blocked = new Set<string>();
  private recovering: Promise<ReattachedSGLangService[]> | undefined;

  constructor(options: SGLangServiceSupervisorOptions) {
    this.healthIntervalMs = options.healthIntervalMs ?? 2_000;
    this.root = options.root;
    this.launcher = options.launcher ?? new ManagedSGLangLauncher();
    this.onEvent = options.onEvent;
  }

  async acquire(input: AcquireSGLangServiceInput): Promise<SGLangServiceLease> {
    if (this.closed) throw new HitchError("inference supervisor is closed", { code: "inference_route_unavailable", exitCode: 12 });
    if (this.recovering) throw new HitchError("inference recovery is still coordinating prior ownership", { code: "inference_recovery_ambiguous", exitCode: 12 });
    validateAcquire(input);
    if (input.signal?.aborted) throw new HitchError("inference acquisition cancelled", { code: "cancelled", exitCode: 9 });
    const key = `${input.lock.inference_id}:${input.isolationKey}`;
    if (this.blocked.has(key)) throw new HitchError("prior startup cleanup is ambiguous; restart the daemon to recover", { code: "inference_recovery_ambiguous", exitCode: 12 });
    let entry = this.services.get(key);
    if (!entry) {
      let startup = this.pending.get(key);
      if (!startup) {
        startup = this.start(key, input);
        this.pending.set(key, startup);
        startup.finally(() => { if (this.pending.get(key) === startup) this.pending.delete(key); }).catch(() => {});
      }
      entry = await waitForStartup(startup, input.signal);
    }
    if (input.signal?.aborted) throw new HitchError("inference acquisition cancelled", { code: "cancelled", exitCode: 9 });
    await this.checkEntry(entry);
    if (this.closed || entry.record.state !== "ready") throw new HitchError("SGLang service is not ready", { code: "inference_route_unavailable", exitCode: 12 });
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    delete entry.idleTimer;
    entry.owners.set(input.ownerId, (entry.owners.get(input.ownerId) ?? 0) + 1);
    await this.updateOwners(entry);
    await this.emit(entry, "inference.acquired", { owner_id: input.ownerId });
    return this.lease(entry, input.ownerId);
  }

  private lease(entry: ServiceEntry, ownerId: string): SGLangServiceLease {
    let released = false;
    return {
      service_id: entry.record.service_id,
      inference_id: entry.record.inference_id,
      epoch: entry.record.epoch,
      base_url: entry.service.base_url,
      wire_model: entry.service.wire_model,
      engine_token: entry.service.engine_token,
      ...(entry.service.observation ? { observation: entry.service.observation } : {}),
      isReady: () => !this.closed && this.services.get(entry.key) === entry && entry.record.state === "ready",
      release: async () => {
        if (released) return;
        released = true;
        await this.release(entry, ownerId);
      },
    };
  }

  subscribeTerminal(listener: (record: InferenceServiceRecordV1, released: boolean) => Promise<void>): () => void {
    this.terminalListeners.add(listener);
    return () => { this.terminalListeners.delete(listener); };
  }

  async list(): Promise<InferenceServiceRecordV1[]> {
    const persisted = await readServiceRecords(this.root);
    const current = new Map(persisted.map((record) => [record.service_id, record]));
    for (const entry of this.services.values()) current.set(entry.record.service_id, entry.record);
    return [...current.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async stop(serviceId?: string, force = false): Promise<void> {
    const entries = [...this.services.values()].filter((entry) => serviceId === undefined || entry.record.service_id === serviceId);
    if (serviceId && entries.length === 0) {
      const record = (await readServiceRecords(this.root)).find(item => item.service_id === serviceId);
      if (!record?.model_node) throw new HitchError(`inference service not found: ${serviceId}`, { code: "inference_route_unavailable", exitCode: 2 });
      if (!force && record.lease_owner_ids.length) throw new HitchError("inference service has active leases", { code: "inference_in_use", exitCode: 2 });
      if (await this.launcher.stopOrphan?.(this.root, record) !== "stopped") throw new HitchError("model-node stop is unconfirmed; ownership retained", { code: "inference_recovery_ambiguous", exitCode: 12 });
      await writeRecord(this.root, { ...record, state: "stopped", lease_owner_ids: [], updated_at: new Date().toISOString() });
      return;
    }
    if (!force && entries.some((entry) => totalOwners(entry) > 0)) {
      throw new HitchError("inference service has active leases", { code: "inference_in_use", exitCode: 2 });
    }
    await Promise.all(entries.map((entry) => this.stopEntry(entry)));
    if (entries.some((entry) => this.services.get(entry.key) === entry)) {
      throw new HitchError("inference service stop is unconfirmed; reservations retained", { code: "inference_recovery_ambiguous", exitCode: 12 });
    }
  }

  async recover(claims: readonly SGLangRecoveryClaim[] = []): Promise<ReattachedSGLangService[]> {
    if (this.closed || this.recovering || this.services.size || this.pending.size) throw new TypeError("inference recovery requires an unused supervisor");
    const recovery = this.recoverRecords(structuredClone(claims));
    this.recovering = recovery;
    try { return await recovery; } finally { if (this.recovering === recovery) this.recovering = undefined; }
  }

  private async recoverRecords(claims: readonly SGLangRecoveryClaim[]): Promise<ReattachedSGLangService[]> {
    const records = await readServiceRecords(this.root);
    const requested = new Map(claims.map(claim => [claim.service_id, claim.owner_ids]));
    if (requested.size !== claims.length || claims.some(claim => {
      const record = records.find(item => item.service_id === claim.service_id);
      return !record || record.state !== "ready" || !record.model_node || !Array.isArray(claim.owner_ids) || !claim.owner_ids.length
        || new Set(claim.owner_ids).size !== claim.owner_ids.length || claim.owner_ids.some(owner => !record.lease_owner_ids.includes(owner));
    })) throw new HitchError("active service recovery claims differ from persisted owners", { code: "inference_recovery_ambiguous", exitCode: 12 });
    const recovered: ReattachedSGLangService[] = [];
    for (const record of records) {
      this.epoch = Math.max(this.epoch, record.epoch);
      if (record.state === "stopped") continue;
      const owners = requested.get(record.service_id);
      if (owners) {
        const key = `${record.inference_id}:${record.isolation_key}`;
        this.blocked.add(key);
        if (!this.launcher.attach || this.services.has(key)) throw new HitchError("live service attachment is unavailable", { code: "inference_recovery_ambiguous", exitCode: 12 });
        const input = await readServiceAttachment(this.root, record);
        const service = await this.launcher.attach(input);
        if (this.closed) throw new HitchError("inference recovery was closed before attachment completed; prior ownership retained", { code: "inference_recovery_ambiguous", exitCode: 12 });
        if (sha256JSON(service.service_handle ?? null) !== sha256JSON(record.service_handle) || service.container_id) {
          throw new HitchError("attached process differs from its original service handle", { code: "inference_recovery_ambiguous", exitCode: 12 });
        }
        const entry: ServiceEntry = { key, lock: input.lock, record: { ...record, base_url: service.base_url }, service, owners: new Map(owners.map(owner => [owner, 1])) };
        await this.updateOwners(entry);
        this.services.set(key, entry); this.blocked.delete(key);
        if (service.checkHealth) {
          entry.healthTimer = setInterval(() => { this.checkEntry(entry).catch(() => {}); }, this.healthIntervalMs);
          entry.healthTimer.unref?.();
        }
        await this.emit(entry, "inference.reattached");
        recovered.push({ record: entry.record, lock: entry.lock, owners: new Map(owners.map(owner => [owner, this.lease(entry, owner)])) });
        continue;
      }
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
        throw new HitchError("could not recover prior inference service; reservations retained", { code: "inference_recovery_ambiguous", exitCode: 12 });
      } else {
        await writeRecord(this.root, { ...record, state: "stopped", lease_owner_ids: [], updated_at: now });
      }
    }
    return recovered;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.startups) controller.abort();
    if (this.recovering) await this.recovering.catch(() => {});
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.services.values()].map((entry) => this.stopEntry(entry)));
  }

  private async start(key: string, input: AcquireSGLangServiceInput): Promise<ServiceEntry> {
    const controller = new AbortController();
    this.startups.add(controller);
    const now = new Date().toISOString();
    const serviceId = `inference_${randomUUID().replaceAll("-", "")}`;
    let record: InferenceServiceRecordV1 = {
      schema_version: "1",
      service_id: serviceId,
      inference_id: input.lock.inference_id,
      isolation_key: input.isolationKey,
      state: "starting",
      epoch: ++this.epoch,
      owner_id: input.ownerId,
      lease_owner_ids: [],
      backend: input.lock.execution.platform.backend,
      ...(input.lock.model_node ? { model_node: input.lock.model_node } : {}),
      started_at: now,
      updated_at: now,
    };
    let launched: SGLangLaunchedService | undefined;
    try {
      await writeRecord(this.root, record);
      await this.emitRecord(record, "inference.starting");
      launched = await this.launcher.start({
        root: this.root, serviceId, lock: input.lock, model: input.model, runtime: input.runtime,
        signal: controller.signal,
        onCreated: async (containerId) => {
          record = { ...record, container_id: containerId, updated_at: new Date().toISOString() };
          await writeRecord(this.root, record);
        },
        onServiceCreated: async (serviceHandle) => {
          record = { ...record, service_handle: serviceHandle, updated_at: new Date().toISOString() };
          await writeRecord(this.root, record);
        },
      });
      const ready: InferenceServiceRecordV1 = {
        ...record,
        state: "ready",
        ...(launched.container_id ? { container_id: launched.container_id } : {}),
        ...(launched.service_handle ? { service_handle: launched.service_handle } : {}),
        base_url: launched.base_url,
        updated_at: new Date().toISOString(),
      };
      const entry: ServiceEntry = { key, lock: input.lock, record: ready, service: launched, owners: new Map() };
      if (ready.model_node) {
        if (launched.observation?.schema_version !== "2") throw new TypeError("model-node service lacks its validated startup observation");
        await writeServiceAttachment(this.root, ready, { lock: input.lock, model: input.model, runtime: input.runtime }, launched.observation);
      }
      this.services.set(key, entry);
      await writeRecord(this.root, ready);
      await this.emit(entry, "inference.ready");
      if (launched.checkHealth) {
        entry.healthTimer = setInterval(() => { this.checkEntry(entry).catch(() => {}); }, this.healthIntervalMs);
        entry.healthTimer.unref?.();
      }
      // If every caller cancelled during startup, still retire the unused engine.
      entry.idleTimer = setTimeout(() => { this.stopEntry(entry).catch(() => {}); }, input.lock.execution.idle_ttl_ms);
      entry.idleTimer.unref?.();
      return entry;
    } catch (error) {
      let released = (error as { code?: string }).code !== "inference_recovery_ambiguous";
      // Even preparation can fail before the node has a service record. Seal a
      // stop tombstone so both usage inspection and a delayed start reconcile
      // the same durable identity instead of treating absence as release.
      if (record.model_node && !launched) {
        try { released = await this.launcher.stopOrphan?.(this.root, record) === "stopped"; }
        catch { released = false; }
      }
      if (launched) {
        const entry = this.services.get(key);
        if (entry) this.clearTimers(entry);
        try { await launched.stop(); } catch { released = false; }
        this.services.delete(key);
      }
      if (!released) this.blocked.add(key);
      const failed: InferenceServiceRecordV1 = {
        ...record,
        state: "failed",
        updated_at: new Date().toISOString(),
        error: { code: released ? (error as { code?: string }).code || "inference_process_exited" : "inference_recovery_ambiguous", message: (error as Error).message },
      };
      await writeRecord(this.root, failed);
      await this.emitRecord(failed, "inference.failed", { error: failed.error });
      await Promise.all([...this.terminalListeners].map((listener) => listener(failed, released)));
      throw error;
    } finally { this.startups.delete(controller); }
  }

  private async release(entry: ServiceEntry, ownerId: string): Promise<void> {
    if (this.services.get(entry.key) !== entry) return;
    const count = entry.owners.get(ownerId) ?? 0;
    if (count <= 1) entry.owners.delete(ownerId); else entry.owners.set(ownerId, count - 1);
    await this.updateOwners(entry);
    await this.emit(entry, "inference.released", { owner_id: ownerId });
    if (entry.record.state !== "ready" || totalOwners(entry) > 0 || entry.idleTimer) return;
    entry.idleTimer = setTimeout(() => { this.stopEntry(entry).catch(() => {}); }, entry.lock.execution.idle_ttl_ms);
    entry.idleTimer.unref?.();
  }

  private async updateOwners(entry: ServiceEntry): Promise<void> {
    entry.record = { ...entry.record, lease_owner_ids: [...entry.owners.keys()].sort(), updated_at: new Date().toISOString() };
    await writeRecord(this.root, entry.record);
  }

  private checkEntry(entry: ServiceEntry): Promise<void> {
    if (!entry.service.checkHealth || entry.record.state !== "ready") return Promise.resolve();
    if (!entry.checking) {
      entry.checking = entry.service.checkHealth().catch(async (error: unknown) => {
        if (entry.record.state === "ready") await this.failEntry(entry, error);
      }).finally(() => { delete entry.checking; });
    }
    return entry.checking;
  }

  private failEntry(entry: ServiceEntry, error: unknown): Promise<void> {
    if (entry.stopping) return entry.stopping;
    if (entry.record.state !== "ready") return Promise.resolve();
    entry.record = { ...entry.record, state: "failed", lease_owner_ids: [], updated_at: new Date().toISOString(),
      error: { code: (error as { code?: string }).code || "inference_route_unavailable", message: (error as Error).message } };
    this.clearTimers(entry);
    entry.stopping = (async () => {
      await writeRecord(this.root, entry.record);
      await this.emit(entry, "inference.failed");
      // Invalidate routes immediately, but retain reservations until termination is confirmed.
      await this.notifyTerminal(entry, false);
      try {
        await entry.service.stop();
        await this.notifyTerminal(entry, true);
        if (this.services.get(entry.key) === entry) this.services.delete(entry.key);
      } catch { /* Failed entry blocks reuse and keeps the physical/resource lease. */ }
    })().finally(() => { delete entry.stopping; });
    return entry.stopping;
  }

  private stopEntry(entry: ServiceEntry): Promise<void> {
    if (entry.stopping) return entry.stopping;
    if (this.services.get(entry.key) !== entry) return Promise.resolve();
    this.clearTimers(entry);
    entry.record = { ...entry.record, state: "draining", updated_at: new Date().toISOString() };
    entry.stopping = (async () => {
      await writeRecord(this.root, entry.record);
      await this.emit(entry, "inference.draining");
      await this.notifyTerminal(entry, false);
      try {
        await entry.service.stop();
        entry.record = { ...entry.record, state: "stopped", lease_owner_ids: [], updated_at: new Date().toISOString() };
        await writeRecord(this.root, entry.record);
        await this.emit(entry, "inference.stopped");
        await this.notifyTerminal(entry, true);
        if (this.services.get(entry.key) === entry) this.services.delete(entry.key);
      } catch (error) {
        entry.record = { ...entry.record, state: "failed", updated_at: new Date().toISOString(),
          error: { code: "inference_recovery_ambiguous", message: "service stop was not confirmed; reservations retained" } };
        await writeRecord(this.root, entry.record);
        throw error;
      } finally { delete entry.stopping; }
    })();
    return entry.stopping;
  }

  private clearTimers(entry: ServiceEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.healthTimer) clearInterval(entry.healthTimer);
    delete entry.idleTimer;
    delete entry.healthTimer;
  }

  private async notifyTerminal(entry: ServiceEntry, released: boolean): Promise<void> {
    await Promise.all([...this.terminalListeners].map((listener) => listener(entry.record, released)));
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

export async function readServiceRecords(root: string): Promise<InferenceServiceRecordV1[]> {
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
    try { if ((await lstat(file)).isFile()) records.push(parseInferenceServiceRecord(await readJSON(file))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HitchError("persisted inference ownership is invalid; repair its record before recovery", {
        code: "inference_recovery_ambiguous", exitCode: 12, cause: error,
      });
    }
  }
  return records;
}

function writeRecord(root: string, record: InferenceServiceRecordV1): Promise<void> {
  return atomicWriteJSON(path.join(serviceDirectory(root, record.service_id), "state.json"), parseInferenceServiceRecord(record));
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

async function waitForStartup<T>(startup: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return startup;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new HitchError("inference acquisition cancelled", { code: "cancelled", exitCode: 9 }));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    startup.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => {});
  });
}
