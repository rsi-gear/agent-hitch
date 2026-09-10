import { createHash } from "node:crypto";
import type {
  RemoteWorkArtifactRefV1,
  RemoteCredentialEnvelopeV1,
  RemoteWorkInputRefV1,
  RemoteWorkOfferV1,
  RemoteWorkerHeartbeatV1,
  RemoteWorkerRegistrationV1,
  ResourceVectorV1,
  Sha256,
  RemoteExecutionObservationChallengeV2,
  RemoteExecutionObservationReceiptV2,
  RemoteWorkerExecutionOwnership,
  RemoteWorkerProcessIdentityV2,
  RemoteWorkerCleanupChallengeV2,
  RemoteWorkerCleanupReceipt,
} from "../domain/index.js";
import { HitchError, safeDiagnosticMessage, sha256JSON } from "../foundation/index.js";
import { parseExecutionLease, parseRemoteWorkerCleanupChallenge, parseRemoteWorkerCleanupReceipt } from "../evals/index.js";
import { parseRemoteWorkOffer } from "./remote-worker-protocol.js";
import { parseExecutionObservationChallenge, parseExecutionObservationReceipt } from "./execution-observation-contract.js";
import { parseRemoteExecutionAdmission, parseRemoteExecutionOwnership, remoteExecutionBindingDigest } from "./remote-worker-ownership.js";

const TOKEN = /^[a-f0-9]{64}$/;
const WORKER = /^worker_[a-z0-9][a-z0-9_-]{0,62}$/;
const MAX_ERROR_BYTES = 8_192;
const MAX_CREDENTIAL_ENVELOPE_BYTES = 1024 * 1024;

export interface RemoteWorkerCredentialV1 {
  schema_version: "1";
  worker_id: string;
  generation: number;
  token: string;
}

export class RemoteWorkerHttpClient {
  readonly workerId: string;
  readonly generation: number;
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly request: typeof fetch;
  private readonly fence = new AbortController();

  /** A definitive credential rejection fences every request from this generation. */
  get fencedSignal(): AbortSignal { return this.fence.signal; }

  constructor(input: { baseUrl: string; credential: RemoteWorkerCredentialV1; request?: typeof fetch }) {
    this.baseUrl = parseBaseUrl(input.baseUrl);
    const credential = parseRemoteWorkerCredential(input.credential);
    this.workerId = credential.worker_id;
    this.generation = credential.generation;
    this.token = credential.token;
    this.request = input.request ?? fetch;
  }

  static async register(input: {
    baseUrl: string;
    adminToken: string;
    registration: RemoteWorkerRegistrationV1;
    request?: typeof fetch;
  }): Promise<RemoteWorkerCredentialV1> {
    if (!TOKEN.test(input.adminToken)) throw clientError("remote worker admin credential is invalid");
    const response = await call(input.request ?? fetch, new URL("v1/workers/register", parseBaseUrl(input.baseUrl)), input.adminToken, {
      method: "POST", body: JSON.stringify(input.registration), headers: { "content-type": "application/json" },
    });
    const body = object(await responseJSON(response));
    const worker = object(body.worker);
    const identity = object(worker.worker);
    const credential = object(body.credential);
    return parseRemoteWorkerCredential({
      schema_version: "1", worker_id: identity.worker_id,
      generation: worker.generation, token: credential.token,
    });
  }

  async listOffers(): Promise<RemoteWorkOfferV1[]> {
    const response = await this.call(`v1/workers/${this.workerId}/offers?generation=${this.generation}`);
    const body = object(await responseJSON(response));
    if (body.schema_version !== "1" || !Array.isArray(body.offers)) throw clientError("remote worker offer response is invalid");
    return body.offers.map(parseRemoteWorkOffer);
  }

  async pollExecutionObservation(signal: AbortSignal): Promise<RemoteExecutionObservationChallengeV2 | null> {
    const response = await this.call(`v2/workers/${this.workerId}/execution-observation?generation=${this.generation}`, { signal });
    const body = object(await responseJSON(response));
    if (body.schema_version !== "2" || response.headers.get("cache-control") !== "no-store") throw clientError("invalid or cacheable worker observation challenge");
    if (body.challenge === null) return null;
    const challenge = parseExecutionObservationChallenge(body.challenge);
    if (challenge.worker_id !== this.workerId || challenge.generation !== this.generation) throw clientError("observation challenge does not belong to this worker generation");
    return challenge;
  }

