import type { ExecutionLeaseV1, RemoteWorkOfferV1, RemoteWorkerCleanupReceipt } from "../domain/index.js";
import { HitchError, sha256JSON } from "../foundation/index.js";
import { parseRemoteWorkerCleanupReceipt } from "./remote-worker-cleanup.js";

type Confirmation = NonNullable<ExecutionLeaseV1["release_confirmation"]>;

export function parseRemoteReleaseConfirmation(value: unknown, lease: { state: unknown; epoch: number; provider: unknown; resourceEpochs?: number[] }): Confirmation | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  const fields = ["schema_version", "offer_id", "worker_generation", "execution_epoch", "receipt_digest", "released_at",
    ...(record.schema_version === "3" ? ["cleanup_generation", "cleanup_id", "admission_digest"] : [])];
  if (Object.keys(record).length !== fields.length || Object.keys(record).some(key => !fields.includes(key))
    || record.schema_version !== "2" && record.schema_version !== "3" || typeof record.offer_id !== "string" || !/^offer_[a-f0-9]{32}$/.test(record.offer_id)
    || !Number.isSafeInteger(record.worker_generation) || (record.worker_generation as number) < 1
    || !Number.isSafeInteger(record.execution_epoch) || (record.execution_epoch as number) < 1
    || ![record.execution_epoch, (record.execution_epoch as number) + 1].includes(lease.epoch)
    || typeof record.receipt_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.receipt_digest)
    || typeof record.released_at !== "string" || !Number.isFinite(Date.parse(record.released_at))
    || lease.state !== "released" || lease.provider === "local-docker"
    || lease.resourceEpochs && sha256JSON(lease.resourceEpochs) !== sha256JSON([record.execution_epoch])) throw invalid();
  if (record.schema_version === "3" && (!Number.isSafeInteger(record.cleanup_generation) || (record.cleanup_generation as number) <= (record.worker_generation as number)
    || typeof record.cleanup_id !== "string" || !/^cleanup_[a-f0-9]{32}$/.test(record.cleanup_id)
    || typeof record.admission_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.admission_digest))) throw invalid();
  return record as unknown as Confirmation;
}

/** Requires the durable, authenticated worker receipt for the one original execution. */
export function assertRemoteLeaseRelease(lease: ExecutionLeaseV1, offer: RemoteWorkOfferV1, cleanupReceipt?: RemoteWorkerCleanupReceipt): Confirmation {
  const executionEpoch = offer.lease.epoch;
  const fields = ["lease_id", "eval_id", "work_id", "worker_id", "provider", "collision_domain_id", "parent_allocation_id", "reservation", "issued_at"] as const;
  const identity = (value: ExecutionLeaseV1) => Object.fromEntries(fields.filter(field => value[field] !== undefined).map(field => [field, value[field]]));
  const currentEpochMatches = lease.epoch === executionEpoch
    || lease.epoch === executionEpoch + 1 && (lease.state === "lost" || lease.state === "released" && lease.release_confirmation !== undefined);
  if ((!cleanupReceipt && (offer.state !== "released" || !offer.released_at)) || cleanupReceipt && offer.release_receipt_digest
    || !offer.accepted_at || !offer.accept_receipt_digest
    || !currentEpochMatches || lease.provider === "local-docker" || sha256JSON(identity(lease)) !== sha256JSON(identity(offer.lease))
    || offer.worker_id !== lease.worker_id || offer.generation < 1 || offer.work.work_id !== lease.work_id || offer.work.eval_id !== lease.eval_id
    || offer.work.provider !== lease.provider || sha256JSON(offer.work.reservation) !== sha256JSON(lease.reservation)
    || lease.resource_epochs && sha256JSON(lease.resource_epochs) !== sha256JSON([executionEpoch])) throw invalid();
  const receipt = { schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce, generation: offer.generation,
    lease_id: offer.lease.lease_id, epoch: executionEpoch, sent_at: offer.released_at };
  const cleanup = cleanupReceipt ? parseRemoteWorkerCleanupReceipt(cleanupReceipt, offer) : null;
  if (!cleanup && sha256JSON(receipt) !== offer.release_receipt_digest) throw invalid();
  const value = cleanup ? { schema_version: "3", offer_id: offer.offer_id, worker_generation: offer.generation,
    cleanup_generation: cleanup.challenge.generation, cleanup_id: cleanup.challenge.cleanup_id, admission_digest: sha256JSON(cleanup.challenge.admission),
    execution_epoch: executionEpoch, receipt_digest: sha256JSON(cleanup), released_at: cleanup.observed_at } : { schema_version: "2", offer_id: offer.offer_id,
    worker_generation: offer.generation, execution_epoch: executionEpoch, receipt_digest: offer.release_receipt_digest,
    released_at: offer.released_at };
  const confirmation = parseRemoteReleaseConfirmation(value, { state: "released", epoch: lease.epoch, provider: lease.provider,
    ...(lease.resource_epochs ? { resourceEpochs: lease.resource_epochs } : {}) })!;
  if (lease.release_confirmation && sha256JSON(lease.release_confirmation) !== sha256JSON(confirmation)) throw invalid();
  return confirmation;
}

function invalid(): HitchError { return new HitchError("remote cleanup receipt does not prove release of this execution lease", { code: "execution_state_ambiguous", exitCode: 12 }); }
