import path from "node:path";
import type {
  AcquireManagedInferenceInputV1,
  ManagedInferenceCoordinator,
  ManagedInferenceLeaseV1,
  Sha256,
} from "../domain/index.js";
import { HitchError, atomicWriteJSON, ensureDir, sha256JSON, statePaths } from "../foundation/index.js";
import { prepareLocalInference, SGLangServiceSupervisor } from "../inference/index.js";
import type { LocalInferencePreflightOptions, SGLangServiceLease } from "../inference/index.js";
import { LocalModelGateway } from "../model-access/index.js";
import type { LocalModelGatewayOptions } from "../model-access/index.js";
import type { ResourceLedger, ResourceLease } from "./resources.js";

export interface LocalInferenceManagerOptions {
  root: string;
  resources?: ResourceLedger;
  supervisor?: SGLangServiceSupervisor;
  preflight?: (options: LocalInferencePreflightOptions) => ReturnType<typeof prepareLocalInference>;
  startGateway?: (options: LocalModelGatewayOptions) => Promise<LocalModelGateway>;
  onEvent?: (event: Record<string, unknown>) => void;
}

interface ManagedService {
  key: string;
  serviceId: string;
  gateway: LocalModelGateway;
  resources?: ResourceLease;
  refs: number;
  cleanup?: NodeJS.Timeout;
}

export class LocalInferenceManager implements ManagedInferenceCoordinator {
  private readonly root: string;
  private readonly resources: ResourceLedger | undefined;
  private readonly supervisor: SGLangServiceSupervisor;
  private readonly preflight: (options: LocalInferencePreflightOptions) => ReturnType<typeof prepareLocalInference>;
  private readonly startGateway: (options: LocalModelGatewayOptions) => Promise<LocalModelGateway>;
  private readonly onEvent: ((event: Record<string, unknown>) => void) | undefined;
  private readonly services = new Map<string, ManagedService>();
  private readonly serviceById = new Map<string, ManagedService>();
  private readonly gatewayPending = new Map<string, Promise<ManagedService>>();
  private readonly resourceLeases = new Map<string, ResourceLease>();
  private closed = false;

  constructor(options: LocalInferenceManagerOptions) {
    this.root = options.root;
    this.resources = options.resources;
    this.onEvent = options.onEvent;
    this.supervisor = options.supervisor ?? new SGLangServiceSupervisor({ root: options.root, ...(options.onEvent ? { onEvent: options.onEvent } : {}) });
    this.preflight = options.preflight ?? prepareLocalInference;
    this.startGateway = options.startGateway ?? LocalModelGateway.start;
  }

  async initialize(): Promise<void> {
    await this.supervisor.recover();
  }

