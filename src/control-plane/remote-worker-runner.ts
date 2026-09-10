import type { RemoteWorkArtifactRefV1, RemoteWorkInputRefV1, RemoteWorkOfferV1, ResourceVectorV1, ExecutionObservationSourceV2 } from "../domain/index.js";
import { HitchError, safeDiagnosticMessage } from "../foundation/index.js";
import { ResourceLedger } from "./resources.js";
import { RemoteWorkerHttpClient } from "./remote-worker-client.js";
import { RemoteObservationReporter } from "./remote-observation-reporter.js";
import { RemoteWorkerGenerationRecovery } from "./remote-worker-generation-recovery.js";
import type { RemoteWorkerGenerationCleaner } from "./remote-worker-generation-recovery.js";
import type { RemoteWorkerExecutionOwnership, RemoteWorkerProcessIdentityV2 } from "../domain/index.js";

export interface RemoteWorkerExecutionResult {
  status: "succeeded" | "failed" | "cancelled";
  artifacts?: Array<{ kind: RemoteWorkArtifactRefV1["kind"]; body: Buffer }>;
  release?: () => Promise<void>;
}

export interface RemoteWorkerExecutorInput {
  offer: RemoteWorkOfferV1;
  inputs: ReadonlyMap<RemoteWorkInputRefV1["kind"], Buffer>;
  /** Process-memory only; the runner clears this map after executor settlement. */
  credentials: ReadonlyMap<string, string>;
  signal: AbortSignal;
  emit(type: string, payload?: Record<string, unknown>): Promise<void>;
  relayModel?: (runId: string, operation: "bind" | "generate", body: unknown, signal: AbortSignal) => Promise<Response>;
  readExecutionLease?: (signal: AbortSignal) => Promise<import("../domain/index.js").ExecutionLeaseV1>;
  ownership?: RemoteWorkerExecutionOwnership;
  authorizeProcess?: (identity: RemoteWorkerProcessIdentityV2) => Promise<void>;
}

export type RemoteWorkerExecutor = ((input: RemoteWorkerExecutorInput) => Promise<RemoteWorkerExecutionResult>) & {
  /** Durable local ownership admission, completed before HTTP acceptance. */
  prepare?: (offer: RemoteWorkOfferV1) => Promise<void | RemoteWorkerExecutionOwnership>;
};

export interface RemoteWorkerRunnerOptions {
  client: RemoteWorkerHttpClient;
  capacity: ResourceVectorV1;
  execute: RemoteWorkerExecutor;
  signal?: AbortSignal;
  once?: boolean;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  retryIntervalMs?: number;
  releaseUnknown?: (offer: RemoteWorkOfferV1) => Promise<void>;
  releasePreviousGeneration?: RemoteWorkerGenerationCleaner;
  onError?: (error: unknown) => void;
  /** The caller captures the resident startup runtime before starting the runner. */
  executionObserver?: ExecutionObservationSourceV2;
}

interface ActiveJob {
  offer: RemoteWorkOfferV1;
  controller: AbortController;
  signal: AbortSignal;
  allocation: ReturnType<ResourceLedger["tryAcquire"]> & {};
  accepted: boolean;
  settled: boolean;
  executionSettled: boolean;
  cleaned: boolean;
  releaseSentAt?: string;
  cleanup: (() => Promise<void>) | undefined;
  promise: Promise<void>;
}

const REQUIRED_INPUTS = new Set<RemoteWorkInputRefV1["kind"]>(["work-spec", "harness-artifact", "controller-runtime", "task-input"]);

export class RemoteWorkerRunner {
  private readonly client: RemoteWorkerHttpClient;
  private readonly execute: RemoteWorkerExecutor;
  private readonly signal: AbortSignal | undefined;
  private readonly once: boolean;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly retryIntervalMs: number;
  private readonly onError: (error: unknown) => void;
  private readonly releaseUnknown: ((offer: RemoteWorkOfferV1) => Promise<void>) | undefined;
  private readonly ledger: ResourceLedger;
  private readonly jobs = new Map<string, ActiveJob>();
  private handled = 0;
  private lastHeartbeat = 0;
  private readonly observations: RemoteObservationReporter | undefined;
  private readonly generationRecovery: RemoteWorkerGenerationRecovery | undefined;

