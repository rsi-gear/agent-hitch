import path from "node:path";
import { remoteBackendResult } from "./remote-backend-result.js";
import type { BackendWorkItemV1, EvalId, ExecutionLeaseV1, RemoteWorkInputRefV1, RemoteWorkOfferV1, RemoteWorkerPublicRecordV1, ResourceVectorV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import { DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS, DEFAULT_EXECUTION_LEASE_TTL_MS, assertRemoteVerifierDispatch, confirmRemoteExecutionLeaseReleased, createExecutionLease, markExecutionLeaseLost, readExecutionLeases } from "../evals/index.js";
import type { EvalRemoteWorkExecutor, EvalRemoteWorkExecutionResult } from "../evals/index.js";
import { CollisionLockManager } from "./collisions.js";
import { evalTaskCollisionKey } from "./eval-records.js";
import { importRemoteResultEnvelope } from "./remote-result-transport.js";
import type { RemoteWorkerProtocol } from "./remote-worker-protocol.js";
import type { RemoteWorkerRegistry } from "./remote-workers.js";
import { DEFAULT_REMOTE_WORKER_RECONNECT_TIMEOUT_MS, recoverRemoteWorkerEvalLeases } from "./remote-work-recovery.js";
import { prepareRemoteWorkInputs } from "./remote-work-inputs.js";
import { subtractResourceVectors } from "./resources.js";
import { remoteModelBinding, resolveTrainingEndpoint } from "../model-access/index.js";
import type { RemoteModelTargetV2 } from "../model-access/index.js";
import { verifierSourceRequested } from "./remote-verifier-source-transport.js";
import { importRemoteVerifierResultEnvelope } from "./remote-verifier-import.js";
import { collectRemoteRerunJournal, completeRemoteRerunJournal, loadRemoteRerunJournal } from "./remote-rerun-journal.js";

export interface RemoteWorkCoordinatorOptions {
  root: string;
  registry: RemoteWorkerRegistry;
  protocol: RemoteWorkerProtocol;
  collisions: CollisionLockManager;
  pollIntervalMs?: number;
  releaseTimeoutMs?: number;
  reconnectTimeoutMs?: number;
}

export class RemoteWorkCoordinator {
  readonly execute: EvalRemoteWorkExecutor;
  private readonly root: string;
  private readonly registry: RemoteWorkerRegistry;
  private readonly protocol: RemoteWorkerProtocol;
  private readonly collisions: CollisionLockManager;
  private readonly pollIntervalMs: number;
  private readonly releaseTimeoutMs: number;
  private readonly reconnectTimeoutMs: number;

  constructor(input: RemoteWorkCoordinatorOptions) {
    this.root = input.root;
    this.registry = input.registry;
    this.protocol = input.protocol;
    this.collisions = input.collisions;
    this.pollIntervalMs = boundedInterval(input.pollIntervalMs ?? 100, "remote work poll interval");
    this.releaseTimeoutMs = boundedInterval(input.releaseTimeoutMs ?? 10_000, "remote work release timeout");
    this.reconnectTimeoutMs = boundedReconnectTimeout(input.reconnectTimeoutMs ?? DEFAULT_REMOTE_WORKER_RECONNECT_TIMEOUT_MS);
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

  recoverEvalLeases(input: Omit<Parameters<typeof recoverRemoteWorkerEvalLeases>[0], "root" | "registry" | "protocol" | "pollIntervalMs" | "releaseTimeoutMs" | "reconnectTimeoutMs">) {
    return recoverRemoteWorkerEvalLeases({
      ...input, root: this.root, registry: this.registry, protocol: this.protocol,
      pollIntervalMs: this.pollIntervalMs, releaseTimeoutMs: this.releaseTimeoutMs, reconnectTimeoutMs: this.reconnectTimeoutMs,
    });
  }

  async reconcileReleasedLeases(input: { evalId: EvalId; evalDirectory: string; provider: string }): Promise<void> {
    const leases: ExecutionLeaseV1[] = [];
    for (const lease of await readExecutionLeases(input.evalDirectory)) {
      if (lease.provider !== input.provider || !["lost", "expired", "released"].includes(lease.state)
        || lease.state === "released" && lease.release_confirmation?.schema_version !== "3") continue;
      const offer = await this.protocol.findOfferForLease(lease.worker_id, lease.lease_id);
      if (offer && (offer.state === "released" || await this.protocol.generationCleanup.read(offer))) leases.push(lease);
    }
    if (!leases.length) return;
    const result = await this.recoverEvalLeases({ evalId: input.evalId, evalDirectory: input.evalDirectory, leases });
    // Failed work may be retried by the caller's repair contract once cleanup is proven.
    const released = new Set((await readExecutionLeases(input.evalDirectory)).filter(lease => lease.state === "released").map(lease => lease.lease_id));
    if (result.status !== "resumable" && !(result.code === "remote_work_failed" && leases.every(lease => released.has(lease.lease_id)))) {
      throw new HitchError(result.message ?? "remote cleanup could not be reconciled", { code: result.code ?? "execution_state_ambiguous", exitCode: 12 });
    }
  }

  private async providerWorkers(provider: string): Promise<RemoteWorkerPublicRecordV1[]> {
    return (await this.registry.list()).filter((record) => record.worker.status === "ready" && !record.revoked_at && record.worker.provider === provider);
  }

  private async executeWork(input: Parameters<EvalRemoteWorkExecutor>[0]): ReturnType<EvalRemoteWorkExecutor> {
    const verifier = input.verifierOnly, physical = input.physicalExecution;
    if ((physical?.kind === "verifier-only") !== !!verifier || verifier && input.modelTarget) throw ambiguous("verifier work requires its scoring inputs and no model route");
    if (verifier) {
      if (!physical) throw ambiguous("verifier work has no physical identity");
      await assertRemoteVerifierDispatch({ ...input, verifier: verifier.descriptor, physical, work: input.workItem });
    }
    const modelTarget: RemoteModelTargetV2 | undefined = verifier ? undefined : input.request.training_binding
      ? { kind: "training-external", endpoint: await resolveTrainingEndpoint(input.root, input.request.training_binding) }
      : input.modelTarget;
    if (!verifier && input.request.local_inference && !modelTarget) throw new HitchError("remote work has no controller-owned model route", { code: "remote_model_binding_unsupported", exitCode: 12 });
    const modelBinding = modelTarget ? remoteModelBinding(modelTarget) : undefined;
    if (modelBinding && input.request.pass_env.length) throw new HitchError("remote bound models do not accept credential overrides", { code: "remote_model_binding_unsupported", exitCode: 12 });
    const credentialNames = modelBinding || verifier ? [] : this.protocol.credentialNamesFor(input.request.pass_env);
    const cachedInputs = new Map<boolean, Promise<RemoteWorkInputRefV1[]>>();
    const inputsFor = (captureVerifierSource: boolean): Promise<RemoteWorkInputRefV1[]> => {
      captureVerifierSource = captureVerifierSource && !verifier;
      if (cachedInputs.has(captureVerifierSource)) return cachedInputs.get(captureVerifierSource)!;
      const prepared = prepareRemoteWorkInputs({
      root: input.root, request: input.request, plan: input.plan, work: input.workItem,
      resolvedRevision: input.resolvedRevision, preparedArtifact: input.preparedArtifact,
      runtimeDirectory: input.runtimeDirectory, runtimeId: input.runtimeId,
      credentialNames,
      ...(modelBinding ? { modelBinding } : {}),
      ...(input.physicalExecution ? { physicalExecution: input.physicalExecution } : {}),
      ...(verifier ? { verifierOnly: verifier } : {}),
      captureVerifierSource,
      });
      cachedInputs.set(captureVerifierSource, prepared); return prepared;
    };
    const dispatch = await this.dispatch(input, inputsFor, credentialNames, modelTarget);
    const { worker, lease, offer, collision } = dispatch;
    const backendVersion = worker.provider_status.backends.find(backend => backend.id === "harbor")?.version ?? null;
    let accepted = false;
    let terminal = false;
    let released = false;
    let terminalOffer: RemoteWorkOfferV1 | undefined;
    try {
      await input.onLeaseState(lease.leaseId, "running");
      input.emit({ type: "eval.work.leased", work_id: input.workItem.work_id, lease_id: lease.leaseId, worker_id: worker.worker.worker_id, reservation: input.workItem.reservation });
      input.emit({ type: "lease.offered", work_id: input.workItem.work_id, lease_id: lease.leaseId, worker_id: worker.worker.worker_id, offer_id: offer.offer_id });
      const acceptedOffer = await this.waitFor(input, offer, (current) => current.state !== "offered");
      if (!acceptedOrLater(acceptedOffer)) throw new HitchError(`remote worker did not accept work: ${acceptedOffer.state}`, { code: "worker_rejected", exitCode: 10 });
      accepted = true;
      await lease.accept();
      await lease.markRunning();
      input.emit({ type: "lease.accepted", work_id: input.workItem.work_id, lease_id: lease.leaseId, worker_id: worker.worker.worker_id, offer_id: offer.offer_id });
      input.emit({ type: "eval.work.started", work_id: input.workItem.work_id, lease_id: lease.leaseId, worker_id: worker.worker.worker_id });
      const completed = await this.withHeartbeat(lease, async () => this.waitFor(input, acceptedOffer, (current) => current.state === "completed" || current.state === "release-requested" || current.state === "released"));
      terminal = true;
      terminalOffer = completed;
      if (!completed.terminal) throw ambiguous("remote worker completed without terminal evidence");
      const artifacts = completed.terminal.artifacts.filter((artifact) => artifact.kind === "result-bundle");
      if (completed.terminal.status !== "succeeded") {
        await this.finishRelease(input, completed, lease.current());
        released = true;
        return { leaseId: lease.leaseId, refs: [], run: remoteBackendResult(offer, completed, null, null, backendVersion) };
      }
      if (artifacts.length !== 1) throw ambiguous("remote worker success requires exactly one result bundle");
      const artifact = artifacts[0] as typeof artifacts[number];
      let grading: Awaited<ReturnType<typeof importRemoteVerifierResultEnvelope>> | undefined;
      const imported = verifier ? grading = await importRemoteVerifierResultEnvelope({ root: input.root, evalDirectory: input.evalDirectory,
        verifier: verifier.descriptor, plan: input.plan, work: input.workItem, physical: physical!, lease: lease.current(),
        artifactPath: this.protocol.artifactPath(worker.worker.worker_id, lease.leaseId, artifact.digest),
        ...(input.signal ? { signal: input.signal } : {}) }) : await importRemoteResultEnvelope({
        root: input.root,
        evalDirectory: input.evalDirectory,
        request: input.request,
        resolvedRevision: input.resolvedRevision,
        work: input.workItem,
        lease: lease.current(),
        artifactPath: this.protocol.artifactPath(worker.worker.worker_id, lease.leaseId, artifact.digest),
        runtimeId: input.runtimeId,
        verifierSourceExpected: await verifierSourceRequested(input.root, completed),
        ...(modelBinding ? { modelProof: await this.protocol.modelRoutes.boundRun(completed) } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.environmentImages ? { environmentImages: input.environmentImages } : {}),
        ...(input.modelCapturePlan ? { modelCapturePlan: input.modelCapturePlan } : {}),
        ...(input.publicationMode ? { publicationMode: input.publicationMode } : {}),
      });
      const result: EvalRemoteWorkExecutionResult = { leaseId: lease.leaseId, refs: [imported.ref],
        run: remoteBackendResult(offer, completed, imported.trial, imported.backendDirectory, backendVersion, grading?.outcome),
        ...(grading ? { assessments: [grading.assessment] } : {}) };
      const journal = verifier ? await loadRemoteRerunJournal({ root: input.root, evalDirectory: input.evalDirectory, plan: input.plan, request: input.request, offer: completed }) : null;
      if (verifier && !journal) throw ambiguous("verifier result has no durable dispatch journal");
      if (journal) await collectRemoteRerunJournal(journal, result);
      await input.publish(imported.ref);
      input.emit({ type: "eval.work.completed", work_id: input.workItem.work_id, lease_id: lease.leaseId, worker_id: worker.worker.worker_id, run_id: imported.ref.run_id });
      await this.finishRelease(input, completed, lease.current());
      released = true;
      if (journal) await completeRemoteRerunJournal(journal, lease.leaseId);
      return result;
    } catch (error) {
      input.emit({ type: "eval.work.lost", work_id: input.workItem.work_id, lease_id: lease.leaseId, worker_id: worker.worker.worker_id, code: (error as { code?: string }).code || "remote_work_failed" });
      if (terminalOffer && !released) {
        await this.finishRelease(input, terminalOffer, lease.current()).catch(() => undefined);
      }
      if (input.signal?.aborted) await this.protocol.requestCancel(worker.worker.worker_id, offer.offer_id).catch(() => undefined);
      if (!accepted) await this.withdrawOrFenceAcceptedRace(input.evalDirectory, offer, lease);
      else if (!terminal) await markExecutionLeaseLost({ evalDirectory: input.evalDirectory, leaseId: lease.leaseId, expectedEpoch: lease.current().epoch }).catch(() => undefined);
      throw error;
    } finally {
      collision.release();
      await input.onLeaseState(lease.leaseId, "terminal");
    }
  }

  private async dispatch(input: Parameters<EvalRemoteWorkExecutor>[0], inputsFor: (capture: boolean) => Promise<RemoteWorkInputRefV1[]>, credentialNames: readonly string[], modelTarget?: RemoteModelTargetV2) {
    for (;;) {
      if (input.signal?.aborted) throw cancelled();
      const registered = (await this.registry.list()).filter((worker) => !worker.revoked_at && worker.worker.provider === input.workItem.provider);
      const capable = registered.filter((worker) => supports(worker, input.workItem, input.preparedArtifact.platform, input.verifierOnly ? undefined : input.modelCapturePlan)
        && (!input.physicalExecution || worker.provider_status.features.physical_work === "2")
        && (!input.verifierOnly || worker.provider_status.features.verifier_only === "2")
        && (!modelTarget || worker.provider_status.features[modelTarget.kind === "training-external" ? "training_external_binding" : "managed_model_node"] === "2"));
      if (registered.length > 0 && capable.length === 0) {
        throw new HitchError(`no remote worker supports ${input.workItem.backend} on ${input.preparedArtifact.platform}`, {
          code: "execution_provider_unavailable", exitCode: 10,
        });
      }
      if (capable.length > 0 && !capable.some((worker) => fits(input.workItem.reservation, worker.worker.capacity.allocatable))) {
        throw new HitchError("remote work item exceeds every compatible worker capacity", {
          code: "resource_request_unsatisfiable", exitCode: 10,
        });
      }
      const workers = capable.filter((worker) => compatible(worker, input.workItem));
      for (const worker of workers.sort(workerOrder)) {
        const inputs = await inputsFor(worker.provider_status.features.verifier_source === "2");
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
          const offer = await this.protocol.createOffer(worker.worker.worker_id, lease.current(), input.workItem, inputs, credentialNames, modelTarget);
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
    let unavailableSince: number | undefined;
    let reportedUnavailable = false;
    for (;;) {
      if (ready(offer)) return offer;
      if (input.signal?.aborted) throw cancelled();
      await delay(this.pollIntervalMs, input.signal);
      offer = await this.protocol.getOffer(offer.worker_id, offer.offer_id) ?? (() => { throw ambiguous("remote work offer disappeared"); })();
      if (offer.state === "rejected" || offer.state === "expired") return offer;
      if (ready(offer)) return offer;
      const worker = await this.registry.get(offer.worker_id);
      if (worker?.revoked_at) throw ambiguous(`remote worker was revoked: ${offer.worker_id}`);
      if (worker && worker.generation !== offer.generation) throw new HitchError("remote worker generation changed during execution", { code: "worker_generation_mismatch", exitCode: 12 });
      if (workerAvailableForOffer(worker, offer)) {
        if (reportedUnavailable) input.emit({ type: "worker.reconnected", worker_id: offer.worker_id, lease_id: offer.lease.lease_id, lease_epoch: offer.lease.epoch });
        unavailableSince = undefined;
        reportedUnavailable = false;
      } else {
        unavailableSince ??= Date.now();
        if (!reportedUnavailable) input.emit({ type: "worker.heartbeat_missed", worker_id: offer.worker_id, lease_id: offer.lease.lease_id, lease_epoch: offer.lease.epoch });
        reportedUnavailable = true;
        if (Date.now() - unavailableSince >= this.reconnectTimeoutMs) throw ambiguous(`remote worker did not reconnect: ${offer.worker_id}`);
      }
    }
  }

  private async withHeartbeat<T>(lease: Awaited<ReturnType<typeof createExecutionLease>>, operation: () => Promise<T>): Promise<T> {
    let failure: unknown;
    let tail = Promise.resolve();
    const timer = setInterval(() => {
      tail = tail.then(async () => {
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

  private async withdrawOrFenceAcceptedRace(evalDirectory: string, offer: RemoteWorkOfferV1, lease: Awaited<ReturnType<typeof createExecutionLease>>): Promise<void> {
    const withdrawn = await this.protocol.withdrawUnacceptedOffer(offer.worker_id, offer.offer_id).catch(async () => {
      await markExecutionLeaseLost({ evalDirectory, leaseId: lease.leaseId, expectedEpoch: lease.current().epoch }).catch(() => undefined);
      return null;
    });
    if (!withdrawn) return;
    if (!acceptedOrLater(withdrawn)) {
      await lease.release().catch(() => undefined);
      return;
    }
    await lease.accept().catch(() => undefined);
    await this.protocol.requestCancel(offer.worker_id, offer.offer_id).catch(() => undefined);
    await markExecutionLeaseLost({ evalDirectory, leaseId: lease.leaseId, expectedEpoch: lease.current().epoch }).catch(() => undefined);
  }

  private async finishRelease(input: Parameters<EvalRemoteWorkExecutor>[0], completed: RemoteWorkOfferV1, lease: ExecutionLeaseV1): Promise<void> {
    input.emit({ type: "sandbox.cleanup.started", work_id: lease.work_id, lease_id: lease.lease_id, worker_id: lease.worker_id });
    let cleanup = await this.protocol.generationCleanup.read(completed);
    let offer = cleanup ? completed : await this.protocol.requestRelease(completed.worker_id, completed.offer_id);
    const deadline = Date.now() + this.releaseTimeoutMs;
    while (!cleanup && offer.state !== "released" && Date.now() < deadline && !input.signal?.aborted) {
      await delay(this.pollIntervalMs, input.signal);
      offer = await this.protocol.getOffer(offer.worker_id, offer.offer_id) ?? offer;
      cleanup = await this.protocol.generationCleanup.read(offer);
    }
    if (cleanup || offer.state === "released") {
      if (cleanup) await this.protocol.generationCleanup.reconcile(offer, cleanup);
      else await confirmRemoteExecutionLeaseReleased({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch, offer });
      input.emit({ type: "lease.released", work_id: lease.work_id, lease_id: lease.lease_id, worker_id: lease.worker_id });
      input.emit({ type: "sandbox.cleanup.completed", work_id: lease.work_id, lease_id: lease.lease_id, worker_id: lease.worker_id, residual_resources: 0 });
      return;
    }
    await markExecutionLeaseLost({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch });
    input.emit({ type: "sandbox.cleanup.failed", work_id: lease.work_id, lease_id: lease.lease_id, worker_id: lease.worker_id, code: "worker_release_timeout" });
    throw new HitchError("remote worker release was not acknowledged; resources remain unresolved", { code: "worker_release_timeout", exitCode: 12 });
  }

}

function supports(worker: RemoteWorkerPublicRecordV1, work: BackendWorkItemV1, platform: string, capture?: { effective_mode: string; topology?: string }): boolean {
  return worker.worker.capabilities.backends.includes(work.backend) && worker.worker.capabilities.platforms.includes(platform)
    && (capture?.effective_mode !== "proxy" && capture?.effective_mode !== "hybrid" || capture.topology === "in-sandbox" && worker.provider_status.features.model_proxy);
}
function compatible(worker: RemoteWorkerPublicRecordV1, work: BackendWorkItemV1): boolean {
  return worker.worker.status === "ready" && fits(work.reservation, subtractResourceVectors(worker.worker.capacity.allocatable, worker.worker.capacity.allocated));
}

function workerOrder(left: RemoteWorkerPublicRecordV1, right: RemoteWorkerPublicRecordV1): number {
  return utilization(left.worker.capacity.allocated, left.worker.capacity.allocatable) - utilization(right.worker.capacity.allocated, right.worker.capacity.allocatable)
    || left.worker.worker_id.localeCompare(right.worker.worker_id);
}

function utilization(allocated: ResourceVectorV1, allocatable: ResourceVectorV1): number {
  return Math.max(...fields().map((field) => resourceValue(allocatable, field) === 0
    ? resourceValue(allocated, field) === 0 ? 0 : Infinity
    : resourceValue(allocated, field) / resourceValue(allocatable, field)));
}

function fits(requested: ResourceVectorV1, capacity: ResourceVectorV1): boolean { return fields().every((field) => resourceValue(requested, field) <= resourceValue(capacity, field)); }
function acceptedOrLater(offer: RemoteWorkOfferV1): boolean {
  return new Set(["accepted", "cancel-requested", "completed", "release-requested", "released"]).has(offer.state)
    && typeof offer.accepted_at === "string" && typeof offer.accept_receipt_digest === "string";
}
function workerAvailableForOffer(worker: RemoteWorkerPublicRecordV1 | null, offer: RemoteWorkOfferV1): boolean {
  if (worker?.worker.status !== "ready") return false;
  if (offer.state === "offered") return true;
  return worker.active_leases.some((lease) => lease.lease_id === offer.lease.lease_id && lease.epoch === offer.lease.epoch);
}
function fields(): Array<keyof ResourceVectorV1> { return ["cpu_millis", "memory_bytes", "container_slots", "build_slots", "gpu_count", "ephemeral_disk_bytes"]; }
function resourceValue(resources: ResourceVectorV1, field: keyof ResourceVectorV1): number { return resources[field] ?? 0; }
function boundedInterval(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new TypeError(`${label} is invalid`); return value; }
function boundedReconnectTimeout(value: number): number { if (!Number.isSafeInteger(value) || value < 1 || value > 5 * 60_000) throw new TypeError("remote worker reconnect timeout is invalid"); return value; }
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
