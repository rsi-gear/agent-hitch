import { randomBytes } from "node:crypto";
import type { RemoteExecutionObservationChallengeV2, RemoteExecutionObservationReceiptV2, RemoteWorkerPublicRecordV1 } from "../domain/index.js";
import { HitchError, sha256JSON } from "../foundation/index.js";
import { RemoteWorkerRegistry } from "./remote-workers.js";
import { parseExecutionObservationReceipt } from "./execution-observation-contract.js";

interface PendingObservation {
  challenge: RemoteExecutionObservationChallengeV2;
  complete(receipt: RemoteExecutionObservationReceiptV2): void;
  fail(error: Error): void;
}
const problem = (code: string, message: string) => new HitchError(message, { code, exitCode: 12 });

/** Read-only challenges live for one daemon request. Restart/timeout never reuses cached observations. */
export class RemoteExecutionObservationCoordinator {
  private readonly pending = new Map<string, PendingObservation>();
  private closed = false;
  private readonly timeoutMs: number;
  constructor(private readonly input: { registry: RemoteWorkerRegistry; instanceId: string; timeoutMs?: number }) {
    this.timeoutMs = input.timeoutMs ?? 35_000;
    if (!/^[a-f0-9]{32}$/.test(input.instanceId) || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 20 || this.timeoutMs > 40_000) throw new TypeError("invalid observation coordinator options");
  }

  async observe(provider: string, nonce: string, signal: AbortSignal): Promise<RemoteExecutionObservationReceiptV2> {
    signal.throwIfAborted();
    if (this.closed) throw problem("execution_observation_closed", "daemon observation service is closed");
    if (!/^[a-f0-9]{32}$/.test(nonce)) throw problem("invalid_input", "invalid observation nonce");
    const matches = (await this.input.registry.list()).filter(record => record.worker.provider === provider);
    if (matches.length !== 1) throw problem("execution_observation_unsupported", "select exactly one registered worker for provider observation");
    const worker = matches[0]!;
    this.assertAvailable(worker);
    const workerId = worker.worker.worker_id;
    if (this.pending.has(workerId)) throw problem("execution_observation_busy", "a fresh observation for this worker is already pending; retry");
    const challenge: RemoteExecutionObservationChallengeV2 = { schema_version: "2", request_id: randomBytes(16).toString("hex"), nonce,
      daemon_instance_id: this.input.instanceId, worker_id: workerId, generation: worker.generation, provider,
      collision_domain_id: worker.worker.collision_domain_id, expires_at: new Date(Date.now() + this.timeoutMs).toISOString() };
    const receipt = await new Promise<RemoteExecutionObservationReceiptV2>((resolve, reject) => {
      const finish = (result?: RemoteExecutionObservationReceiptV2, error?: Error) => {
        if (this.pending.get(workerId) !== entry) return;
        this.pending.delete(workerId); clearTimeout(timer); signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(result!);
      };
      const abort = () => finish(undefined, problem("execution_observation_cancelled", "observation requester disconnected"));
      const timer = setTimeout(() => finish(undefined, problem("execution_observation_timeout", "worker did not return a fresh runtime/environment observation before its deadline")), this.timeoutMs);
      const entry: PendingObservation = { challenge, complete: result => finish(result), fail: error => finish(undefined, error) };
      this.pending.set(workerId, entry); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else if (this.closed) entry.fail(problem("execution_observation_closed", "daemon observation service is closed"));
    });
    await this.assertGeneration(challenge);
    return receipt;
  }

  async poll(workerId: string, generation: number): Promise<RemoteExecutionObservationChallengeV2 | null> {
    await this.input.registry.validateHeartbeatGeneration(workerId, generation);
    const pending = this.pending.get(workerId);
    if (!pending) return null;
    if (pending.challenge.generation !== generation) {
      pending.fail(problem("worker_generation_mismatch", "worker generation changed during environment observation"));
      return null;
    }
    if (Date.parse(pending.challenge.expires_at) <= Date.now()) {
      pending.fail(problem("execution_observation_timeout", "worker observation deadline expired"));
      return null;
    }
    return structuredClone(pending.challenge);
  }

  async submit(workerId: string, value: unknown): Promise<void> {
    const receipt = parseExecutionObservationReceipt(value), challenge = receipt.challenge;
    if (challenge.worker_id !== workerId) throw problem("execution_observation_mismatch", "observation belongs to another worker");
    await this.assertGeneration(challenge);
    const pending = this.pending.get(workerId);
    if (!pending || sha256JSON(pending.challenge) !== sha256JSON(challenge)
      || challenge.daemon_instance_id !== this.input.instanceId || Date.parse(challenge.expires_at) <= Date.now()) {
      throw problem("execution_observation_mismatch", "observation challenge is stale, expired or does not match this daemon request");
    }
    pending.complete(receipt);
  }

  close(): void {
    this.closed = true;
    for (const entry of this.pending.values()) entry.fail(problem("execution_observation_closed", "daemon stopped before the worker observation completed"));
  }

  private async assertGeneration(challenge: RemoteExecutionObservationChallengeV2): Promise<void> {
    await this.input.registry.validateHeartbeatGeneration(challenge.worker_id, challenge.generation);
    const current = await this.input.registry.get(challenge.worker_id);
    if (!current || current.generation !== challenge.generation || current.worker.provider !== challenge.provider
      || current.worker.collision_domain_id !== challenge.collision_domain_id) throw problem("execution_observation_mismatch", "worker observation identity changed");
    this.assertAvailable(current);
  }
  private assertAvailable(worker: RemoteWorkerPublicRecordV1): void {
    if (worker.revoked_at || worker.worker.status !== "ready" || worker.provider_status.health !== "healthy") {
      throw problem("execution_provider_unavailable", "worker must be healthy and online for environment observation");
    }
    if (worker.provider_status.features.execution_observation !== "2") {
      throw problem("execution_observation_unsupported", "worker must advertise execution_observation 2 and run a supporting Hitch binary");
    }
  }
}
