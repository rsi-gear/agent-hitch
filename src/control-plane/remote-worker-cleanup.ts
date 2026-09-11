import { randomBytes } from "node:crypto";
import path from "node:path";
import type { RemoteWorkOfferV1, RemoteWorkerCleanupChallengeV2, RemoteWorkerCleanupReceipt } from "../domain/index.js";
import { atomicWriteJSON, HitchError, readJSON, sha256JSON, statePaths, withFileLock } from "../foundation/index.js";
import { confirmRemoteExecutionLeaseReleased, parseExecutionLease, parseRemoteWorkerCleanupChallenge, parseRemoteWorkerCleanupReceipt } from "../evals/index.js";
import { RemoteWorkerOwnershipStore } from "./remote-worker-ownership.js";
import type { RemoteWorkerRegistry } from "./remote-workers.js";

/** Independent cleanup authority never rewrites an original v1 offer or receipt. */
export class RemoteWorkerGenerationCleanup {
  private readonly ownership: RemoteWorkerOwnershipStore;
  constructor(private readonly root: string, private readonly registry: RemoteWorkerRegistry,
    private readonly getOffer: (workerId: string, offerId: string) => Promise<RemoteWorkOfferV1 | null>) {
    this.ownership = new RemoteWorkerOwnershipStore(root);
  }

  async read(offer: RemoteWorkOfferV1): Promise<RemoteWorkerCleanupReceipt | null> {
    const value = await readJSON<unknown | null>(this.file(offer, "receipt"), null);
    if (value === null) return null;
    const receipt = parseRemoteWorkerCleanupReceipt(value, offer);
    if (sha256JSON(receipt.challenge.admission) !== sha256JSON(await this.ownership.read(offer))) throw invalid("original execution admission changed");
    return receipt;
  }

  async challenge(workerId: string, offerId: string, generation: number): Promise<{ challenge: RemoteWorkerCleanupChallengeV2 | null; receipt: RemoteWorkerCleanupReceipt | null }> {
    const result = await this.locked(workerId, offerId, generation, async offer => {
      const receipt = await this.read(offer);
      if (receipt) return { challenge: null, receipt, offer };
      const admission = await this.ownership.read(offer);
      if (!admission || !offer.accepted_at || !offer.accept_receipt_digest || offer.state === "released") throw invalid("original authenticated execution ownership is unavailable");
      const old = await readJSON<unknown | null>(this.file(offer, "challenge"), null);
      if (old) {
        const challenge = parseRemoteWorkerCleanupChallenge(old, offer);
        if (challenge.generation === generation && Date.parse(challenge.expires_at) > Date.now()) {
          if (sha256JSON(challenge.admission) !== sha256JSON(admission)) throw invalid("cleanup admission changed");
          return { challenge, receipt: null, offer };
        }
      }
      const now = Date.now();
      const challenge = parseRemoteWorkerCleanupChallenge({ schema_version: "2", cleanup_id: `cleanup_${randomBytes(16).toString("hex")}`,
        nonce: randomBytes(16).toString("hex"), worker_id: workerId, generation, issued_at: new Date(now).toISOString(),
        expires_at: new Date(now + 5 * 60_000).toISOString(), admission }, offer);
      await atomicWriteJSON(this.file(offer, "challenge"), challenge);
      return { challenge, receipt: null, offer };
    });
    if (result.receipt) await this.reconcile(result.offer, result.receipt);
    return { challenge: result.challenge, receipt: result.receipt };
  }

  async commit(workerId: string, offerId: string, generation: number, value: unknown): Promise<RemoteWorkerCleanupReceipt> {
    const { offer, receipt } = await this.locked(workerId, offerId, generation, async offer => {
      const receipt = parseRemoteWorkerCleanupReceipt(value, offer), original = await this.read(offer);
      if (receipt.challenge.generation !== generation) throw invalid("cleanup receipt belongs to a different generation");
      if (original) {
        if (sha256JSON(original) !== sha256JSON(receipt)) throw invalid("physical release receipt cannot be replaced");
        return { offer, receipt: original };
      }
      const challenge = await readJSON<unknown | null>(this.file(offer, "challenge"), null);
      if (!challenge || sha256JSON(challenge) !== sha256JSON(receipt.challenge)
        || Date.parse(receipt.challenge.expires_at) <= Date.now() || Date.parse(receipt.observed_at) > Date.now()
        || sha256JSON(await this.ownership.read(offer)) !== sha256JSON(receipt.challenge.admission)) throw invalid("cleanup challenge expired or differs from the authenticated execution");
      await atomicWriteJSON(this.file(offer, "receipt"), receipt);
      return { offer, receipt };
    });
    await this.reconcile(offer, receipt);
    return receipt;
  }

  /** Replaying the physical fact repairs a crash between receipt and lease publication. */
  async reconcile(offer: RemoteWorkOfferV1, receipt: RemoteWorkerCleanupReceipt): Promise<void> {
    const evalDirectory = path.join(statePaths(this.root).evals, offer.lease.eval_id);
    const value = await readJSON<unknown | null>(path.join(evalDirectory, "leases", `${offer.lease.lease_id}.json`), null);
    if (value === null) return; // Protocol-only users may not have a controller eval journal.
    const lease = parseExecutionLease(value);
    await confirmRemoteExecutionLeaseReleased({ evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch, offer, cleanupReceipt: receipt });
  }

  private locked<T>(workerId: string, offerId: string, generation: number, action: (offer: RemoteWorkOfferV1) => Promise<T>): Promise<T> {
    validateIdentity(workerId, offerId);
    return withFileLock(statePaths(this.root).workerProtocolLocks, offerId, () => this.registry.withGeneration(workerId, generation, async () => {
      const offer = await this.getOffer(workerId, offerId);
      if (!offer || offer.worker_id !== workerId || generation <= offer.generation) throw invalid("cleanup requires a newer generation of the original worker");
      return action(offer);
    }));
  }
  private file(offer: RemoteWorkOfferV1, kind: string): string {
    validateIdentity(offer.worker_id, offer.offer_id);
    return path.join(statePaths(this.root).workerProtocol, "generation-cleanup", offer.worker_id, offer.offer_id, `${kind}.json`);
  }
}
function validateIdentity(workerId: string, offerId: string): void {
  if (!/^worker_[a-z0-9][a-z0-9_-]{0,62}$/.test(workerId) || !/^offer_[a-f0-9]{32}$/.test(offerId)) throw invalid("invalid cleanup identity");
}
function invalid(message: string): HitchError { return new HitchError(message, { code: "remote_worker_cleanup_ambiguous", exitCode: 12 }); }
