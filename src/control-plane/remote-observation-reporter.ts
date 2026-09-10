import type { ExecutionObservationSourceV2 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";
import { RemoteWorkerHttpClient } from "./remote-worker-client.js";

/** Version probes run outside the work/heartbeat loop and never acquire a task allocation. */
export class RemoteObservationReporter {
  private readonly stopController = new AbortController();
  private pending: Promise<void> | undefined;
  constructor(private readonly client: RemoteWorkerHttpClient, private readonly source: ExecutionObservationSourceV2,
    private readonly onError: (error: unknown) => void) {}

  tick(): void {
    if (this.pending || this.stopController.signal.aborted) return;
    this.pending = this.report().catch(error => {
      if (!this.stopController.signal.aborted) this.onError(error);
    }).finally(() => { this.pending = undefined; });
  }

  async stop(): Promise<void> { this.stopController.abort(); await this.pending; }

  private async report(): Promise<void> {
    const signal = AbortSignal.any([this.stopController.signal, AbortSignal.timeout(40_000)]);
    const challenge = await this.client.pollExecutionObservation(signal);
    if (!challenge) return;
    const remaining = Date.parse(challenge.expires_at) - Date.now();
    if (remaining <= 0) return;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.min(remaining, 35_000))]);
    const { runtime, environment } = await this.source.observe(deadline);
    deadline.throwIfAborted();
    await this.client.submitExecutionObservation({ schema_version: "2", challenge, runtime, environment, environment_digest: sha256JSON(environment) }, deadline);
  }
}
