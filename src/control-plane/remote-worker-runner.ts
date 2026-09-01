import type { RemoteWorkArtifactRefV1, RemoteWorkInputRefV1, RemoteWorkOfferV1, ResourceVectorV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import { ResourceLedger } from "./resources.js";
import { RemoteWorkerHttpClient } from "./remote-worker-client.js";

export interface RemoteWorkerExecutionResult {
  status: "succeeded" | "failed" | "cancelled";
  artifacts?: Array<{ kind: RemoteWorkArtifactRefV1["kind"]; body: Buffer }>;
  release?: () => Promise<void>;
}

export interface RemoteWorkerExecutorInput {
  offer: RemoteWorkOfferV1;
  inputs: ReadonlyMap<RemoteWorkInputRefV1["kind"], Buffer>;
  signal: AbortSignal;
  emit(type: string, payload?: Record<string, unknown>): Promise<void>;
}

export type RemoteWorkerExecutor = (input: RemoteWorkerExecutorInput) => Promise<RemoteWorkerExecutionResult>;

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
  onError?: (error: unknown) => void;
}

interface ActiveJob {
  offer: RemoteWorkOfferV1;
  controller: AbortController;
  allocation: ReturnType<ResourceLedger["tryAcquire"]> & {};
  accepted: boolean;
  settled: boolean;
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
  private readonly releaseUnknown: (offer: RemoteWorkOfferV1) => Promise<void>;
  private readonly ledger: ResourceLedger;
  private readonly jobs = new Map<string, ActiveJob>();
  private handled = 0;
  private lastHeartbeat = 0;

  constructor(options: RemoteWorkerRunnerOptions) {
    this.client = options.client;
    this.execute = options.execute;
    this.signal = options.signal;
    this.once = options.once ?? false;
    this.pollIntervalMs = interval(options.pollIntervalMs ?? 1_000, "poll");
    this.heartbeatIntervalMs = interval(options.heartbeatIntervalMs ?? 10_000, "heartbeat");
    this.retryIntervalMs = interval(options.retryIntervalMs ?? 1_000, "retry");
    this.onError = options.onError ?? (() => undefined);
    this.releaseUnknown = options.releaseUnknown ?? (() => Promise.resolve());
    this.ledger = new ResourceLedger(options.capacity);
  }

  async run(): Promise<void> {
    while (!this.signal?.aborted) {
      try { await this.tick(); }
      catch (error) { this.onError(error); }
      if (this.once && this.handled > 0 && this.jobs.size === 0) return;
      await delay(this.pollIntervalMs, this.signal);
    }
    for (const job of this.jobs.values()) job.controller.abort(this.signal?.reason);
    await Promise.allSettled([...this.jobs.values()].map((job) => job.promise));
  }

  async tick(): Promise<void> {
    const offers = await this.client.listOffers();
    const visible = new Map(offers.map((offer) => [offer.offer_id, offer]));
    const released = new Set<string>();
    for (const job of this.jobs.values()) {
      const current = visible.get(job.offer.offer_id);
      if (!current) continue;
      job.offer = current;
      if (current.state === "cancel-requested") job.controller.abort(new Error("remote work cancellation requested"));
      if (current.state === "release-requested") { await this.releaseJob(job); released.add(current.offer_id); }
    }
    for (const offer of offers) {
      if (this.jobs.has(offer.offer_id) || released.has(offer.offer_id)) continue;
      if (offer.state === "release-requested" || offer.state === "cancel-requested") {
        await this.releaseUnknown(offer);
        await this.client.release(offer);
        this.handled += 1;
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
      offer, controller, allocation, accepted: false, settled: false, cleanup: undefined,
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
    try {
      inputs = await this.downloadInputs(job.offer);
    } catch (error) {
      await this.client.reject(job.offer, rejectionCode(error));
      this.handled += 1;
      this.finishJob(job);
      return;
    }
    const accepted = await retry(() => this.client.accept(job.offer), this.retryIntervalMs, this.signal);
    if (accepted.state !== "accepted") {
      this.handled += 1;
      this.finishJob(job);
      return;
    }
    job.offer = accepted;
    job.accepted = true;
    await this.heartbeat();
    let sequence = 0;
    const emit = (type: string, payload?: Record<string, unknown>) => retry(
      () => this.client.emit(job.offer, ++sequence, type, payload), this.retryIntervalMs, job.controller.signal,
    );
    let result: RemoteWorkerExecutionResult;
    try {
      result = await this.execute({ offer: job.offer, inputs, signal: job.controller.signal, emit });
      validateResult(result);
      job.cleanup = result.release;
    } catch (error) {
      result = {
        status: job.controller.signal.aborted ? "cancelled" : "failed",
        artifacts: [{ kind: "diagnostic", body: diagnostic(error) }],
      };
    }
    const artifacts: RemoteWorkArtifactRefV1[] = [];
    for (const artifact of result.artifacts ?? []) {
      artifacts.push(await retry(
        () => this.client.uploadArtifact(job.offer, artifact.kind, artifact.body), this.retryIntervalMs, this.signal,
      ));
    }
    job.offer = await retry(
      () => this.client.complete(job.offer, result.status, artifacts), this.retryIntervalMs, this.signal,
    );
    job.settled = true;
    await this.heartbeat();
  }

  private async downloadInputs(offer: RemoteWorkOfferV1): Promise<Map<RemoteWorkInputRefV1["kind"], Buffer>> {
    const refs = offer.inputs ?? [];
    if (refs.length !== REQUIRED_INPUTS.size || refs.some((ref) => !REQUIRED_INPUTS.has(ref.kind))
      || new Set(refs.map((ref) => ref.kind)).size !== REQUIRED_INPUTS.size) throw runnerError("remote work offer is missing required inputs");
    const inputs = new Map<RemoteWorkInputRefV1["kind"], Buffer>();
    for (const ref of refs) inputs.set(ref.kind, await this.client.downloadInput(offer, ref));
    return inputs;
  }

  private async releaseJob(job: ActiveJob): Promise<void> {
    await job.cleanup?.();
    job.offer = await this.client.release(job.offer);
    this.handled += 1;
    this.finishJob(job);
    await this.heartbeat();
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

function diagnostic(error: unknown): Buffer {
  return Buffer.from(`${JSON.stringify({ schema_version: "1", error: safeMessage(error), at: new Date().toISOString() })}\n`);
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

function safeMessage(error: unknown): string { return ((error as Error)?.message || String(error)).slice(0, 2_048); }
function runnerError(message: string): HitchError { return new HitchError(message, { code: "remote_worker_invalid_input", exitCode: 12 }); }
