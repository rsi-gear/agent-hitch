import path from "node:path";
import type { RemoteWorkOfferV1, RemoteWorkerExecutionAdmissionV2, RemoteWorkerExecutionOwnership } from "../domain/index.js";
import { atomicWriteJSON, HitchError, readJSON, sha256JSON, statePaths, validateProcessIdentity } from "../foundation/index.js";

import { parseRemoteExecutionAdmission, parseRemoteExecutionOwnership } from "../evals/index.js";
export { parseRemoteExecutionAdmission, parseRemoteExecutionOwnership, remoteExecutionBindingDigest } from "../evals/index.js";

/** Mutations run under the protocol's offer lock and worker generation guard. */
export class RemoteWorkerOwnershipStore {
  private readonly directory: string;
  constructor(root: string) { this.directory = path.join(statePaths(root).workerProtocol, "execution-ownership"); }

  async read(offer: RemoteWorkOfferV1): Promise<RemoteWorkerExecutionAdmissionV2 | null> {
    const value = await readJSON<unknown | null>(this.file(offer), null);
    return value === null ? null : parseRemoteExecutionAdmission(value, offer);
  }

  async admit(offer: RemoteWorkOfferV1, value: RemoteWorkerExecutionOwnership): Promise<RemoteWorkerExecutionAdmissionV2> {
    if (!offer.accepted_at) throw invalid("execution ownership requires acknowledged acceptance");
    const ownership = parseRemoteExecutionOwnership(value, offer), existing = await this.read(offer);
    if (existing) {
      if (existing.ownership_digest !== sha256JSON(ownership)) throw invalid("accepted worker execution ownership cannot be replaced");
      return existing;
    }
    if (offer.state !== "accepted") throw invalid("execution ownership requires acknowledged acceptance");
    const admission = parseRemoteExecutionAdmission({ schema_version: "2", offer_id: offer.offer_id, worker_id: offer.worker_id,
      generation: offer.generation, lease_id: offer.lease.lease_id, execution_epoch: offer.lease.epoch, accepted_at: offer.accepted_at,
      ownership, ownership_digest: sha256JSON(ownership), execution_process: null }, offer);
    await atomicWriteJSON(this.file(offer), admission);
    return admission;
  }

  async authorizeProcess(offer: RemoteWorkOfferV1, ownershipDigest: unknown, value: unknown): Promise<RemoteWorkerExecutionAdmissionV2> {
    const record = await this.read(offer), identity = validateProcessIdentity(value);
    if (!record || record.ownership_digest !== ownershipDigest || offer.state !== "accepted"
      || identity.pid === record.ownership.worker_process.pid) throw invalid("Harbor process has no matching execution admission");
    if (record.execution_process) {
      if (sha256JSON(record.execution_process) !== sha256JSON(identity)) throw invalid("authorized Harbor process cannot be replaced");
      return record;
    }
    const next = parseRemoteExecutionAdmission({ ...record, execution_process: identity }, offer);
    await atomicWriteJSON(this.file(offer), next);
    return next;
  }

  private file(offer: RemoteWorkOfferV1): string {
    if (!/^offer_[a-f0-9]{32}$/.test(offer.offer_id) || !/^worker_[a-z0-9][a-z0-9_-]{0,62}$/.test(offer.worker_id)) throw invalid("invalid execution ownership path");
    return path.join(this.directory, offer.worker_id, `${offer.offer_id}.json`);
  }
}

function invalid(message: string): HitchError { return new HitchError(message, { code: "worker_execution_ownership_invalid", exitCode: 12 }); }
