import { randomBytes } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { InferenceLockV1, ModelEndpointBindingV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";

const RUN_ID = /^run_[a-f0-9]{32}$/;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const RESPONSE_FIELDS = new Set([
  "background", "include", "input", "instructions", "max_output_tokens", "max_tool_calls", "metadata", "model",
  "parallel_tool_calls", "previous_response_id", "reasoning", "service_tier", "store", "stream", "temperature",
  "tool_choice", "tools", "top_logprobs", "top_p", "truncation", "user", "request_id", "session_id", "priority",
  "extra_key", "cache_salt", "frequency_penalty", "presence_penalty", "stop", "top_k", "min_p",
  "repetition_penalty", "prompt_cache_key", "client_metadata",
]);
const LOCAL_TOOL_TYPES = new Set(["function", "namespace", "tool_search", "custom"]);

export interface LocalModelGatewayOptions {
  upstreamBaseUrl: string;
  engineToken: string;
  wireModel: string;
  lock: InferenceLockV1;
  bindHost?: string;
  listenPort?: number;
  fetch?: typeof fetch;
  onRequest?: (event: Record<string, unknown>) => void;
}

export interface LocalModelGatewayRegistration {
  binding: ModelEndpointBindingV1;
  credential: string;
  revoke(): void;
}

interface Registration {
  token: string;
  revoked: boolean;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

export class LocalModelGateway {
  private readonly server: Server;
  private readonly upstream: URL;
  private readonly engineToken: string;
  private readonly wireModel: string;
  private readonly lock: InferenceLockV1;
  private readonly request: typeof fetch;
  private readonly onRequest: ((event: Record<string, unknown>) => void) | undefined;
  private readonly host: string;
  private readonly port: number;
  private readonly registrations = new Map<string, Registration>();
  private readonly queue: Waiter[] = [];
  private readonly controllers = new Set<AbortController>();
  private active = 0;
  private closed = false;

  private constructor(options: LocalModelGatewayOptions, server: Server, host: string, port: number) {
    this.server = server;
    this.upstream = upstreamUrl(options.upstreamBaseUrl);
    this.engineToken = options.engineToken;
    this.wireModel = options.wireModel;
    this.lock = options.lock;
    this.request = options.fetch ?? fetch;
    this.onRequest = options.onRequest;
    this.host = host;
    this.port = port;
  }

  static async start(options: LocalModelGatewayOptions): Promise<LocalModelGateway> {
    const host = options.bindHost ?? "127.0.0.1";
    if (isIP(host) === 0 || host === "0.0.0.0" || host === "::") throw new TypeError("local model gateway must bind a specific IP address");
    if (options.listenPort !== undefined && (!Number.isSafeInteger(options.listenPort) || options.listenPort < 1 || options.listenPort > 65_535)) {
      throw new TypeError("local model gateway port is invalid");
    }
    let gateway: LocalModelGateway | undefined;
    const server = http.createServer((request, response) => {
      gateway?.handle(request, response).catch((error) => respondError(response, error));
    });
    const port = await listen(server, host, options.listenPort ?? 0);
    gateway = new LocalModelGateway(options, server, host, port);
    return gateway;
  }

  register(runId: string): LocalModelGatewayRegistration {
    if (!RUN_ID.test(runId)) throw new TypeError("local model gateway run ID is invalid");
    if (this.closed) throw new HitchError("local model gateway is closed", { code: "inference_route_unavailable", exitCode: 12 });
    if (this.registrations.has(runId)) throw new TypeError(`local model gateway run is already registered: ${runId}`);
    const registration: Registration = { token: randomBytes(32).toString("hex"), revoked: false };
    this.registrations.set(runId, registration);
    const baseUrl = `http://${hostForUrl(this.host)}:${this.port}/runs/${runId}/v1/`;
    return {
      binding: {
        kind: "managed-local",
        inference_id: this.lock.inference_id,
        api: this.lock.protocol.api,
        base_url: baseUrl,
        wire_model: this.wireModel,
        credential_env_name: "HITCH_LOCAL_MODEL_TOKEN",
        capabilities: {
          streaming: this.lock.protocol.streaming,
          tool_calls: this.lock.protocol.tool_calls,
          parallel_tool_calls: this.lock.protocol.parallel_tool_calls,
          input_modalities: ["text"],
        },
      },
      credential: registration.token,
      revoke: () => {
        registration.revoked = true;
        if (this.registrations.get(runId) === registration) this.registrations.delete(runId);
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.registrations.clear();
    for (const controller of this.controllers) controller.abort();
    for (const waiter of this.queue.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener("abort", waiter.abort as () => void);
      waiter.reject(new HitchError("local model gateway closed", { code: "inference_route_unavailable", exitCode: 12 }));
    }
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const route = parseRoute(request.url);
    if (!route) return respondJSON(response, 404, { error: { code: "inference_route_unavailable" } });
    const registration = this.registrations.get(route.runId);
    if (!registration || registration.revoked || bearer(request) !== registration.token) {
      return respondJSON(response, 401, { error: { code: "inference_binding_revoked" } });
    }
    if (request.method === "GET" && route.endpoint === "models") {
      return respondJSON(response, 200, {
        object: "list", data: [{ id: this.wireModel, object: "model", created: 0, owned_by: "hitch-local" }],
      });
    }
    if (request.method !== "POST" || route.endpoint === "models" || route.endpoint !== this.lock.protocol.api) {
      return respondJSON(response, 404, { error: { code: "inference_protocol_unsupported" } });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const responseClosed = () => { if (!response.writableEnded) controller.abort(); };
    request.once("aborted", abort);
    response.once("close", responseClosed);
    this.controllers.add(controller);
    const started = Date.now();
    let release: (() => void) | undefined;
    try {
      release = await this.acquirePermit(controller.signal);
      const body = validateRequestBody(await readBody(request), this.lock, this.wireModel);
      const upstream = new URL(route.endpoint === "responses" ? "/v1/responses" : "/v1/chat/completions", this.upstream);
      const upstreamResponse = await this.request(upstream, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.engineToken}`,
          "content-type": "application/json",
          accept: typeof request.headers.accept === "string" ? request.headers.accept : "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(this.lock.execution.request_timeout_ms)]),
      });
      response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse.headers));
      if (upstreamResponse.body) await pipeline(Readable.fromWeb(upstreamResponse.body as never), response);
      else response.end();
      this.onRequest?.({
        type: "inference.request.completed", run_id: route.runId, inference_id: this.lock.inference_id,
        status: upstreamResponse.ok ? "succeeded" : "failed", http_status: upstreamResponse.status, duration_ms: Date.now() - started,
      });
    } catch (error) {
      this.onRequest?.({
        type: "inference.request.failed", run_id: route.runId, inference_id: this.lock.inference_id,
        code: (error as { code?: string }).code || "inference_route_unavailable", duration_ms: Date.now() - started,
      });
      throw error;
    } finally {
      request.removeListener("aborted", abort);
      response.removeListener("close", responseClosed);
      this.controllers.delete(controller);
      release?.();
    }
  }

  private acquirePermit(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new HitchError("local inference request cancelled", { code: "cancelled", exitCode: 9 });
    if (this.active < this.lock.execution.max_running_requests) {
      this.active += 1;
      return Promise.resolve(this.releasePermit());
    }
    if (this.queue.length >= this.lock.execution.max_queued_requests) {
      throw new HitchError("local inference queue capacity exceeded", { code: "inference_capacity_exceeded", exitCode: 12 });
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new HitchError("local inference queue timed out", { code: "inference_queue_timeout", exitCode: 12 }));
        }, this.lock.execution.queue_timeout_ms),
      };
      waiter.timer.unref?.();
      waiter.abort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        clearTimeout(waiter.timer);
        reject(new HitchError("local inference request cancelled", { code: "cancelled", exitCode: 9 }));
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
    });
  }

  private releasePermit(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.queue.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener("abort", waiter.abort as () => void);
        waiter.resolve(this.releasePermit());
      } else this.active = Math.max(0, this.active - 1);
    };
  }
}

function validateRequestBody(buffer: Buffer, lock: InferenceLockV1, wireModel: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(buffer.toString("utf8")); } catch { throw requestError("model request must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw requestError("model request must be an object");
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).find((field) => !RESPONSE_FIELDS.has(field));
  if (unknown) throw requestError(`unsupported local inference request field: ${unknown}`);
  if (body.model !== wireModel) throw requestError("model request does not match the bound local model");
  if (containsUnsupportedMedia(body)) throw new HitchError("local inference P0 accepts text input only", { code: "inference_modality_unsupported", exitCode: 2 });
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw requestError("tools must be an array");
  const tools = (body.tools ?? []) as unknown[];
  if (!lock.protocol.tool_calls && tools.length > 0) throw requestError("tools are unavailable for this local inference profile");
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)
      || !LOCAL_TOOL_TYPES.has(String((tool as Record<string, unknown>).type))) {
      throw requestError("local inference accepts only Harness-executed function tools");
    }
  }
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== lock.protocol.parallel_tool_calls) {
    throw requestError("parallel_tool_calls conflicts with the inference lock");
  }
  body.parallel_tool_calls = lock.protocol.parallel_tool_calls;
  if (body.store !== undefined && body.store !== false) throw requestError("local inference requires store=false");
  if (body.truncation !== undefined && body.truncation !== "disabled") throw requestError("local inference does not allow automatic truncation");
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) throw requestError("local inference requires complete request history");
  if (body.background === true) throw requestError("background responses are unavailable for local inference");
  if (body.reasoning !== undefined && body.reasoning !== null) {
    if (!body.reasoning || typeof body.reasoning !== "object" || Array.isArray(body.reasoning)) throw requestError("reasoning must be an object");
    const reasoning = body.reasoning as Record<string, unknown>;
    if (reasoning.effort !== undefined && lock.protocol.reasoning_parser === null) {
      throw requestError("reasoning effort requires a certified reasoning parser");
    }
  }
  const expected: Record<string, number> = {
    temperature: lock.generation.temperature,
    top_p: lock.generation.top_p,
    top_k: lock.generation.top_k,
    min_p: lock.generation.min_p,
    repetition_penalty: lock.generation.repetition_penalty,
  };
  for (const [name, configured] of Object.entries(expected)) {
    if (body[name] !== undefined && body[name] !== configured) throw requestError(`${name} conflicts with the inference lock`);
    body[name] = configured;
  }
  const maxOutput = body.max_output_tokens ?? lock.generation.max_output_tokens;
  if (!Number.isSafeInteger(maxOutput) || (maxOutput as number) < 1 || (maxOutput as number) > lock.generation.max_output_tokens) {
    throw requestError("max_output_tokens exceeds the inference lock");
  }
  body.max_output_tokens = maxOutput;
  body.store = false;
  body.truncation = "disabled";
  if (body.prompt_cache_key !== undefined) {
    if (typeof body.prompt_cache_key !== "string" || body.prompt_cache_key.length > 256) throw requestError("prompt_cache_key is invalid");
    if (lock.execution.prefix_cache.mode === "radix" && body.cache_salt === undefined) body.cache_salt = body.prompt_cache_key;
    delete body.prompt_cache_key;
  }
  if (body.client_metadata !== undefined) {
    if (!body.client_metadata || typeof body.client_metadata !== "object" || Array.isArray(body.client_metadata)) throw requestError("client_metadata is invalid");
    if (body.metadata === undefined) body.metadata = body.client_metadata;
    delete body.client_metadata;
  }
  return body;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw requestError("model request exceeds 32 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseRoute(raw: string | undefined): { runId: string; endpoint: "responses" | "chat-completions" | "models" } | null {
  let url: URL;
  try { url = new URL(raw ?? "", "http://gateway.local"); } catch { return null; }
  if (url.hash) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[0] !== "runs" || !RUN_ID.test(segments[1] || "") || segments[2] !== "v1") return null;
  if (segments[3] === "models") {
    if ([...url.searchParams.keys()].some((name) => name !== "client_version")) return null;
    return { runId: segments[1] as string, endpoint: "models" };
  }
  if (url.search) return null;
  if (segments[3] === "responses") return { runId: segments[1] as string, endpoint: "responses" };
  if (segments[3] === "chat" || segments[3] === "chat-completions") return { runId: segments[1] as string, endpoint: "chat-completions" };
  return null;
}

function bearer(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  const match = typeof value === "string" ? value.match(/^Bearer ([a-f0-9]{64})$/) : null;
  return match?.[1] ?? null;
}

function containsUnsupportedMedia(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUnsupportedMedia);
  if (!value || typeof value !== "object") return false;
  for (const [name, nested] of Object.entries(value as Record<string, unknown>)) {
    if (name === "image_url" || name === "input_image" || name === "audio_url" || name === "input_audio") return true;
    if (containsUnsupportedMedia(nested)) return true;
  }
  return false;
}

function responseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()].filter(([name]) => !HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "set-cookie"));
}

function respondError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) { response.destroy(error as Error); return; }
  const code = (error as { code?: string }).code || "inference_route_unavailable";
  const status = code === "inference_binding_revoked" ? 401 : code === "inference_capacity_exceeded" ? 429 : code === "inference_parameter_conflict" || code === "inference_modality_unsupported" ? 400 : 502;
  respondJSON(response, status, { error: { code, message: (error as Error).message } });
}

function respondJSON(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value)}\n`);
}

function requestError(message: string): HitchError {
  return new HitchError(message, { code: "inference_parameter_conflict", exitCode: 2 });
}

function upstreamUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash) {
    throw new TypeError("local model gateway upstream must be loopback HTTP");
  }
  return url;
}

function hostForUrl(host: string): string { return host.includes(":") ? `[${host}]` : host; }

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
