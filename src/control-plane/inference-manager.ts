import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AcquireManagedInferenceInputV1,
  ManagedInferenceCoordinator,
  ManagedInferenceLeaseV1,
  InferenceLockV1,
  LocalInferenceSelectionV1,
} from "../domain/index.js";
import { HitchError, atomicWriteJSON, ensureDir, sha256JSON, statePaths } from "../foundation/index.js";
import { prepareLocalInference, SGLangServiceSupervisor } from "../inference/index.js";
import type { LocalInferencePreflightOptions, LocalInferencePreflightResultV1, SGLangServiceLease } from "../inference/index.js";
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
  lock: InferenceLockV1;
  invalidated?: boolean;
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
    this.supervisor.subscribeTerminal(async (record, released) => {
      const service = this.serviceById.get(record.service_id);
      if (service) {
        service.invalidated = true;
        await service.gateway.close();
        if (released) await this.cleanupManagedService(service);
      } else if (released) {
        const key = `${record.inference_id}:${record.isolation_key}`;
        this.resourceLeases.get(key)?.release();
        this.resourceLeases.delete(key);
      }
    });
  }

  async initialize(): Promise<void> {
    await this.supervisor.recover();
  }

  async acquire(input: AcquireManagedInferenceInputV1): Promise<ManagedInferenceLeaseV1> {
    if (this.closed) throw new HitchError("local inference manager is closed", { code: "inference_route_unavailable", exitCode: 12 });
    const prepared = await this.prepareInputs(input);
    return (await this.acquirePrepared(input, prepared, true)).lease;
  }

  private prepareInputs(input: AcquireManagedInferenceInputV1) {
    return this.preflight({
      root: this.root,
      selection: input.selection,
      harnessRef: input.harness_ref,
      reusableLocks: [...this.services.values()].filter((s) => !s.invalidated).map((s) => s.lock),
      ...(input.signal ? { runtime: { signal: input.signal } } : {}),
      ...(input.on_event ? { onProgress: (message) => input.on_event?.({ type: "inference.preparing", message }) } : {}),
    });
  }

  private async acquirePrepared(input: AcquireManagedInferenceInputV1, prepared: LocalInferencePreflightResultV1, persistEvidence: boolean) {
    if (this.closed) throw new HitchError("local inference manager is closed", { code: "inference_route_unavailable", exitCode: 12 });
    if (input.signal?.aborted) throw new HitchError("inference acquisition cancelled", { code: "cancelled", exitCode: 9 });
    const cacheScopeOwner = prepared.lock.execution.prefix_cache.mode === "disabled"
      ? "prefix-cache-disabled"
      : input.cache_scope_owner;
    const isolationKey = sha256JSON({ inference_id: prepared.lock.inference_id, cache_scope_owner: cacheScopeOwner });
    const serviceKey = `${prepared.lock.inference_id}:${isolationKey}`;
    let allocation = this.resourceLeases.get(serviceKey);
    if (!allocation && this.resources) {
      if (!this.resources.canEverFit(prepared.lock.resources)) {
        const missing = Object.entries(prepared.lock.resources).filter(([key, value]) => value > (this.resources!.capacity[key as keyof typeof prepared.lock.resources] ?? 0))
          .map(([key, value]) => `${key} requires ${value}`);
        throw new HitchError(`local inference resources exceed daemon capacity (${missing.join(", ")}); restart the daemon with sufficient --capacity-* limits`, { code: "inference_capacity_exceeded", exitCode: 12 });
      }
      allocation = this.resources.tryAcquire(serviceKey, "inference", prepared.lock.resources) ?? undefined;
      if (!allocation) throw new HitchError("local inference resources are currently unavailable", { code: "inference_capacity_exceeded", exitCode: 12 });
      this.resourceLeases.set(serviceKey, allocation);
    }
    // Only a supervisor terminal event confirms that the engine no longer owns
    // these resources. An acquisition failure alone is not such confirmation.
    const serviceLease = await this.supervisor.acquire({
      lock: prepared.lock,
      model: prepared.model,
      runtime: prepared.runtime,
      isolationKey,
      ownerId: input.run_id,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const managed = await this.ensureGateway(serviceKey, serviceLease, prepared.lock, allocation, input);
    managed.refs += 1;
    let registration;
    try {
      if (!serviceLease.isReady() || input.signal?.aborted) throw new HitchError("inference service is no longer available", { code: "inference_route_unavailable", exitCode: 12 });
      registration = managed.gateway.register(input.run_id);
      if (persistEvidence) await writeInferenceEvidence(this.root, input.run_id, input.evidence_owner, {
        lock: prepared.lock,
        model: prepared.model,
        runtime: prepared.runtime,
        service: { service_id: serviceLease.service_id, epoch: serviceLease.epoch, isolation_key: isolationKey },
        doctor: prepared.doctor ?? null,
        observation: serviceLease.observation ?? null,
      });
      input.on_event?.({
        type: "inference.ready", run_id: input.run_id, service_id: serviceLease.service_id,
        inference_id: prepared.lock.inference_id, backend: prepared.lock.execution.platform.backend,
      });
    } catch (error) {
      registration?.revoke();
      managed.refs = Math.max(0, managed.refs - 1);
      await serviceLease.release();
      throw error;
    }
    let released = false;
    const lease: ManagedInferenceLeaseV1 = {
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
      },
    };
    return { lease, observation: serviceLease.observation ?? null };
  }

  async prepare(selection: LocalInferenceSelectionV1, signal?: AbortSignal, onEvent?: (event: Record<string, unknown>) => void) {
    if (this.closed) throw new HitchError("local inference manager is closed", { code: "inference_route_unavailable", exitCode: 12 });
    const id = `run_${randomUUID().replaceAll("-", "")}`;
    const input: AcquireManagedInferenceInputV1 = {
      run_id: id, harness_ref: "model-call", selection, cache_scope_owner: id,
      ...(signal ? { signal } : {}), ...(onEvent ? { on_event: onEvent } : {}),
    };
    const prepared = await this.prepareInputs(input);
    const { lease, observation } = await this.acquirePrepared(input, prepared, false);
    try {
      const result = { schema_version: "1", ...prepared, observation };
      await atomicWriteJSON(path.join(statePaths(this.root).inferenceLocks, prepared.lock.inference_id.slice(7), "validation.json"), result);
      return result;
    } finally {
      await lease.release();
      try { await this.stop(lease.service_id); } catch (error) {
        if ((error as { code?: string }).code !== "inference_in_use") throw error;
      }
    }
  }

  async list() { return this.supervisor.list(); }

  async stop(serviceId?: string, force = false): Promise<void> {
    await this.supervisor.stop(serviceId, force);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.supervisor.close();
  }

  private async ensureGateway(
    key: string,
    lease: SGLangServiceLease,
    lock: ManagedInferenceLeaseV1["lock"],
    resources: ResourceLease | undefined,
    input: AcquireManagedInferenceInputV1,
  ): Promise<ManagedService> {
    const existing = this.services.get(key);
    if (existing && existing.serviceId === lease.service_id && !existing.invalidated) return existing;
    let pending = this.gatewayPending.get(lease.service_id);
    if (!pending) {
      pending = (async () => {
        const gateway = await this.startGateway({
          upstreamBaseUrl: lease.base_url,
          engineToken: lease.engine_token,
          wireModel: lease.wire_model,
          lock,
          ...(input.on_event ? { onRequest: input.on_event } : {}),
        });
        if (!lease.isReady()) {
          await gateway.close();
          throw new HitchError("inference service failed while opening its gateway", { code: "inference_route_unavailable", exitCode: 12 });
        }
        const managed: ManagedService = { key, serviceId: lease.service_id, gateway, lock, refs: 0, ...(resources ? { resources } : {}) };
        this.services.set(key, managed);
        this.serviceById.set(lease.service_id, managed);
        return managed;
      })();
      this.gatewayPending.set(lease.service_id, pending);
      pending.finally(() => { if (this.gatewayPending.get(lease.service_id) === pending) this.gatewayPending.delete(lease.service_id); }).catch(() => {});
    }
    try { return await pending; } catch (error) {
      await lease.release();
      try { await this.supervisor.stop(lease.service_id); } catch { /* Other owners or an ambiguous stop retain the reservation. */ }
      throw error;
    }
  }

  private async cleanupManagedService(service: ManagedService): Promise<void> {
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
      service: evidence.service, doctor: evidence.doctor, observation: evidence.observation,
      prepared_at: new Date().toISOString(),
    }),
  ]);
}