  constructor(options: RemoteWorkerRunnerOptions) {
    this.client = options.client;
    this.execute = options.execute;
    this.signal = options.signal ? AbortSignal.any([options.signal, this.client.fencedSignal]) : this.client.fencedSignal;
    this.once = options.once ?? false;
    this.pollIntervalMs = interval(options.pollIntervalMs ?? 1_000, "poll");
    this.heartbeatIntervalMs = interval(options.heartbeatIntervalMs ?? 10_000, "heartbeat");
    this.retryIntervalMs = interval(options.retryIntervalMs ?? 1_000, "retry");
    this.onError = options.onError ?? (() => undefined);
    this.releaseUnknown = options.releaseUnknown;
    this.ledger = new ResourceLedger(options.capacity);
    this.observations = options.executionObserver ? new RemoteObservationReporter(this.client, options.executionObserver, this.onError) : undefined;
    this.generationRecovery = options.releasePreviousGeneration ? new RemoteWorkerGenerationRecovery(this.client, options.releasePreviousGeneration,
      this.signal!, this.retryIntervalMs, this.onError, () => { this.handled++; }) : undefined;
  }

  async run(): Promise<void> {
    while (!this.signal?.aborted) {
      try { await this.tick(); }
      catch (error) { this.onError(error); }
      if (this.once && this.handled > 0 && this.jobs.size === 0 && this.generationRecovery?.idle !== false) { await this.observations?.stop(); this.client.fencedSignal.throwIfAborted(); return; }
      await delay(this.pollIntervalMs, this.signal);
    }
    for (const job of this.jobs.values()) job.controller.abort(this.signal?.reason);
    await this.observations?.stop();
    await this.generationRecovery?.stop();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.promise));
    for (const job of this.jobs.values()) {
      // Stop and clean our own execution even when the controller no longer
      // accepts this generation. A local cleanup is not a remote release receipt.
      if (!job.executionSettled) continue;
      try { if (!job.cleaned) { await job.cleanup?.(); job.cleaned = true; } }
      catch (error) { this.onError(error); }
    }
    this.client.fencedSignal.throwIfAborted();
  }

  async tick(): Promise<void> {
    this.observations?.tick();
    const offers = await this.client.listOffers();
    this.generationRecovery?.tick(offers);
    const visible = new Map(offers.map((offer) => [offer.offer_id, offer]));
    const released = new Set<string>();
    for (const job of this.jobs.values()) {
      const current = visible.get(job.offer.offer_id);
      if (!current) { if (job.releaseSentAt) await this.releaseJob(job); continue; }
      job.offer = current;
      if (current.state === "cancel-requested") job.controller.abort(new Error("remote work cancellation requested"));
      if (current.state === "release-requested") { await this.releaseJob(job); released.add(current.offer_id); }
    }
    for (const offer of offers) {
      if (this.jobs.has(offer.offer_id) || released.has(offer.offer_id)) continue;
      // Older generations remain visible for accounting, but cannot be cleaned
      // or acknowledged through this generation's v1 receipt authority.
      if (offer.generation !== this.client.generation) continue;
      if (offer.state === "release-requested" || offer.state === "cancel-requested") {
        // Durable cancellation before acceptance fences any later accept. Such
        // an offer never authorized an executor, even if no local record exists.
        if (offer.state !== "cancel-requested" || offer.accepted_at) await this.cleanUnknown(offer);
        await this.client.release(offer);
        this.handled += 1;
      } else if (offer.state === "accepted" && this.releaseUnknown) {
        await this.cleanUnknown(offer);
        const artifact = await this.client.uploadArtifact(offer, "diagnostic", Buffer.from(`${JSON.stringify({
          schema_version: "1", code: "remote_worker_interrupted", at: new Date().toISOString(),
        })}\n`));
        await this.client.complete(offer, "failed", [artifact]);
      } else if (offer.state === "offered" && (!this.once || this.handled === 0)) {
        this.startOffer(offer);
      }
    }
    if (Date.now() - this.lastHeartbeat >= this.heartbeatIntervalMs) await this.heartbeat();
  }

  async heartbeat(health: "healthy" | "degraded" | "unavailable" = "healthy"): Promise<void> {
    const active = [...this.jobs.values()].filter((job) => job.accepted).map((job) => ({
      lease_id: job.offer.lease.lease_id, epoch: job.offer.lease.epoch,
    }));
    await this.client.heartbeat(this.ledger.snapshot().allocated, active, health);
    this.lastHeartbeat = Date.now();
  }

  private startOffer(offer: RemoteWorkOfferV1): void {
    const allocation = this.ledger.tryAcquire(offer.lease.lease_id, "eval", offer.lease.reservation);
    if (!allocation) return;
    const controller = new AbortController();
    const job: ActiveJob = {
      offer, controller, signal: this.signal ? AbortSignal.any([controller.signal, this.signal]) : controller.signal,
      allocation, accepted: false, settled: false, executionSettled: false, cleaned: false, cleanup: undefined,
      promise: Promise.resolve(),
    };
    this.jobs.set(offer.offer_id, job);
    job.promise = this.runOffer(job).catch((error) => {
      this.onError(error);
      if (!job.accepted) this.finishJob(job);
    });
  }

  private async runOffer(job: ActiveJob): Promise<void> {
    let inputs: Map<RemoteWorkInputRefV1["kind"], Buffer>;
    let ownership: RemoteWorkerExecutionOwnership | undefined;
    try {
      inputs = await this.downloadInputs(job.offer);
      ownership = await this.execute.prepare?.(job.offer) || undefined;
    } catch (error) {
      await this.client.reject(job.offer, rejectionCode(error));
      this.handled += 1;
      this.finishJob(job);
      return;
    }
    const acceptanceTime = new Date().toISOString();
    const accepted = await retry(() => this.client.accept(job.offer, ownership, acceptanceTime), this.retryIntervalMs, job.signal);
    if (accepted.state !== "accepted") {
      this.handled += 1;
      this.finishJob(job);
      return;
    }
    job.offer = accepted;
    job.accepted = true;
    const credentials = new Map<string, string>();
    let sequence = 0;
    const emit = (type: string, payload?: Record<string, unknown>) => {
      const eventSequence = ++sequence, sentAt = new Date().toISOString();
      return retry(() => this.client.emit(job.offer, eventSequence, type, payload, sentAt), this.retryIntervalMs, job.signal);
    };
    let result: RemoteWorkerExecutionResult;
    try {
      await this.heartbeat();
      for (const [name, value] of Object.entries((await retry(
        () => this.client.credentials(job.offer), this.retryIntervalMs, job.signal,
      )).credentials)) credentials.set(name, value);
      result = await this.execute({ offer: job.offer, inputs, credentials, signal: job.signal, emit,
        ...(ownership ? { ownership, authorizeProcess: identity => retry(
          () => this.client.authorizeProcess(job.offer, ownership!, identity), this.retryIntervalMs, job.signal) } : {}),
        readExecutionLease: signal => this.client.executionLease(job.offer, AbortSignal.any([signal, job.signal])),
        relayModel: (runId, operation, body, signal) => this.client.relayModel(job.offer, runId, operation, body, AbortSignal.any([signal, job.signal])) });
      validateResult(result);
      job.cleanup = result.release;
    } catch (error) {
      // Executor setup can fail before it has a chance to return its normal
      // release callback. Keep the offer releasable through the same
      // ownership-fenced recovery path used after a worker restart.
      job.cleanup = () => this.cleanUnknown(job.offer);
      result = {
        status: job.signal.aborted ? "cancelled" : "failed",
        artifacts: [{ kind: "diagnostic", body: diagnostic(error, [...credentials.values()]) }],
      };
    } finally {
      credentials.clear();
      job.executionSettled = true;
    }
    const artifacts: RemoteWorkArtifactRefV1[] = [];
    for (const artifact of result.artifacts ?? []) {
      artifacts.push(await retry(
        () => this.client.uploadArtifact(job.offer, artifact.kind, artifact.body), this.retryIntervalMs, this.signal,
      ));
    }
    const completionTime = new Date().toISOString();
    job.offer = await retry(
      () => this.client.complete(job.offer, result.status, artifacts, completionTime), this.retryIntervalMs, this.signal,
    );
    job.settled = true;
    await this.heartbeat();
  }

  private async downloadInputs(offer: RemoteWorkOfferV1): Promise<Map<RemoteWorkInputRefV1["kind"], Buffer>> {
    const refs = offer.inputs ?? [];
    const verifier = refs.some(ref => ref.kind === "verifier-source" || ref.kind === "verifier-runtime");
    const expected = verifier ? new Set([...REQUIRED_INPUTS, "verifier-source", "verifier-runtime"]) : REQUIRED_INPUTS;
    if (refs.length !== expected.size || refs.some((ref) => !expected.has(ref.kind))
      || new Set(refs.map((ref) => ref.kind)).size !== expected.size) throw runnerError("remote work offer is missing required inputs");
    const inputs = new Map<RemoteWorkInputRefV1["kind"], Buffer>();
    for (const ref of refs) inputs.set(ref.kind, await this.client.downloadInput(offer, ref));
    const spec = JSON.parse(inputs.get("work-spec")!.toString()) as { schema_version?: unknown; verifier_only?: unknown; physical_execution?: { kind?: unknown } };
    if (verifier ? spec?.schema_version !== "2" || !spec.verifier_only || spec.physical_execution?.kind !== "verifier-only"
      : spec?.verifier_only !== undefined || spec?.physical_execution?.kind === "verifier-only") throw runnerError("remote verifier input set differs from its scoring contract");
    return inputs;
  }

  private async releaseJob(job: ActiveJob): Promise<void> {
    if (!job.settled) throw runnerError("remote work cannot release before executor settlement");
    if (!job.cleaned) { await job.cleanup?.(); job.cleaned = true; }
    job.releaseSentAt ??= new Date().toISOString();
    job.offer = await this.client.release(job.offer, job.releaseSentAt);
    this.handled += 1;
    this.finishJob(job);
    await this.heartbeat();
  }

  private async cleanUnknown(offer: RemoteWorkOfferV1): Promise<void> {
    if (!this.releaseUnknown) throw runnerError("worker has no recovery cleanup implementation; release cannot be acknowledged");
    await this.releaseUnknown(offer);
  }

  private finishJob(job: ActiveJob): void {
    job.allocation.release();
    this.jobs.delete(job.offer.offer_id);
  }
}

