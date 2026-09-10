import type { RemoteWorkOfferV1, RemoteWorkerCleanupChallengeV2, RemoteWorkerCleanupReceipt } from "../domain/index.js";
import { HitchError, sha256JSON } from "../foundation/index.js";
import { parseRemoteExecutionAdmission, parseRemoteExecutionOwnership, parseRemoteWorkerHostIdentity } from "./remote-execution-ownership.js";

export function parseRemoteWorkerCleanupChallenge(value: unknown, offer: RemoteWorkOfferV1): RemoteWorkerCleanupChallengeV2 {
  const record = exact(value, ["schema_version", "cleanup_id", "nonce", "worker_id", "generation", "issued_at", "expires_at", "admission"]);
  const admission = parseRemoteExecutionAdmission(record.admission, offer);
  if (record.schema_version !== "2" || typeof record.cleanup_id !== "string" || !/^cleanup_[a-f0-9]{32}$/.test(record.cleanup_id)
    || typeof record.nonce !== "string" || !/^[a-f0-9]{32}$/.test(record.nonce) || record.worker_id !== offer.worker_id
    || !Number.isSafeInteger(record.generation) || (record.generation as number) <= offer.generation
    || !timestamp(record.issued_at) || !timestamp(record.expires_at) || Date.parse(record.expires_at) <= Date.parse(record.issued_at)
    || Date.parse(record.expires_at) - Date.parse(record.issued_at) > 5 * 60_000
    || !offer.accepted_at || !offer.accept_receipt_digest) throw invalid();
  return { ...record, admission } as unknown as RemoteWorkerCleanupChallengeV2;
}

export function parseRemoteWorkerCleanupReceipt(value: unknown, offer: RemoteWorkOfferV1): RemoteWorkerCleanupReceipt {
  const record = exact(value, ["schema_version", "challenge", "observed_at", "observation"]);
  const challenge = parseRemoteWorkerCleanupChallenge(record.challenge, offer);
  const reboot = record.schema_version === "3";
  const observation = exact(record.observation, ["ownership", "execution_process", "worker_status", "docker_resources_empty", reboot ? "host_identity" : "process_group_empty"]);
  const ownership = parseRemoteExecutionOwnership(observation.ownership, offer);
  if (record.schema_version !== "2" && !reboot || !timestamp(record.observed_at) || Date.parse(record.observed_at) < Date.parse(challenge.issued_at)
    || Date.parse(record.observed_at) > Date.parse(challenge.expires_at)
    || sha256JSON(ownership) !== challenge.admission.ownership_digest
    || sha256JSON(observation.execution_process) !== sha256JSON(challenge.admission.execution_process)
    || observation.docker_resources_empty !== true) throw invalid();
  if (reboot) {
    const host = parseRemoteWorkerHostIdentity(observation.host_identity);
    if (ownership.schema_version !== "3" || observation.worker_status !== "previous-boot"
      || host.platform !== ownership.host_identity.platform || host.host_id !== ownership.host_identity.host_id
      || host.boot_id === ownership.host_identity.boot_id) throw invalid();
  } else if (!["terminal", "identity-mismatch"].includes(String(observation.worker_status)) || observation.process_group_empty !== true) throw invalid();
  return { ...record, challenge, observation: { ...observation, ownership } } as unknown as RemoteWorkerCleanupReceipt;
}

function exact(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length
    || Object.keys(value).some(key => !fields.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}
function timestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function invalid(): HitchError { return new HitchError("worker generation cleanup does not match the original execution", { code: "remote_worker_cleanup_ambiguous", exitCode: 12 }); }