  async submitExecutionObservation(value: RemoteExecutionObservationReceiptV2, signal: AbortSignal): Promise<void> {
    const receipt = parseExecutionObservationReceipt(value);
    if (receipt.challenge.worker_id !== this.workerId || receipt.challenge.generation !== this.generation) throw clientError("observation receipt does not belong to this worker generation");
    await this.call(`v2/workers/${this.workerId}/execution-observation`, { method: "POST", signal,
      body: JSON.stringify(receipt), headers: { "content-type": "application/json" } });
  }

  async heartbeat(allocated: ResourceVectorV1, activeLeases: Array<{ lease_id: string; epoch: number }>, health: RemoteWorkerHeartbeatV1["health"] = "healthy"): Promise<void> {
    await this.call(`v1/workers/${this.workerId}/heartbeat`, {
      method: "POST", body: JSON.stringify({
        schema_version: "1", generation: this.generation, health, allocated,
        active_leases: [...activeLeases].sort((left, right) => left.lease_id.localeCompare(right.lease_id)), sent_at: new Date().toISOString(),
      }), headers: { "content-type": "application/json" },
    });
  }

  async downloadInput(offer: RemoteWorkOfferV1, ref: RemoteWorkInputRefV1): Promise<Buffer> {
    this.assertOffer(offer);
    const response = await this.call(`v1/workers/${this.workerId}/leases/${offer.lease.lease_id}/inputs/${ref.digest}?generation=${this.generation}`);
    const length = response.headers.get("content-length");
    if (length !== String(ref.size)) throw clientError("remote work input size header is invalid");
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length !== ref.size || digest(body) !== ref.digest) throw clientError("remote work input integrity check failed");
    return body;
  }

  async accept(offer: RemoteWorkOfferV1, ownership?: RemoteWorkerExecutionOwnership, sentAt = new Date().toISOString()): Promise<RemoteWorkOfferV1> {
    if (!ownership) return this.receipt(offer, "accept", { accepted: true }, sentAt);
    this.assertOffer(offer);
    parseRemoteExecutionOwnership(ownership, offer);
    const response = await this.call(`v2/workers/${this.workerId}/offers/${offer.offer_id}/accept`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema_version: "2", offer_id: offer.offer_id, generation: this.generation, nonce: offer.nonce, sent_at: sentAt, ownership }),
    });
    const body = object(await responseJSON(response)), accepted = parseRemoteWorkOffer(body.offer);
    if (body.schema_version !== "2" || response.headers.get("cache-control") !== "no-store"
      || remoteExecutionBindingDigest(accepted) !== remoteExecutionBindingDigest(offer)) throw clientError("worker execution admission response differs from its offer");
    if (accepted.accepted_at) {
      const admission = parseRemoteExecutionAdmission(body.admission, accepted);
      if (admission.ownership_digest !== sha256JSON(ownership)) throw clientError("worker execution admission changed its ownership");
    } else if (accepted.state !== "expired" || body.admission !== null) throw clientError("worker execution admission was not acknowledged");
    return accepted;
  }

  async authorizeProcess(offer: RemoteWorkOfferV1, ownership: RemoteWorkerExecutionOwnership, identity: RemoteWorkerProcessIdentityV2): Promise<void> {
    this.assertOffer(offer);
    const response = await this.call(`v2/workers/${this.workerId}/offers/${offer.offer_id}/process`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema_version: "2", offer_id: offer.offer_id, generation: this.generation, ownership_digest: sha256JSON(ownership), process: identity }),
    });
    const body = object(await responseJSON(response)), admission = parseRemoteExecutionAdmission(body.admission, offer);
    if (body.schema_version !== "2" || response.headers.get("cache-control") !== "no-store"
      || admission.ownership_digest !== sha256JSON(ownership) || sha256JSON(admission.execution_process) !== sha256JSON(identity)) {
      throw clientError("worker execution process authorization differs from its launch identity");
    }
  }

  async cleanupChallenge(offer: RemoteWorkOfferV1): Promise<{ challenge: RemoteWorkerCleanupChallengeV2 | null; receipt: RemoteWorkerCleanupReceipt | null }> {
    this.assertPreviousOffer(offer);
    const response = await this.call(`v2/workers/${this.workerId}/offers/${offer.offer_id}/cleanup-challenge`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema_version: "2", offer_id: offer.offer_id, generation: this.generation }),
    });
    const body = object(await responseJSON(response));
    if (body.schema_version !== "2" || response.headers.get("cache-control") !== "no-store") throw clientError("invalid or cacheable cleanup challenge");
    if (body.receipt !== null) {
      const receipt = parseRemoteWorkerCleanupReceipt(body.receipt, offer);
      if (body.challenge !== null || receipt.challenge.generation > this.generation) throw clientError("cleanup receipt belongs to a future generation");
      return { challenge: null, receipt };
    }
    const challenge = parseRemoteWorkerCleanupChallenge(body.challenge, offer);
    if (challenge.generation !== this.generation || Date.parse(challenge.expires_at) <= Date.now()) throw clientError("cleanup challenge is stale");
    return { challenge, receipt: null };
  }

  async commitCleanup(offer: RemoteWorkOfferV1, receipt: RemoteWorkerCleanupReceipt): Promise<void> {
    this.assertPreviousOffer(offer); parseRemoteWorkerCleanupReceipt(receipt, offer);
    if (receipt.challenge.generation !== this.generation) throw clientError("cleanup receipt belongs to another generation");
    const response = await this.call(`v2/workers/${this.workerId}/offers/${offer.offer_id}/cleanup`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema_version: "2", offer_id: offer.offer_id, generation: this.generation, receipt }),
    });
    const body = object(await responseJSON(response));
    if (body.schema_version !== "2" || response.headers.get("cache-control") !== "no-store"
      || sha256JSON(parseRemoteWorkerCleanupReceipt(body.receipt, offer)) !== sha256JSON(receipt)) throw clientError("cleanup acknowledgement differs from its observation");
  }

  /** Called only by the worker-owned relay; worker credentials never enter a task environment. */
  relayModel(offer: RemoteWorkOfferV1, runId: string, operation: "bind" | "generate", body: unknown, signal: AbortSignal): Promise<Response> {
    this.assertOffer(offer);
    if (!/^run_[a-f0-9]{32}$/.test(runId)) throw clientError("remote model run identity is invalid");
    return this.call(`v1/workers/${this.workerId}/leases/${offer.lease.lease_id}/model`, {
      method: "POST", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({ schema_version: "2", generation: this.generation, epoch: offer.lease.epoch, run_id: runId, operation, body }),
    });
  }

  async credentials(offer: RemoteWorkOfferV1): Promise<RemoteCredentialEnvelopeV1> {
    this.assertOffer(offer);
    if (offer.state !== "accepted") throw clientError("remote credentials require an accepted offer");
    const response = await this.call(
      `v1/workers/${this.workerId}/leases/${offer.lease.lease_id}/credentials?generation=${this.generation}&epoch=${offer.lease.epoch}`,
    );
    if (response.headers.get("cache-control") !== "no-store") throw clientError("remote credential response is cacheable");
    return parseCredentialEnvelope(object(object(await responseJSON(response, MAX_CREDENTIAL_ENVELOPE_BYTES)).envelope), offer);
  }
  reject(offer: RemoteWorkOfferV1, rejectionCode: string): Promise<RemoteWorkOfferV1> {
    if (!rejectionCode || rejectionCode.length > 128 || !/^[a-z0-9][a-z0-9._-]*$/.test(rejectionCode)) throw clientError("remote work rejection code is invalid");
    return this.receipt(offer, "accept", { accepted: false, rejection_code: rejectionCode });
  }

  async emit(offer: RemoteWorkOfferV1, sequence: number, type: string, payload?: Record<string, unknown>, sentAt = new Date().toISOString()): Promise<void> {
    this.assertOffer(offer);
    await this.call(`v1/workers/${this.workerId}/leases/${offer.lease.lease_id}/events`, {
      method: "POST", body: JSON.stringify({
        schema_version: "1", generation: this.generation, lease_id: offer.lease.lease_id,
        epoch: offer.lease.epoch, sequence, type, ...(payload ? { payload } : {}), sent_at: sentAt,
      }), headers: { "content-type": "application/json" },
    });
  }

  async uploadArtifact(offer: RemoteWorkOfferV1, kind: RemoteWorkArtifactRefV1["kind"], body: Buffer): Promise<RemoteWorkArtifactRefV1> {
    this.assertOffer(offer);
    const ref: RemoteWorkArtifactRefV1 = { kind, digest: digest(body), size: body.length };
    await this.call(`v1/workers/${this.workerId}/leases/${offer.lease.lease_id}/artifacts/${ref.digest}?generation=${this.generation}&epoch=${offer.lease.epoch}`, {
      method: "PUT", body, headers: { "content-type": "application/octet-stream", "content-length": String(body.length) },
    });
    return ref;
  }

  complete(offer: RemoteWorkOfferV1, status: "succeeded" | "failed" | "cancelled", artifacts: RemoteWorkArtifactRefV1[], sentAt = new Date().toISOString()): Promise<RemoteWorkOfferV1> {
    return this.receipt(offer, "complete", { lease_id: offer.lease.lease_id, epoch: offer.lease.epoch, status, artifacts }, sentAt);
  }

  release(offer: RemoteWorkOfferV1, sentAt = new Date().toISOString()): Promise<RemoteWorkOfferV1> {
    return this.receipt(offer, "release", { lease_id: offer.lease.lease_id, epoch: offer.lease.epoch }, sentAt);
  }

  private async receipt(offer: RemoteWorkOfferV1, action: "accept" | "complete" | "release", fields: Record<string, unknown>, sentAt = new Date().toISOString()): Promise<RemoteWorkOfferV1> {
    this.assertOffer(offer);
    const response = await this.call(`v1/workers/${this.workerId}/offers/${offer.offer_id}/${action}`, {
      method: "POST", body: JSON.stringify({
        schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce, generation: this.generation,
        ...fields, sent_at: sentAt,
      }), headers: { "content-type": "application/json" },
    });
    return parseRemoteWorkOffer(object(await responseJSON(response)).offer);
  }

  async executionLease(offer: RemoteWorkOfferV1, signal: AbortSignal) {
    this.assertOffer(offer);
    const response = await this.call(`v1/workers/${this.workerId}/leases/${offer.lease.lease_id}/execution?generation=${this.generation}&epoch=${offer.lease.epoch}`, { signal });
    const value = object(await responseJSON(response)), lease = parseExecutionLease(value.lease);
    const fields = ["lease_id", "eval_id", "work_id", "worker_id", "provider", "collision_domain_id", "epoch", "reservation"] as const;
    if (Object.keys(value).sort().join(",") !== "generation,lease,offer_id,schema_version" || value.schema_version !== "2"
      || value.offer_id !== offer.offer_id || value.generation !== this.generation || !["offered", "accepted", "running"].includes(lease.state)
      || Date.parse(lease.expires_at) <= Date.now() || fields.some(field => sha256JSON(lease[field]) !== sha256JSON(offer.lease[field]))
      || sha256JSON(lease.resource_epochs ?? [lease.epoch]) !== sha256JSON(offer.lease.resource_epochs ?? [offer.lease.epoch])) throw clientError("remote execution lease grant differs from its accepted offer");
    return lease;
  }

  private async call(relative: string, init: RequestInit = {}): Promise<Response> {
    this.fence.signal.throwIfAborted();
    const signal = init.signal ? AbortSignal.any([init.signal, this.fence.signal]) : this.fence.signal;
    try { return await call(this.request, new URL(relative, this.baseUrl), this.token, { ...init, signal }, !relative.endsWith("/model")); }
    catch (error) {
      if (error instanceof HitchError && error.code === "remote_worker_fenced") this.fence.abort(error);
      throw error;
    }
  }

  private assertOffer(offer: RemoteWorkOfferV1): void {
    if (offer.worker_id !== this.workerId || offer.generation !== this.generation) throw clientError("remote work offer does not belong to this worker generation");
  }
  private assertPreviousOffer(offer: RemoteWorkOfferV1): void {
    if (offer.worker_id !== this.workerId || offer.generation >= this.generation) throw clientError("cleanup requires an older generation of the same worker");
  }
}

