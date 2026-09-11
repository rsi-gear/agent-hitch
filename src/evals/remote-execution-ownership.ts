import type { RemoteWorkOfferV1, RemoteWorkerExecutionAdmissionV2, RemoteWorkerExecutionOwnership, RemoteWorkerHostIdentityV1 } from "../domain/index.js";
import { HitchError, sha256JSON, validateProcessIdentity } from "../foundation/index.js";

/** Same recipe as the existing worker's private execution journal. */
export function remoteExecutionBindingDigest(offer: RemoteWorkOfferV1) {
  const { lease_id, eval_id, work_id, worker_id, provider, collision_domain_id, epoch, reservation } = offer.lease;
  const lease = sha256JSON({ lease_id, eval_id, work_id, worker_id, provider, collision_domain_id, epoch, reservation,
    resource_epochs: offer.lease.resource_epochs ?? [epoch] });
  return sha256JSON({ offer_id: offer.offer_id, nonce: offer.nonce, worker_id: offer.worker_id, generation: offer.generation,
    lease, work: offer.work, inputs: offer.inputs ?? [], credential_names: offer.credential_names ?? [] });
}

export function parseRemoteExecutionOwnership(value: unknown, offer?: RemoteWorkOfferV1): RemoteWorkerExecutionOwnership {
  const v3 = !!value && typeof value === "object" && (value as { schema_version?: unknown }).schema_version === "3";
  const record = exact(value, ["schema_version", "binding_digest", "root_id", "root_digest", "boot_digest", "docker_engine_id", "worker_process", ...(v3 ? ["host_identity"] : [])]);
  if (record.schema_version !== "2" && !v3 || !digest(record.binding_digest) || !digest(record.root_digest) || !digest(record.boot_digest)
    || typeof record.root_id !== "string" || !/^[a-f0-9]{24}$/.test(record.root_id)
    || typeof record.docker_engine_id !== "string" || !record.docker_engine_id || record.docker_engine_id.length > 256 || /[\s\x00-\x1f]/.test(record.docker_engine_id)
    || offer && record.binding_digest !== remoteExecutionBindingDigest(offer)) throw invalid("worker execution ownership differs from its offer");
  if (v3 && sha256JSON(parseRemoteWorkerHostIdentity(record.host_identity)) !== record.boot_digest) throw invalid("host boot identity differs from its original ownership");
  return { ...record, worker_process: validateProcessIdentity(record.worker_process) } as unknown as RemoteWorkerExecutionOwnership;
}

export function parseRemoteWorkerHostIdentity(value: unknown): RemoteWorkerHostIdentityV1 {
  const record = exact(value, ["schema_version", "platform", "host_id", "boot_id"]);
  if (record.schema_version !== "1" || !["linux", "darwin"].includes(String(record.platform)) || !digest(record.host_id) || !digest(record.boot_id)) throw invalid("invalid host identity");
  return record as unknown as RemoteWorkerHostIdentityV1;
}

export function parseRemoteExecutionAdmission(value: unknown, offer: RemoteWorkOfferV1): RemoteWorkerExecutionAdmissionV2 {
  const record = exact(value, ["schema_version", "offer_id", "worker_id", "generation", "lease_id", "execution_epoch", "accepted_at", "ownership", "ownership_digest", "execution_process"]);
  const ownership = parseRemoteExecutionOwnership(record.ownership, offer);
  if (record.schema_version !== "2" || record.offer_id !== offer.offer_id || record.worker_id !== offer.worker_id || record.generation !== offer.generation
    || record.lease_id !== offer.lease.lease_id || record.execution_epoch !== offer.lease.epoch || !timestamp(record.accepted_at)
    || offer.accepted_at !== undefined && offer.accepted_at !== record.accepted_at || record.ownership_digest !== sha256JSON(ownership)) {
    throw invalid("worker execution admission differs from its accepted offer");
  }
  const executionProcess = record.execution_process === null ? null : validateProcessIdentity(record.execution_process);
  if (executionProcess?.pid === ownership.worker_process.pid) throw invalid("worker and Harbor supervisor must be separate processes");
  return { ...record, ownership, execution_process: executionProcess } as unknown as RemoteWorkerExecutionAdmissionV2;
}

function exact(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length
    || Object.keys(value).some(key => !fields.includes(key))) throw invalid("invalid worker execution ownership record");
  return value as Record<string, unknown>;
}
function digest(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function timestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function invalid(message: string): HitchError { return new HitchError(message, { code: "worker_execution_ownership_invalid", exitCode: 12 }); }
