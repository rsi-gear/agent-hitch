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
} from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import { parseRemoteWorkOffer } from "./remote-worker-protocol.js";

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

  accept(offer: RemoteWorkOfferV1): Promise<RemoteWorkOfferV1> { return this.receipt(offer, "accept", { accepted: true }); }

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

  async emit(offer: RemoteWorkOfferV1, sequence: number, type: string, payload?: Record<string, unknown>): Promise<void> {
    this.assertOffer(offer);
    await this.call(`v1/workers/${this.workerId}/leases/${offer.lease.lease_id}/events`, {
      method: "POST", body: JSON.stringify({
        schema_version: "1", generation: this.generation, lease_id: offer.lease.lease_id,
        epoch: offer.lease.epoch, sequence, type, ...(payload ? { payload } : {}), sent_at: new Date().toISOString(),
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

  complete(offer: RemoteWorkOfferV1, status: "succeeded" | "failed" | "cancelled", artifacts: RemoteWorkArtifactRefV1[]): Promise<RemoteWorkOfferV1> {
    return this.receipt(offer, "complete", { lease_id: offer.lease.lease_id, epoch: offer.lease.epoch, status, artifacts });
  }

  release(offer: RemoteWorkOfferV1): Promise<RemoteWorkOfferV1> {
    return this.receipt(offer, "release", { lease_id: offer.lease.lease_id, epoch: offer.lease.epoch });
  }

  private async receipt(offer: RemoteWorkOfferV1, action: "accept" | "complete" | "release", fields: Record<string, unknown>): Promise<RemoteWorkOfferV1> {
    this.assertOffer(offer);
    const response = await this.call(`v1/workers/${this.workerId}/offers/${offer.offer_id}/${action}`, {
      method: "POST", body: JSON.stringify({
        schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce, generation: this.generation,
        ...fields, sent_at: new Date().toISOString(),
      }), headers: { "content-type": "application/json" },
    });
    return parseRemoteWorkOffer(object(await responseJSON(response)).offer);
  }

  private call(relative: string, init: RequestInit = {}): Promise<Response> {
    return call(this.request, new URL(relative, this.baseUrl), this.token, init);
  }

  private assertOffer(offer: RemoteWorkOfferV1): void {
    if (offer.worker_id !== this.workerId || offer.generation !== this.generation) throw clientError("remote work offer does not belong to this worker generation");
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

async function call(request: typeof fetch, url: URL, token: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  try { response = await request(url, { ...init, headers }); }
  catch (error) { throw clientError(`remote worker request failed: ${safeMessage(error)}`); }
  if (response.ok) return response;
  const body = (await response.text()).slice(0, MAX_ERROR_BYTES);
  let message = `HTTP ${response.status}`;
  try {
    const error = object(object(JSON.parse(body) as unknown).error);
    if (typeof error.code === "string") message += ` ${error.code}`;
    if (typeof error.message === "string") message += `: ${error.message}`;
  } catch { /* Keep the bounded status-only error. */ }
  throw clientError(`remote worker request failed: ${message}`);
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
function safeMessage(error: unknown): string { return ((error as Error)?.message || String(error)).slice(0, 512); }
function clientError(message: string): HitchError { return new HitchError(message, { code: "remote_worker_client_error", exitCode: 10 }); }
