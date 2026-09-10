import type { RemoteWorkArtifactRefV1, RemoteWorkInputRefV1, RemoteWorkOfferV1, RemoteWorkerEventV1, Sha256 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import { parseExecutionLease } from "../evals/index.js";
import { canonicalRemoteCredentialNames } from "./remote-worker-credentials.js";
import { parseRemoteWorkItem } from "./remote-work-item.js";

const OFFER_ID = /^offer_[a-f0-9]{32}$/;
const LEASE_ID = /^lease_[a-f0-9]{32}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

type RecordValue = Record<string, unknown>;

interface ReceiptIdentity {
  schema_version: "1";
  offer_id: string;
  nonce: string;
  generation: number;
  sent_at: string;
}

interface AcceptReceipt extends ReceiptIdentity {
  accepted: boolean;
  rejection_code?: string;
}

interface ReleaseReceipt extends ReceiptIdentity {
  lease_id: string;
  epoch: number;
}

interface TerminalReceipt extends ReleaseReceipt {
  status: "succeeded" | "failed" | "cancelled";
  artifacts: RemoteWorkArtifactRefV1[];
}

export function parseRemoteWorkOffer(value: unknown): RemoteWorkOfferV1 {
  const record = exact(value, [
    "schema_version", "offer_id", "nonce", "generation", "worker_id", "lease", "work", "inputs", "credential_names",
    "state", "issued_at", "expires_at", "accepted_at", "completed_at", "released_at", "rejection_code", "terminal",
    "accept_receipt_digest", "terminal_receipt_digest", "release_receipt_digest",
  ], "remote work offer");
  const states = new Set(["offered", "accepted", "rejected", "cancel-requested", "completed", "release-requested", "released", "expired"]);
  if (record.schema_version !== "1" || typeof record.offer_id !== "string" || !OFFER_ID.test(record.offer_id)
    || typeof record.nonce !== "string" || !/^[a-f0-9]{64}$/.test(record.nonce)
    || !Number.isSafeInteger(record.generation) || (record.generation as number) < 1
    || typeof record.worker_id !== "string" || !/^worker_[a-z0-9][a-z0-9_-]{0,62}$/.test(record.worker_id)
    || !states.has(String(record.state)) || !timestamp(record.issued_at) || !timestamp(record.expires_at)) {
    throw protocolError("remote work offer identity is invalid");
  }
  for (const field of ["accepted_at", "completed_at", "released_at"] as const) {
    if (record[field] !== undefined && !timestamp(record[field])) {
      throw protocolError(`remote work offer ${field} is invalid`);
    }
  }
  for (const field of ["accept_receipt_digest", "terminal_receipt_digest", "release_receipt_digest"] as const) {
    if (record[field] !== undefined && (typeof record[field] !== "string" || !SHA256.test(record[field] as string))) {
      throw protocolError(`remote work offer ${field} is invalid`);
    }
  }
  const lease = parseExecutionLease(record.lease);
  const work = parseRemoteWorkItem(record.work);
  let inputs: RemoteWorkInputRefV1[] | undefined;
  if (record.inputs !== undefined) {
    if (!Array.isArray(record.inputs)) throw protocolError("remote work inputs are invalid");
    inputs = record.inputs.map(parseInputRef);
    if (new Set(inputs.map(entry => entry.kind)).size !== inputs.length) {
      throw protocolError("remote work inputs are duplicated");
    }
  }
  const credentialNames = record.credential_names === undefined
    ? undefined : canonicalRemoteCredentialNames(record.credential_names as readonly string[]);
  const terminal = record.terminal === undefined ? undefined : parseTerminal(record.terminal);
  const requiresTerminal = record.state === "completed" || record.state === "release-requested" || record.state === "released";
  if (lease.worker_id !== record.worker_id || lease.work_id !== work.work_id || lease.eval_id !== work.eval_id
    || requiresTerminal !== (terminal !== undefined)) {
    throw protocolError("remote work offer evidence is inconsistent");
  }
  return {
    ...record,
    ...(inputs ? { inputs } : {}),
    ...(credentialNames?.length ? { credential_names: credentialNames } : {}),
  } as unknown as RemoteWorkOfferV1;
}

export function parseAcceptReceipt(value: unknown): AcceptReceipt {
  const record = exact(value, [
    "schema_version", "offer_id", "nonce", "generation", "accepted", "rejection_code", "sent_at",
  ], "remote work accept receipt");
  const rejected = record.accepted === false;
  const hasRejectionCode = typeof record.rejection_code === "string" && Boolean(record.rejection_code);
  if (!validReceiptIdentity(record) || typeof record.accepted !== "boolean" || rejected !== hasRejectionCode) {
    throw protocolError("remote work accept receipt is invalid");
  }
  return record as unknown as AcceptReceipt;
}

export function parseTerminalReceipt(value: unknown): TerminalReceipt {
  const record = exact(value, [
    "schema_version", "offer_id", "nonce", "generation", "lease_id", "epoch", "status", "artifacts", "sent_at",
  ], "remote work terminal receipt");
  if (!validReceiptIdentity(record) || !validLeaseIdentity(record)
    || !TERMINAL_STATUSES.has(String(record.status)) || !Array.isArray(record.artifacts)) {
    throw protocolError("remote work terminal receipt is invalid");
  }
  const artifacts = record.artifacts.map(parseArtifactRef).sort((left, right) => left.digest.localeCompare(right.digest));
  if (new Set(artifacts.map(entry => `${entry.kind}:${entry.digest}`)).size !== artifacts.length) {
    throw protocolError("remote work terminal artifacts are duplicated");
  }
  return { ...record, artifacts } as unknown as TerminalReceipt;
}

export function parseReleaseReceipt(value: unknown): ReleaseReceipt {
  const record = exact(value, [
    "schema_version", "offer_id", "nonce", "generation", "lease_id", "epoch", "sent_at",
  ], "remote work release receipt");
  if (!validReceiptIdentity(record) || !validLeaseIdentity(record)) {
    throw protocolError("remote work release receipt is invalid");
  }
  return record as unknown as ReleaseReceipt;
}

function validReceiptIdentity(record: RecordValue): boolean {
  return record.schema_version === "1" && typeof record.offer_id === "string" && OFFER_ID.test(record.offer_id)
    && typeof record.nonce === "string" && /^[a-f0-9]{64}$/.test(record.nonce)
    && Number.isSafeInteger(record.generation) && (record.generation as number) >= 1 && timestamp(record.sent_at);
}

function validLeaseIdentity(record: RecordValue): boolean {
  return typeof record.lease_id === "string" && LEASE_ID.test(record.lease_id)
    && Number.isSafeInteger(record.epoch) && (record.epoch as number) >= 1;
}

export function parseRemoteWorkerEvent(value: unknown): RemoteWorkerEventV1 {
  const record = exact(value, [
    "schema_version", "generation", "lease_id", "epoch", "sequence", "type", "payload", "sent_at",
  ], "remote worker event");
  const invalidPayload = record.payload !== undefined
    && (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload));
  if (record.schema_version !== "1" || !Number.isSafeInteger(record.generation) || (record.generation as number) < 1
    || !validLeaseIdentity(record) || !Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1
    || typeof record.type !== "string" || !record.type || record.type.length > 256
    || invalidPayload || !timestamp(record.sent_at)) {
    throw protocolError("remote worker event is invalid");
  }
  return record as unknown as RemoteWorkerEventV1;
}

