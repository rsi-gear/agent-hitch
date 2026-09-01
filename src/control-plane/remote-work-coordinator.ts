import path from "node:path";
import type { BackendWorkItemV1, ExecutionLeaseV1, RemoteWorkInputRefV1, RemoteWorkOfferV1, RemoteWorkerPublicRecordV1, ResourceVectorV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import { DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS, DEFAULT_EXECUTION_LEASE_TTL_MS, createExecutionLease, markExecutionLeaseLost, releaseExecutionLease } from "../evals/index.js";
import type { EvalRemoteWorkExecutor } from "../evals/index.js";
import { CollisionLockManager } from "./collisions.js";
import { evalTaskCollisionKey } from "./eval-records.js";
import { importRemoteResultEnvelope } from "./remote-result-transport.js";
import type { RemoteWorkerProtocol } from "./remote-worker-protocol.js";
import type { RemoteWorkerRegistry } from "./remote-workers.js";
import { recoverRemoteWorkerEvalLeases } from "./remote-work-recovery.js";
import { prepareRemoteWorkInputs } from "./remote-work-inputs.js";

export interface RemoteWorkCoordinatorOptions {
  root: string;
  registry: RemoteWorkerRegistry;
  protocol: RemoteWorkerProtocol;
  collisions: CollisionLockManager;
  pollIntervalMs?: number;
  releaseTimeoutMs?: number;
}

export class RemoteWorkCoordinator {
  readonly execute: EvalRemoteWorkExecutor;
  private readonly root: string;
  private readonly registry: RemoteWorkerRegistry;
  private readonly protocol: RemoteWorkerProtocol;
  private readonly collisions: CollisionLockManager;
  private readonly pollIntervalMs: number;
  private readonly releaseTimeoutMs: number;

  constructor(input: RemoteWorkCoordinatorOptions) {
    this.root = input.root;
    this.registry = input.registry;
    this.protocol = input.protocol;
    this.collisions = input.collisions;
    this.pollIntervalMs = boundedInterval(input.pollIntervalMs ?? 100, "remote work poll interval");
    this.releaseTimeoutMs = boundedInterval(input.releaseTimeoutMs ?? 10_000, "remote work release timeout");
    this.execute = (execution) => this.executeWork(execution);
  }

  async providerStatus(provider: string): Promise<RemoteWorkerPublicRecordV1["provider_status"] | null> {
    const candidates = await this.providerWorkers(provider);
    if (candidates.length === 0) return null;
    const first = candidates.sort(workerOrder)[0] as RemoteWorkerPublicRecordV1;
    return first.provider_status;
  }

  async providerStatuses(provider: string): Promise<RemoteWorkerPublicRecordV1["provider_status"][]> {
    return (await this.providerWorkers(provider)).sort(workerOrder).map((worker) => worker.provider_status);
  }

  async canEverFit(provider: string, reservation: ResourceVectorV1): Promise<boolean> {
    return (await this.providerWorkers(provider)).some((worker) => fits(reservation, worker.worker.capacity.allocatable));
  }

  recoverEvalLeases(input: Omit<Parameters<typeof recoverRemoteWorkerEvalLeases>[0], "root" | "registry" | "protocol" | "pollIntervalMs" | "releaseTimeoutMs">) {
    return recoverRemoteWorkerEvalLeases({
      ...input, root: this.root, registry: this.registry, protocol: this.protocol,
      pollIntervalMs: this.pollIntervalMs, releaseTimeoutMs: this.releaseTimeoutMs,
    });
  }

  private async providerWorkers(provider: string): Promise<RemoteWorkerPublicRecordV1[]> {
    return (await this.registry.list()).filter((record) => record.worker.status === "ready" && !record.revoked_at && record.worker.provider === provider);
  }

  private async executeWork(input: Parameters<EvalRemoteWorkExecutor>[0]): ReturnType<EvalRemoteWorkExecutor> {
    const inputs = await prepareRemoteWorkInputs({
      root: input.root, request: input.request, plan: input.plan, work: input.workItem,
      resolvedRevision: input.resolvedRevision, preparedArtifact: input.preparedArtifact,
      runtimeDirectory: input.runtimeDirectory, runtimeId: input.runtimeId,
    });
    const dispatch = await this.dispatch(input, inputs);
    const { worker, lease, offer, collision } = dispatch;
    let accepted = false;
    let terminal = false;
    await input.onLeaseState(lease.leaseId, "running");
    input.emit({ type: "lease.offered", work_id: input.workItem.work_id, lease_id: lease.leaseId, worker_id: worker.worker.worker_id, offer_id: offer.offer_id });
    try {
      const acceptedOffer = await this.waitFor(input, offer, (current) => current.state !== "offered");
      if (!acceptedOrLater(acceptedOffer)) throw new HitchError(`remote worker did not accept work: ${acceptedOffer.state}`, { code: "worker_rejected", exitCode: 10 });
      accepted = true;
      await lease.accept();
      await lease.markRunning();
      input.emit({ type: "lease.accepted", work_id: input.workItem.work_id, lease_id: lease.leaseId, worker_id: worker.worker.worker_id, offer_id: offer.offer_id });
      const completed = await this.withHeartbeat(input, lease, worker, async () => this.waitFor(input, acceptedOffer, (current) => current.state === "completed" || current.state === "release-requested" || current.state === "released"));
      terminal = true;
      if (!completed.terminal) throw ambiguous("remote worker completed without terminal evidence");
      const artifacts = completed.terminal.artifacts.filter((artifact) => artifact.kind === "result-bundle");
      if (completed.terminal.status !== "succeeded") {
        await this.finishRelease(input, completed, lease.current());
        return { leaseId: lease.leaseId, refs: [], run: remoteBackendResult(worker, offer, completed, null, null) };
      }
      if (artifacts.length !== 1) throw ambiguous("remote worker success requires exactly one result bundle");
      const artifact = artifacts[0] as typeof artifacts[number];
      const imported = await importRemoteResultEnvelope({
        root: input.root,
        evalDirectory: input.evalDirectory,
        request: input.request,
        resolvedRevision: input.resolvedRevision,
        work: input.workItem,
        lease: lease.current(),
        artifactPath: this.protocol.artifactPath(worker.worker.worker_id, lease.leaseId, artifact.digest),
        runtimeId: input.runtimeId,
        ...(input.environmentImages ? { environmentImages: input.environmentImages } : {}),
        ...(input.modelCapturePlan ? { modelCapturePlan: input.modelCapturePlan } : {}),
      });
      await input.publish(imported.ref);
      input.emit({ type: "eval.work.completed", work_id: input.workItem.work_id, lease_id: lease.leaseId, worker_id: worker.worker.worker_id, run_id: imported.ref.run_id });
      await this.finishRelease(input, completed, lease.current());
      return {
        leaseId: lease.leaseId,
        refs: [imported.ref],
        run: remoteBackendResult(worker, offer, completed, imported.trial, imported.backendDirectory),
      };
    } catch (error) {
      if (input.signal?.aborted) await this.protocol.requestCancel(worker.worker.worker_id, offer.offer_id).catch(() => undefined);
      if (!accepted) await lease.release().catch(() => undefined);
      else if (!terminal) await markExecutionLeaseLost({ evalDirectory: input.evalDirectory, leaseId: lease.leaseId, expectedEpoch: lease.current().epoch }).catch(() => undefined);
      throw error;
    } finally {
      collision.release();
      await input.onLeaseState(lease.leaseId, "terminal");
    }
  }

  private async dispatch(input: Parameters<EvalRemoteWorkExecutor>[0], inputs: RemoteWorkInputRefV1[]) {
    for (;;) {
      if (input.signal?.aborted) throw cancelled();
      const workers = (await this.registry.list()).filter((worker) => compatible(worker, input.workItem, input.preparedArtifact.platform, input.modelCapturePlan));
      for (const worker of workers.sort(workerOrder)) {
        const collisionKey = evalTaskCollisionKey(input.request, input.workItem.task_ids[0] as string, worker.worker.collision_domain_id);
        const collision = this.collisions.tryAcquire(`${input.evalId}:${input.workItem.work_id}`, [collisionKey]);
        if (!collision) continue;
        const lease = await createExecutionLease({
          evalDirectory: input.evalDirectory, evalId: input.evalId, workId: input.workItem.work_id,
          worker: {
            workerId: worker.worker.worker_id,
            provider: worker.worker.provider,
            collisionDomainId: worker.worker.collision_domain_id,
          },
          reservation: input.workItem.reservation,
          ttlMs: DEFAULT_EXECUTION_LEASE_TTL_MS,
          initialState: "offered",
        });
        try {
          const offer = await this.protocol.createOffer(worker.worker.worker_id, lease.current(), input.workItem, inputs);
          return { worker, lease, offer, collision };
        } catch (error) {
          await lease.release().catch(() => undefined);
          collision.release();
          if ((error as { code?: string }).code !== "worker_rejected" && (error as { code?: string }).code !== "worker_unavailable") throw error;
        }
      }
      await delay(this.pollIntervalMs, input.signal);
    }
  }

  private async waitFor(input: Parameters<EvalRemoteWorkExecutor>[0], initial: RemoteWorkOfferV1, ready: (offer: RemoteWorkOfferV1) => boolean): Promise<RemoteWorkOfferV1> {
    let offer = initial;
    for (;;) {
      if (ready(offer)) return offer;
      if (input.signal?.aborted) throw cancelled();
      const worker = await this.registry.get(offer.worker_id);
      if (!worker || worker.worker.status !== "ready") throw ambiguous(`remote worker became unavailable: ${offer.worker_id}`);
      await delay(this.pollIntervalMs, input.signal);
      offer = await this.protocol.getOffer(offer.worker_id, offer.offer_id) ?? (() => { throw ambiguous("remote work offer disappeared"); })();
      if (offer.state === "rejected" || offer.state === "expired") return offer;
    }
  }

  private async withHeartbeat<T>(input: Parameters<EvalRemoteWorkExecutor>[0], lease: Awaited<ReturnType<typeof createExecutionLease>>, worker: RemoteWorkerPublicRecordV1, operation: () => Promise<T>): Promise<T> {
    let failure: unknown;
    let tail = Promise.resolve();
    const timer = setInterval(() => {
      tail = tail.then(async () => {
        const current = await this.registry.get(worker.worker.worker_id);
        if (!current || current.worker.status !== "ready") throw ambiguous(`remote worker heartbeat expired: ${worker.worker.worker_id}`);
        await lease.heartbeat();
      }).catch((error) => { failure ??= error; });
    }, DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS);
    timer.unref();
    try {
      const result = await operation();
      await tail;
      if (failure !== undefined) throw failure;
      return result;
    } finally {
      clearInterval(timer);
      await tail;
    }
  }

  private async finishRelease(input: Parameters<EvalRemoteWorkExecutor>[0], completed: RemoteWorkOfferV1, lease: ExecutionLeaseV1): Promise<void> {
    let offer = await this.protocol.requestRelease(completed.worker_id, completed.offer_id);
    const deadline = Date.now() + this.releaseTimeoutMs;
    while (offer.state !== "released" && Date.now() < deadline && !input.signal?.aborted) {
      await delay(this.pollIntervalMs, input.signal);
      offer = await this.protocol.getOffer(offer.worker_id, offer.offer_id) ?? offer;
    }
    if (offer.state === "released") {
      await this.releaseLease(input, lease);
      input.emit({ type: "lease.released", work_id: lease.work_id, lease_id: lease.lease_id, worker_id: lease.worker_id });
      return;
    }
    await markExecutionLeaseLost({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch });
    input.emit({ type: "sandbox.cleanup.failed", work_id: lease.work_id, lease_id: lease.lease_id, worker_id: lease.worker_id, code: "worker_release_timeout" });
  }

  private async releaseLease(input: Parameters<EvalRemoteWorkExecutor>[0], lease: ExecutionLeaseV1): Promise<void> {
    await releaseExecutionLease({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch });
  }
}

function compatible(worker: RemoteWorkerPublicRecordV1, work: BackendWorkItemV1, platform: string, capture?: { effective_mode: string; topology?: string }): boolean {
  return worker.worker.status === "ready" && !worker.revoked_at && worker.worker.provider === work.provider
    && worker.worker.capabilities.backends.includes(work.backend) && worker.worker.capabilities.platforms.includes(platform)
    && (capture?.effective_mode !== "proxy" && capture?.effective_mode !== "hybrid" || capture.topology === "in-sandbox" && worker.provider_status.features.model_proxy)
    && fits(work.reservation, available(worker.worker.capacity.allocatable, worker.worker.capacity.allocated));
}

function remoteBackendResult(worker: RemoteWorkerPublicRecordV1, offered: RemoteWorkOfferV1, terminal: RemoteWorkOfferV1, trial: Record<string, unknown> | null, backendDirectory: string | null) {
  const directory = backendDirectory ?? path.join("remote", offered.work.work_id);
  const succeeded = terminal.terminal?.status === "succeeded" && trial !== null;
  return {
    backend: {
      name: "harbor", executable: `remote-worker:${worker.worker.worker_id}`,
      version: worker.provider_status.backends.find((backend) => backend.id === "harbor")?.version ?? null,
      identity: `${worker.worker.provider}:${worker.worker.worker_id}:${worker.generation}`,
      config_path: path.join(directory, "remote-offer.json"),
      result_path: succeeded ? path.join(directory, "remote-result.json") : null,
      stdout_path: path.join(directory, "remote.stdout.log"), stderr_path: path.join(directory, "remote.stderr.log"),
      process_exit_code: succeeded ? 0 : 1, signal: null, job_directory: path.join(directory, "job"),
    },
    rawResult: trial ? { trial_results: [trial] } : null,
    summary: trial ? { n_trials: 1, remote_worker: worker.worker.worker_id } : null,
  };
}

function workerOrder(left: RemoteWorkerPublicRecordV1, right: RemoteWorkerPublicRecordV1): number {
  return utilization(left.worker.capacity.allocated, left.worker.capacity.allocatable) - utilization(right.worker.capacity.allocated, right.worker.capacity.allocatable)
    || left.worker.worker_id.localeCompare(right.worker.worker_id);
}

function utilization(allocated: ResourceVectorV1, allocatable: ResourceVectorV1): number {
  return Math.max(...fields().map((field) => allocatable[field] === 0 ? allocated[field] === 0 ? 0 : Infinity : allocated[field] / allocatable[field]));
}

function available(total: ResourceVectorV1, used: ResourceVectorV1): ResourceVectorV1 {
  return Object.fromEntries(fields().map((field) => [field, total[field] - used[field]])) as unknown as ResourceVectorV1;
}

function fits(requested: ResourceVectorV1, capacity: ResourceVectorV1): boolean { return fields().every((field) => requested[field] <= capacity[field]); }
function acceptedOrLater(offer: RemoteWorkOfferV1): boolean {
  return new Set(["accepted", "cancel-requested", "completed", "release-requested", "released"]).has(offer.state)
    && typeof offer.accepted_at === "string" && typeof offer.accept_receipt_digest === "string";
}
function fields(): Array<keyof ResourceVectorV1> { return ["cpu_millis", "memory_bytes", "container_slots", "build_slots"]; }
function boundedInterval(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new TypeError(`${label} is invalid`); return value; }
function ambiguous(message: string): HitchError { return new HitchError(message, { code: "execution_state_ambiguous", exitCode: 12 }); }
function cancelled(): HitchError { return new HitchError("remote work was cancelled", { code: "cancelled", exitCode: 9 }); }

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done(cancelled());
    function done(error?: Error): void { clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(); }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
