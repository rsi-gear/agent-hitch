import type { IncomingMessage, ServerResponse } from "node:http";
import type { RemoteWorkerRegistry } from "../control-plane/index.js";
import { invalidInput } from "../foundation/index.js";
import { authorized } from "./auth.js";

export async function handleWorkerProtocolRoute(input: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  registry: RemoteWorkerRegistry;
  adminToken: string;
}): Promise<boolean> {
  const { request, response, url, registry } = input;
  if (request.method === "POST" && url.pathname === "/v1/workers/register") {
    if (!authorized(request, input.adminToken)) unauthorized(response);
    else {
      const registered = await registry.register(await readBodyJSON(request));
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
    else json(response, 200, { schema_version: "1", worker: await registry.heartbeat(workerId, await readBodyJSON(request)) });
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

function bearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : null;
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
