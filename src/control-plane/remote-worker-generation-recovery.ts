import type { RemoteWorkOfferV1, RemoteWorkerCleanupObservation, RemoteWorkerCleanupReceipt, RemoteWorkerExecutionAdmissionV2 } from "../domain/index.js";
import type { RemoteWorkerHttpClient } from "./remote-worker-client.js";

export type RemoteWorkerGenerationCleaner = (offer: RemoteWorkOfferV1, admission: RemoteWorkerExecutionAdmissionV2) => Promise<RemoteWorkerCleanupObservation>;

/** Keep heartbeats and current work responsive while old resources are cleaned. */
export class RemoteWorkerGenerationRecovery {
  private running: Promise<void> | undefined;
  private readonly attempts = new Map<string, { offer: RemoteWorkOfferV1; receipt?: RemoteWorkerCleanupReceipt; retryAfter: number }>();
  private readonly completed = new Set<string>();
  get idle(): boolean { return this.running === undefined && this.attempts.size === 0; }
  constructor(private readonly client: RemoteWorkerHttpClient, private readonly clean: RemoteWorkerGenerationCleaner,
    private readonly signal: AbortSignal, private readonly retryMs: number, private readonly onError: (error: unknown) => void,
    private readonly onComplete: () => void) {}

  tick(offers: RemoteWorkOfferV1[]): void {
    if (this.signal.aborted) return;
    for (const offer of offers) if (offer.worker_id === this.client.workerId && offer.generation < this.client.generation && offer.accepted_at
      && !this.completed.has(offer.offer_id) && !this.attempts.has(offer.offer_id)) this.attempts.set(offer.offer_id, { offer, retryAfter: 0 });
    if (this.running) return;
    const attempt = [...this.attempts.values()].find(item => item.retryAfter <= Date.now());
    if (!attempt) return;
    // A missing/ambiguous old journal cannot starve another recoverable offer.
    this.attempts.delete(attempt.offer.offer_id); this.attempts.set(attempt.offer.offer_id, attempt);
    this.running = this.recover(attempt).finally(() => { this.running = undefined; });
  }
  async stop(): Promise<void> { await this.running; }

  private async recover(attempt: { offer: RemoteWorkOfferV1; receipt?: RemoteWorkerCleanupReceipt; retryAfter: number }): Promise<void> {
    const { offer } = attempt;
    const complete = () => { this.attempts.delete(offer.offer_id); this.completed.add(offer.offer_id); this.onComplete(); };
    try {
        if (!attempt.receipt || Date.parse(attempt.receipt.challenge.expires_at) <= Date.now()) {
          const next = await this.client.cleanupChallenge(offer);
          if (next.receipt) { complete(); return; }
          const challenge = next.challenge!;
          const observation = await this.clean(offer, challenge.admission);
          this.signal.throwIfAborted();
          const observed_at = new Date().toISOString();
          attempt.receipt = observation.worker_status === "previous-boot"
            ? { schema_version: "3", challenge, observed_at, observation }
            : { schema_version: "2", challenge, observed_at, observation };
        }
        await this.client.commitCleanup(offer, attempt.receipt);
        complete();
    } catch (error) { attempt.retryAfter = Date.now() + this.retryMs; if (!this.signal.aborted) this.onError(error); }
  }
}