export function parseRemoteWorkerCredential(value: unknown): RemoteWorkerCredentialV1 {
  const record = object(value);
  if (Object.keys(record).some((key) => !["schema_version", "worker_id", "generation", "token"].includes(key))
    || record.schema_version !== "1" || typeof record.worker_id !== "string" || !WORKER.test(record.worker_id)
    || !Number.isSafeInteger(record.generation) || (record.generation as number) < 1
    || typeof record.token !== "string" || !TOKEN.test(record.token)) throw clientError("remote worker credential is invalid");
  return record as unknown as RemoteWorkerCredentialV1;
}

async function call(request: typeof fetch, url: URL, token: string, init: RequestInit = {}, controlResponse = true): Promise<Response> {
  let response: Response;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  try { response = await request(url, { ...init, headers }); }
  catch (error) { throw clientError(`remote worker request failed: ${safeDiagnosticMessage(error, [token], 512)}`); }
  if (response.ok) return response;
  // Model responses can carry upstream 401/403/409 errors. Only the daemon's
  // own authentication rejection (whose header is never proxied) fences them.
  const authenticationResponse = controlResponse || response.headers.get("x-hitch-worker-auth") === "rejected";
  if (response.status === 401 && authenticationResponse) {
    // The status itself rejects this bearer; do not wait for a possibly stalled
    // error body while its candidate continues executing.
    void response.body?.cancel().catch(() => undefined);
    throw new HitchError("remote worker credential was rejected (HTTP 401)", { code: "remote_worker_fenced", exitCode: 11 });
  }
  const body = (await response.text()).slice(0, MAX_ERROR_BYTES);
  let message = `HTTP ${response.status}`;
  let fenced = false;
  try {
    const error = object(object(JSON.parse(body) as unknown).error);
    fenced ||= authenticationResponse && (response.status === 403 || response.status === 409)
      && (error.code === "worker_generation_mismatch" || error.code === "worker_revoked");
    if (typeof error.code === "string") message += ` ${error.code}`;
    if (typeof error.message === "string") message += `: ${error.message}`;
  } catch { /* Keep the bounded status-only error. */ }
  const diagnostic = `remote worker request failed: ${safeDiagnosticMessage(message, [token], 512)}`;
  if (fenced) throw new HitchError(diagnostic, { code: "remote_worker_fenced", exitCode: 11 });
  throw clientError(diagnostic);
}