  async acquire(input: AcquireManagedInferenceInputV1): Promise<ManagedInferenceLeaseV1> {
    if (this.closed) throw new HitchError("local inference manager is closed", { code: "inference_route_unavailable", exitCode: 12 });
    const prepared = await this.preflight({
      root: this.root,
      selection: input.selection,
      harnessRef: input.harness_ref,
      ...(input.signal ? { runtime: { signal: input.signal } } : {}),
      ...(input.on_event ? { onProgress: (message) => input.on_event?.({ type: "inference.preparing", message }) } : {}),
    });
    const cacheScopeOwner = prepared.lock.execution.prefix_cache.mode === "disabled"
      ? "prefix-cache-disabled"
      : input.cache_scope_owner;
    const isolationKey = sha256JSON({ inference_id: prepared.lock.inference_id, cache_scope_owner: cacheScopeOwner });
    const serviceKey = `${prepared.lock.inference_id}:${isolationKey}`;
    let allocation = this.resourceLeases.get(serviceKey);
    if (!allocation && this.resources) {
      if (!this.resources.canEverFit(prepared.lock.resources)) {
        throw new HitchError("local inference resources exceed daemon capacity", { code: "inference_capacity_exceeded", exitCode: 12 });
      }
      allocation = this.resources.tryAcquire(serviceKey, "inference", prepared.lock.resources) ?? undefined;
      if (!allocation) throw new HitchError("local inference resources are currently unavailable", { code: "inference_capacity_exceeded", exitCode: 12 });
      this.resourceLeases.set(serviceKey, allocation);
    }
    let serviceLease: SGLangServiceLease;
    try {
      serviceLease = await this.supervisor.acquire({
        lock: prepared.lock,
        model: prepared.model,
        runtime: prepared.runtime,
        isolationKey,
        ownerId: input.run_id,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      if (!this.services.has(serviceKey) && allocation && this.resourceLeases.get(serviceKey) === allocation) {
        this.resourceLeases.delete(serviceKey);
        allocation.release();
      }
      throw error;
    }
    const managed = await this.ensureGateway(serviceKey, serviceLease, prepared.lock, allocation, input);
    if (managed.cleanup) clearTimeout(managed.cleanup);
    delete managed.cleanup;
    managed.refs += 1;
    let registration;
    try {
      registration = managed.gateway.register(input.run_id);
      await writeInferenceEvidence(this.root, input.run_id, input.evidence_owner, {
        lock: prepared.lock,
        model: prepared.model,
        runtime: prepared.runtime,
        service: { service_id: serviceLease.service_id, epoch: serviceLease.epoch, isolation_key: isolationKey },
        doctor: prepared.doctor ?? null,
      });
      input.on_event?.({
        type: "inference.ready", run_id: input.run_id, service_id: serviceLease.service_id,
        inference_id: prepared.lock.inference_id, backend: prepared.lock.execution.platform.backend,
      });
    } catch (error) {
      registration?.revoke();
      managed.refs = Math.max(0, managed.refs - 1);
      await serviceLease.release();
      this.scheduleCleanup(managed, prepared.lock.execution.idle_ttl_ms);
      throw error;
    }
    let released = false;
    return {
      binding: registration.binding,
      credential: registration.credential,
      lock: prepared.lock,
      service_id: serviceLease.service_id,
      service_epoch: serviceLease.epoch,
      release: async () => {
        if (released) return;
        released = true;
        registration.revoke();
        managed.refs = Math.max(0, managed.refs - 1);
        await serviceLease.release();
        this.scheduleCleanup(managed, prepared.lock.execution.idle_ttl_ms);
      },
    };
  }

  async list() { return this.supervisor.list(); }

  async stop(serviceId?: string, force = false): Promise<void> {
    const selected = [...this.serviceById.values()].filter((entry) => serviceId === undefined || entry.serviceId === serviceId);
    await this.supervisor.stop(serviceId, force);
    for (const entry of selected) await this.cleanupManagedService(entry);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.supervisor.close();
    for (const service of [...this.services.values()]) await this.cleanupManagedService(service);
  }

  private async ensureGateway(
    key: string,
    lease: SGLangServiceLease,
    lock: ManagedInferenceLeaseV1["lock"],
    resources: ResourceLease | undefined,
    input: AcquireManagedInferenceInputV1,
  ): Promise<ManagedService> {
    const existing = this.services.get(key);
    if (existing) return existing;
    let pending = this.gatewayPending.get(key);
    if (!pending) {
      pending = (async () => {
        const gateway = await this.startGateway({
          upstreamBaseUrl: lease.base_url,
          engineToken: lease.engine_token,
          wireModel: lease.wire_model,
          lock,
          ...(input.on_event ? { onRequest: input.on_event } : {}),
        });
        const managed: ManagedService = { key, serviceId: lease.service_id, gateway, refs: 0, ...(resources ? { resources } : {}) };
        this.services.set(key, managed);
        this.serviceById.set(lease.service_id, managed);
        return managed;
      })();
      this.gatewayPending.set(key, pending);
      pending.finally(() => { if (this.gatewayPending.get(key) === pending) this.gatewayPending.delete(key); }).catch(() => {});
    }
    try { return await pending; } catch (error) {
      if (resources && this.resourceLeases.get(key) === resources) this.resourceLeases.delete(key);
      resources?.release();
      await lease.release();
      throw error;
    }
  }

  private scheduleCleanup(service: ManagedService, idleTtlMs: number): void {
    if (service.refs !== 0 || service.cleanup) return;
    service.cleanup = setTimeout(() => { this.cleanupManagedService(service).catch(() => {}); }, idleTtlMs + 100);
    service.cleanup.unref?.();
  }

  private async cleanupManagedService(service: ManagedService): Promise<void> {
    if (service.cleanup) clearTimeout(service.cleanup);
    delete service.cleanup;
    if (this.services.get(service.key) !== service) return;
    this.services.delete(service.key);
    this.serviceById.delete(service.serviceId);
    if (this.resourceLeases.get(service.key) === service.resources) this.resourceLeases.delete(service.key);
    await service.gateway.close().catch(() => {});
    service.resources?.release();
  }
}

async function writeInferenceEvidence(
  root: string,
  runId: string,
  owner: AcquireManagedInferenceInputV1["evidence_owner"],
  evidence: Record<string, unknown>,
): Promise<void> {
  if (!/^run_[a-f0-9]{32}$/.test(runId)) throw new TypeError("inference evidence run ID is invalid");
  if (owner && (!/^eval_[a-f0-9]{32}$/.test(owner.eval_id)
    || owner.rerun_id !== undefined && !/^rerun_[a-f0-9]{32}$/.test(owner.rerun_id))) {
    throw new TypeError("inference evidence eval identity is invalid");
  }
  const directory = await ensureDir(owner
    ? owner.rerun_id
      ? path.join(statePaths(root).evals, owner.eval_id, "reruns", owner.rerun_id, "inference")
      : path.join(statePaths(root).evals, owner.eval_id, "inference")
    : path.join(statePaths(root).runs, runId, "inference"));
  await Promise.all([
    atomicWriteJSON(path.join(directory, "lock.json"), evidence.lock),
    atomicWriteJSON(path.join(directory, "model.manifest.json"), evidence.model),
    atomicWriteJSON(path.join(directory, "runtime.manifest.json"), evidence.runtime),
    atomicWriteJSON(path.join(directory, "execution.json"), {
      schema_version: "1", run_id: runId,
      ...(owner ? { eval_id: owner.eval_id, ...(owner.rerun_id ? { rerun_id: owner.rerun_id } : {}) } : {}),
      service: evidence.service, doctor: evidence.doctor,
      prepared_at: new Date().toISOString(),
    }),
  ]);
}