function validateResult(value: RemoteWorkerExecutionResult): void {
  if (!value || !new Set(["succeeded", "failed", "cancelled"]).has(value.status)
    || value.release !== undefined && typeof value.release !== "function"
    || value.artifacts !== undefined && (!Array.isArray(value.artifacts) || value.artifacts.some((entry) => !entry
      || !new Set(["result-bundle", "diagnostic"]).has(entry.kind) || !Buffer.isBuffer(entry.body)))) {
    throw runnerError("remote worker executor returned an invalid result");
  }
}

function diagnostic(error: unknown, credentialValues: readonly string[]): Buffer {
  return Buffer.from(`${JSON.stringify({ schema_version: "1", error: safeDiagnosticMessage(error, credentialValues, 2_048), at: new Date().toISOString() })}\n`);
}

function rejectionCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(code) ? code : "invalid-input";
}

async function retry<T>(operation: () => Promise<T>, retryMs: number, signal?: AbortSignal): Promise<T> {
  while (true) {
    try { return await operation(); }
    catch (error) {
      if (signal?.aborted) throw error;
      await delay(retryMs, signal);
    }
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void { signal?.removeEventListener("abort", done); clearTimeout(timer); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function interval(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 50 || value > 5 * 60_000) throw new TypeError(`remote worker ${label} interval is invalid`);
  return value;
}

function runnerError(message: string): HitchError { return new HitchError(message, { code: "remote_worker_invalid_input", exitCode: 12 }); }