async function responseJSON(response: Response, maximum = MAX_ERROR_BYTES): Promise<unknown> {
  const raw = await response.text();
  if (Buffer.byteLength(raw) > maximum) throw clientError("remote worker response exceeds its size limit");
  const text = raw.slice(0, maximum);
  try { return JSON.parse(text) as unknown; }
  catch { throw clientError("remote worker response is not valid JSON"); }
}

function parseCredentialEnvelope(record: Record<string, unknown>, offer: RemoteWorkOfferV1): RemoteCredentialEnvelopeV1 {
  const allowed = new Set(["schema_version", "worker_id", "generation", "offer_id", "lease_id", "epoch", "issued_at", "expires_at", "credentials"]);
  const credentials = object(record.credentials);
  const names = Object.keys(credentials).sort();
  const expected = [...(offer.credential_names ?? [])].sort();
  if (Object.keys(record).some((key) => !allowed.has(key)) || record.schema_version !== "1"
    || record.worker_id !== offer.worker_id || record.generation !== offer.generation || record.offer_id !== offer.offer_id
    || record.lease_id !== offer.lease.lease_id || record.epoch !== offer.lease.epoch
    || typeof record.issued_at !== "string" || typeof record.expires_at !== "string"
    || !Number.isFinite(Date.parse(record.issued_at)) || !Number.isFinite(Date.parse(record.expires_at))
    || Date.parse(record.expires_at) <= Date.now() || Date.parse(record.expires_at) - Date.parse(record.issued_at) > 5 * 60_000
    || JSON.stringify(names) !== JSON.stringify(expected)
    || names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || typeof credentials[name] !== "string" || Buffer.byteLength(credentials[name] as string) > 64 * 1024)) {
    throw clientError("remote credential envelope is invalid");
  }
  return record as unknown as RemoteCredentialEnvelopeV1;
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw clientError("remote worker server URL is invalid"); }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash) throw clientError("remote worker server URL is invalid");
  url.pathname = `${url.pathname.replace(/\/*$/, "")}/`;
  return url;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw clientError("remote worker response is invalid");
  return value as Record<string, unknown>;
}

function digest(body: Buffer): Sha256 { return `sha256:${createHash("sha256").update(body).digest("hex")}`; }
function clientError(message: string): HitchError { return new HitchError(message, { code: "remote_worker_client_error", exitCode: 10 }); }
