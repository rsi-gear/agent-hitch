import type { IncomingMessage, ServerResponse } from "node:http";
import { parseRemoteExecutionOwnership } from "../control-plane/index.js";
import type { RemoteWorkerProtocol, RemoteWorkerRegistry } from "../control-plane/index.js";
import { HitchError, invalidInput } from "../foundation/index.js";

/** Independent v2 endpoints; v1 offers and receipt formats are unchanged. */
export async function handleWorkerOwnershipRoute(input: {
  request: IncomingMessage; response: ServerResponse; url: URL; registry: RemoteWorkerRegistry; protocol: RemoteWorkerProtocol;
}): Promise<boolean> {
  const { request, response, url, registry, protocol } = input;
  const match = url.pathname.match(/^\/v2\/workers\/(worker_[a-z0-9][a-z0-9_-]{0,62})\/offers\/(offer_[a-f0-9]{32})\/(accept|process|cleanup-challenge|cleanup)$/);
  if (!match || request.method !== "POST") return false;
  const workerId = match[1]!, offerId = match[2]!, token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? "")?.[1];
  const authenticated = token ? await registry.authenticatedGeneration(workerId, token) : null;
  response.setHeader("cache-control", "no-store");
  if (authenticated === null) {
    response.setHeader("x-hitch-worker-auth", "rejected");
    json(response, 401, { error: { code: "unauthorized", message: "missing or invalid worker credential" } }); return true;
  }
  const body = await readBody(request);
  if (body.schema_version !== "2" || body.offer_id !== offerId || body.generation !== authenticated) {
    throw new HitchError("worker execution admission generation differs from its bearer", { code: "worker_generation_mismatch", exitCode: 12 });
  }
  if (match[3] === "accept") {
    exact(body, ["schema_version", "offer_id", "generation", "nonce", "sent_at", "ownership"]);
    const offer = await protocol.acceptOffer(workerId, { schema_version: "1", offer_id: offerId, generation: authenticated,
      nonce: body.nonce, sent_at: body.sent_at, accepted: true }, parseRemoteExecutionOwnership(body.ownership));
    json(response, 200, { schema_version: "2", offer, admission: await protocol.executionAdmission(workerId, offerId) });
  } else if (match[3] === "process") {
    exact(body, ["schema_version", "offer_id", "generation", "ownership_digest", "process"]);
    const admission = await protocol.authorizeExecutionProcess(workerId, offerId, authenticated, body.ownership_digest, body.process);
    json(response, 200, { schema_version: "2", admission });
  } else if (match[3] === "cleanup-challenge") {
    exact(body, ["schema_version", "offer_id", "generation"]);
    json(response, 200, { schema_version: "2", ...await protocol.generationCleanup.challenge(workerId, offerId, authenticated) });
  } else {
    exact(body, ["schema_version", "offer_id", "generation", "receipt"]);
    json(response, 200, { schema_version: "2", receipt: await protocol.generationCleanup.commit(workerId, offerId, authenticated, body.receipt) });
  }
  return true;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); size += bytes.length;
    if (size > 64 * 1024) throw invalidInput("worker execution admission body is too large"); chunks.push(bytes);
  }
  let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw invalidInput("invalid worker execution admission JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput("worker execution admission must be an object");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) throw invalidInput("unexpected worker execution admission fields");
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}
