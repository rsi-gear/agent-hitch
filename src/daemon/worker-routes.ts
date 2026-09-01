import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { parseRemoteWorkerHeartbeat } from "../control-plane/index.js";
import type { RemoteWorkerProtocol, RemoteWorkerRegistry } from "../control-plane/index.js";
import type { BackendWorkItemV1, ExecutionLeaseV1, RemoteWorkInputRefV1 } from "../domain/index.js";
import { invalidInput } from "../foundation/index.js";
import { authorized } from "./auth.js";

export async function handleWorkerProtocolRoute(input: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  registry: RemoteWorkerRegistry;
  protocol: RemoteWorkerProtocol;
  adminToken: string;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<boolean> {
  const { request, response, url, registry, protocol } = input;
  if (request.method === "POST" && url.pathname === "/v1/workers/register") {
    if (!authorized(request, input.adminToken)) unauthorized(response);
    else {
      const registered = await registry.register(await readBodyJSON(request));
      input.onEvent?.({ type: "worker.registered", worker_id: registered.worker.worker.worker_id, generation: registered.worker.generation });
      json(response, 201, {
        schema_version: "1",
        worker: registered.worker,
        credential: { type: "bearer", token: registered.token },
      });
    }
    return true;
  }
  const match = url.pathname.match(/^\/v1\/workers\/(worker_[a-z0-9][a-z0-9_-]{0,62})(?:\/(heartbeat))?$/);
  if (!match) return false;
  const workerId = match[1] as string;
  const action = match[2];
  if (request.method === "POST" && action === "heartbeat") {
    const workerToken = bearerToken(request);
    if (!workerToken || !await registry.authenticate(workerId, workerToken)) unauthorized(response);
    else {
      const heartbeat = parseRemoteWorkerHeartbeat(await readBodyJSON(request));
      await protocol.validateHeartbeatLeases(workerId, heartbeat);
      const worker = await registry.heartbeat(workerId, heartbeat);
      input.onEvent?.({ type: "worker.heartbeat", worker_id: workerId, generation: heartbeat.generation, health: heartbeat.health });
      for (const lease of heartbeat.active_leases) input.onEvent?.({ type: "lease.renewed", worker_id: workerId, lease_id: lease.lease_id, lease_epoch: lease.epoch });
      json(response, 200, { schema_version: "1", worker });
    }
    return true;
  }
  if (request.method === "DELETE" && !action) {
    if (!authorized(request, input.adminToken)) unauthorized(response);
    else json(response, 200, { schema_version: "1", worker: await registry.revoke(workerId) });
    return true;
  }
  if (request.method === "GET" && !action) {
    if (!authorized(request, input.adminToken)) unauthorized(response);
    else {
      const worker = await registry.get(workerId);
      if (worker) json(response, 200, { schema_version: "1", worker });
      else json(response, 404, { error: { code: "worker_not_found", message: `worker not found: ${workerId}` } });
    }
    return true;
  }
  return false;
}

export async function handleRemoteWorkRoute(input: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  registry: RemoteWorkerRegistry;
  protocol: RemoteWorkerProtocol;
  adminToken: string;
}): Promise<boolean> {
  const { request, response, url, registry, protocol } = input;
  const credentialMatch = url.pathname.match(/^\/v1\/workers\/(worker_[a-z0-9][a-z0-9_-]{0,62})\/leases\/(lease_[a-f0-9]{32})\/credentials$/);
  if (credentialMatch && request.method === "GET") {
    const workerId = credentialMatch[1] as string;
    if (!await workerAuthorized(request, registry, workerId)) unauthorized(response);
    else {
      const envelope = await protocol.issueCredentialEnvelope(
        workerId, credentialMatch[2] as string,
        positiveGeneration(url.searchParams.get("generation")), positiveGeneration(url.searchParams.get("epoch")),
      );
      response.setHeader("cache-control", "no-store");
      response.setHeader("pragma", "no-cache");
      json(response, 200, { schema_version: "1", envelope });
    }
    return true;
  }
  const inputMatch = url.pathname.match(/^\/v1\/workers\/(worker_[a-z0-9][a-z0-9_-]{0,62})\/leases\/(lease_[a-f0-9]{32})\/inputs\/(sha256:[a-f0-9]{64})$/);
  if (inputMatch && request.method === "GET") {
    const workerId = inputMatch[1] as string;
    if (!await workerAuthorized(request, registry, workerId)) unauthorized(response);
    else {
      const resolved = await protocol.resolveInput(workerId, inputMatch[2] as string, positiveGeneration(url.searchParams.get("generation")), inputMatch[3] as `sha256:${string}`);
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(resolved.size), "cache-control": "private, immutable" });
      await pipeline(createReadStream(resolved.path), response);
    }
    return true;
  }
  const artifactMatch = url.pathname.match(/^\/v1\/workers\/(worker_[a-z0-9][a-z0-9_-]{0,62})\/leases\/(lease_[a-f0-9]{32})\/artifacts\/(sha256:[a-f0-9]{64})$/);
  if (artifactMatch && request.method === "PUT") {
    const workerId = artifactMatch[1] as string;
    if (!await workerAuthorized(request, registry, workerId)) unauthorized(response);
    else {
      const generation = positiveGeneration(url.searchParams.get("generation"));
      const epoch = positiveGeneration(url.searchParams.get("epoch"));
      const expectedSize = contentLength(request);
      const artifact = await protocol.uploadArtifact({
        workerId, leaseId: artifactMatch[2] as string, digest: artifactMatch[3] as string,
        generation, epoch, expectedSize, body: request,
      });
      json(response, 201, { schema_version: "1", artifact });
    }
    return true;
  }
  const collection = url.pathname.match(/^\/v1\/workers\/(worker_[a-z0-9][a-z0-9_-]{0,62})\/offers$/);
  if (collection) {
    const workerId = collection[1] as string;
    if (request.method === "POST") {
      if (!authorized(request, input.adminToken)) unauthorized(response);
      else {
        const body = objectBody(await readBodyJSON(request));
        const offer = await protocol.createOffer(
          workerId, body.lease as ExecutionLeaseV1, body.work as BackendWorkItemV1,
          body.inputs as RemoteWorkInputRefV1[] | undefined, body.credential_names as string[] | undefined,
        );
        json(response, 201, { schema_version: "1", offer });
      }
      return true;
    }
    if (request.method === "GET") {
      if (!await workerAuthorized(request, registry, workerId)) unauthorized(response);
      else {
        const generation = positiveGeneration(url.searchParams.get("generation"));
        json(response, 200, { schema_version: "1", offers: await protocol.listOffers(workerId, generation) });
      }
      return true;
    }
  }
  const offerMatch = url.pathname.match(/^\/v1\/workers\/(worker_[a-z0-9][a-z0-9_-]{0,62})\/offers\/(offer_[a-f0-9]{32})\/(accept|complete|release|release-request|cancel)$/);
  if (offerMatch) {
    const [, workerId, offerId, action] = offerMatch as unknown as [string, string, string, string];
    if (request.method !== "POST") return false;
    if (action === "cancel" || action === "release-request") {
      if (!authorized(request, input.adminToken)) unauthorized(response);
      else json(response, 200, { schema_version: "1", offer: action === "cancel"
        ? await protocol.requestCancel(workerId, offerId)
        : await protocol.requestRelease(workerId, offerId) });
      return true;
    }
    if (!await workerAuthorized(request, registry, workerId)) unauthorized(response);
    else {
      const body = { ...objectBody(await readBodyJSON(request)), offer_id: offerId };
      const offer = action === "accept"
        ? await protocol.acceptOffer(workerId, body)
        : action === "complete"
          ? await protocol.completeOffer(workerId, body)
          : await protocol.releaseOffer(workerId, body);
      json(response, 200, { schema_version: "1", offer });
    }
    return true;
  }
  const eventMatch = url.pathname.match(/^\/v1\/workers\/(worker_[a-z0-9][a-z0-9_-]{0,62})\/leases\/(lease_[a-f0-9]{32})\/events$/);
  if (eventMatch && request.method === "POST") {
    const workerId = eventMatch[1] as string;
    if (!await workerAuthorized(request, registry, workerId)) unauthorized(response);
    else {
      const event = await protocol.recordEvent(workerId, { ...objectBody(await readBodyJSON(request)), lease_id: eventMatch[2] });
      json(response, event.duplicate ? 200 : 201, { schema_version: "1", ...event });
    }
    return true;
  }
  return false;
}

function bearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : null;
}

async function workerAuthorized(request: IncomingMessage, registry: RemoteWorkerRegistry, workerId: string): Promise<boolean> {
  const token = bearerToken(request);
  return token !== null && registry.authenticate(workerId, token);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput("worker protocol body must be an object");
  return value as Record<string, unknown>;
}

function positiveGeneration(value: string | null): number {
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalidInput("worker generation is required");
  return Number(value);
}

function contentLength(request: IncomingMessage): number {
  const value = request.headers["content-length"];
  if (Array.isArray(value) || typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw invalidInput("worker artifact content-length is required");
  }
  return Number(value);
}

async function readBodyJSON(request: IncomingMessage, limit = 1_048_576): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw invalidInput("request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown; }
  catch { throw invalidInput("invalid JSON request body"); }
}

function unauthorized(response: ServerResponse): void {
  json(response, 401, { error: { code: "unauthorized", message: "missing or invalid worker credential" } });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}