function parseTerminal(value: unknown): NonNullable<RemoteWorkOfferV1["terminal"]> {
  const record = exact(value, ["status", "artifacts", "sent_at"], "remote work terminal evidence");
  if (!TERMINAL_STATUSES.has(String(record.status)) || !Array.isArray(record.artifacts) || !timestamp(record.sent_at)) {
    throw protocolError("remote work terminal evidence is invalid");
  }
  return {
    status: record.status as "succeeded" | "failed" | "cancelled",
    artifacts: record.artifacts.map(parseArtifactRef),
    sent_at: record.sent_at as string,
  };
}

function parseArtifactRef(value: unknown): RemoteWorkArtifactRefV1 {
  const record = exact(value, ["kind", "digest", "size"], "remote work artifact ref");
  if ((record.kind !== "result-bundle" && record.kind !== "diagnostic")
    || typeof record.digest !== "string" || !SHA256.test(record.digest)
    || !Number.isSafeInteger(record.size) || (record.size as number) < 0 || (record.size as number) > 512 * 1024 * 1024) {
    throw protocolError("remote work artifact ref is invalid");
  }
  return { kind: record.kind, digest: record.digest as Sha256, size: record.size as number };
}

export function parseInputRef(value: unknown): RemoteWorkInputRefV1 {
  const record = exact(value, ["kind", "format", "digest", "size"], "remote work input ref");
  const kinds = new Set(["work-spec", "harness-artifact", "controller-runtime", "task-input", "verifier-source", "verifier-runtime"]);
  if (!kinds.has(String(record.kind)) || !new Set(["json", "hitch-tree-v1"]).has(String(record.format))
    || typeof record.digest !== "string" || !SHA256.test(record.digest)
    || !Number.isSafeInteger(record.size) || (record.size as number) < 1 || (record.size as number) > 256 * 1024 * 1024) {
    throw protocolError("remote work input ref is invalid");
  }
  return record as unknown as RemoteWorkInputRefV1;
}

function exact(value: unknown, keys: string[], label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError(`${label} must be an object`);
  }
  const record = value as RecordValue;
  if (Object.keys(record).some(key => !keys.includes(key))) throw protocolError(`${label} has unknown fields`);
  return record;
}

function timestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function protocolError(message: string): HitchError {
  return new HitchError(message, { code: "worker_protocol_invalid", exitCode: 2 });
}
