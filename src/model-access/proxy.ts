import { capturedPayload, modelFromPayload, usageFromPayload } from "./payload.js";
import { endpointRequest } from "./endpoint-contract.js";
import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import type { InteractionCaptureRefV1, ModelProxyRouteV1, Sha256 } from "../domain/index.js";
import { ensureDir, HitchError } from "../foundation/index.js";
import { ModelInteractionCapture } from "./capture.js";
import { loadInteractionCapture } from "./records.js";
import { bindTrainingRun, trainingProxyIdentity } from "./training.js";
import type { RegisteredTrainingEndpoint } from "./training.js";
import { GenerationBudgetMeter, type GenerationLimits } from "./generation-budget.js";

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_REWRITE_BYTES = 32 * 1024 * 1024;
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const RUN_ID = /^run_[a-f0-9]{32}$/;
type Provider = "openai" | "anthropic";

export interface HostModelProxyOptions {
  upstreamProxyEnv?: Record<string, string>;
  /** Frozen allowance for the entire isolated run, including retries. */
  generationLimits?: GenerationLimits;
  /** Accept HTTP proxy absolute-form requests only for this fixed origin. */
  forwardProxyOrigin?: string;
  upstreamHeaders?: Partial<Record<Provider, Record<string, string>>>;
  captureRoot: string;
  evalId: string;
  mode: "proxy" | "hybrid";
  required: boolean;
  upstreams?: Partial<Record<Provider, string>>;
  /** Private controller-to-upstream credentials. They are injected after capture and never exposed in the Harbor route. */
  upstreamAuthorizations?: Partial<Record<Provider, string>>;
  /** Replaces the caller-facing model name with the exact model alias accepted by a managed upstream. */
  upstreamWireModels?: Partial<Record<Provider, string>>;
  credentialValues?: readonly string[];
  env?: NodeJS.ProcessEnv;
  bindHost?: string;
  advertisedHost?: string;
  listenPort?: number;
  capabilityToken?: string;
  resumeExisting?: boolean;
  topology?: "host-side" | "in-sandbox";
  externalEndpointBinding?: import("../domain/index.js").ExternalEndpointBindingV1;
  trainingEndpoint?: RegisteredTrainingEndpoint;
  trainingBinding?: import("../domain/index.js").TrainingExternalBindingV1;
  /** A worker relay claims its canonical run at the controller before any model call. */
  onRun?: (runId: string) => Promise<void>;
}

export interface HostModelProxyRuntimeIdentity {
  listenPort: number;
  capabilityToken: string;
}

interface CaptureEntry {
  directory: string;
  capture: ModelInteractionCapture;
  finalized?: Promise<InteractionCaptureRefV1>;
}

export class HostModelProxy {
  readonly generationBudget: GenerationBudgetMeter | undefined;
  private readonly forwardProxyOrigin: string | undefined;
  private readonly upstreamHeaders: HostModelProxyOptions["upstreamHeaders"];
  private readonly upstreamAgents: { http: http.Agent; https: https.Agent } | undefined;
  readonly route: ModelProxyRouteV1;
  readonly localBaseUrl: string;
  private readonly server: Server;
  private readonly captures = new Map<string, Promise<CaptureEntry>>();
  private readonly captureRoot: string;
  private readonly evalId: string;
  private readonly mode: "proxy" | "hybrid";
  private readonly required: boolean;
  private readonly upstreams: Record<Provider, URL>;
  private readonly upstreamAuthorizations: Partial<Record<Provider, string>>;
  private readonly upstreamWireModels: Partial<Record<Provider, string>>;
  private readonly credentials: string[];
  private readonly token: string;
  private readonly port: number;
  private readonly resumeExisting: boolean;
  private closed = false;
  private readonly forwards = new Set<Promise<void>>();
  private readonly requests = new Set<import("node:http").ClientRequest>();
  private readonly externalEndpointBinding: HostModelProxyOptions["externalEndpointBinding"];
  private readonly trainingEndpoint: RegisteredTrainingEndpoint | undefined;
  private readonly trainingBinding: import("../domain/index.js").TrainingExternalBindingV1 | undefined;
  private readonly onRun: HostModelProxyOptions["onRun"];
  private trainingRunId: string | undefined;

  private constructor(input: HostModelProxyOptions, server: Server, token: string, port: number) {
    this.generationBudget = input.generationLimits ? new GenerationBudgetMeter(input.generationLimits) : undefined;
    this.forwardProxyOrigin = input.forwardProxyOrigin;
    this.upstreamHeaders = input.upstreamHeaders;
    if (input.upstreamProxyEnv && Object.keys(input.upstreamProxyEnv).length) {
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (!(major! > 24 || (major === 24 && minor! >= 5) || (major === 22 && minor! >= 21))) throw new TypeError("upstream proxy requires Node 22.21+ or 24.5+");
      const options: http.AgentOptions & { proxyEnv: Record<string, string> } = { proxyEnv: input.upstreamProxyEnv };
      this.upstreamAgents = { http: new http.Agent(options), https: new https.Agent(options) };
    }
    this.server = server;
    this.externalEndpointBinding = input.externalEndpointBinding;
    this.token = token;
    this.port = port;
    this.captureRoot = input.captureRoot;
    this.evalId = input.evalId;
    this.mode = input.mode;
    this.required = input.required;
    this.trainingEndpoint = input.trainingEndpoint;
    this.trainingBinding = input.trainingEndpoint?.binding ?? input.trainingBinding;
    this.onRun = input.onRun;
    if (input.trainingBinding && (!input.onRun || input.trainingEndpoint)) throw new TypeError("remote training proxy requires one controlled run binder");
    this.resumeExisting = input.resumeExisting === true;
    const env = input.env ?? process.env;
    this.upstreams = {
      openai: modelUpstream(input.upstreams?.openai ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"),
      anthropic: modelUpstream(input.upstreams?.anthropic ?? env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"),
    };
    this.upstreamAuthorizations = { ...input.upstreamAuthorizations };
    this.upstreamWireModels = { ...input.upstreamWireModels };
    this.credentials = [...new Set([
      ...credentialValues(env),
      ...(input.credentialValues ?? []),
      ...Object.values(input.upstreamHeaders ?? {}).flatMap(headers => Object.values(headers)),
      ...Object.values(this.upstreamAuthorizations).filter((value): value is string => typeof value === "string"),
    ])];
    const advertised = input.advertisedHost ?? "host.docker.internal";
    this.localBaseUrl = `http://127.0.0.1:${port}/${token}`;
    const base = `http://${hostForUrl(advertised)}:${port}/${token}/{run_id}`;
    this.route = {
      schema_version: "1",
      mode: input.mode,
      required: input.required,
      topology: input.topology ?? "host-side",
      base_url_template: `${base}/{provider}`,
      health_url_template: `${base}/health`,
      ...(input.externalEndpointBinding ? { external_endpoint: input.externalEndpointBinding } : {}),
      ...(this.trainingBinding ? { training_external: trainingProxyIdentity(this.trainingBinding) } : {}),
    };
  }

  static async start(input: HostModelProxyOptions): Promise<HostModelProxy> {
    if (!/^eval_[a-f0-9]{32}$/.test(input.evalId) || !new Set(["proxy", "hybrid"]).has(input.mode)) {
      throw new TypeError("host model proxy identity is invalid");
    }
    await ensureDir(input.captureRoot);
    if (input.listenPort !== undefined && (!Number.isSafeInteger(input.listenPort) || input.listenPort < 1 || input.listenPort > 65_535)) {
      throw new TypeError("host model proxy listen port is invalid");
    }
    if (input.capabilityToken !== undefined && !/^[a-f0-9]{48}$/.test(input.capabilityToken)) {
      throw new TypeError("host model proxy capability token is invalid");
    }
    const bindHost = input.bindHost ?? "127.0.0.1";
    if (isIP(bindHost) === 0 || bindHost === "0.0.0.0" || bindHost === "::") {
      throw new TypeError("host model proxy bind address must be a specific local IP address");
    }
    const token = input.capabilityToken ?? randomBytes(24).toString("hex");
    let proxy: HostModelProxy | undefined;
    const server = http.createServer((request, response) => {
      if (!proxy) return;
      const forwarding = proxy.handle(request, response).catch((error) => respondError(response, 502, "model_proxy_failed", error));
      proxy.forwards.add(forwarding);
      void forwarding.finally(() => proxy?.forwards.delete(forwarding));
    });
    server.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
    server.on("upgrade", (_request, socket) => socket.destroy());
    const port = await listen(server, bindHost, input.listenPort ?? 0);
    try { proxy = new HostModelProxy(input, server, token, port); }
    catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
    return proxy;
  }

  async finalizeRun(runId: string, destinationRunDirectory: string): Promise<InteractionCaptureRefV1> {
    const entry = await this.captureFor(runId);
    entry.finalized ??= entry.capture.close();
    const ref = await entry.finalized;
    const loaded = await loadInteractionCapture(entry.directory);
    const destination = path.join(destinationRunDirectory, "interactions");
    await rm(destination, { recursive: true, force: true });
    await cp(path.join(entry.directory, "interactions"), destination, { recursive: true, errorOnExist: true, force: false });
    if (this.externalEndpointBinding && loaded.interactions.some(row => row.effective_model && row.effective_model !== this.externalEndpointBinding!.wire_model)) {
      throw new HitchError("upstream reported a model different from the frozen endpoint", { code: "endpoint_model_mismatch", exitCode: 12 });
    }
    return ref;
  }

  runtimeIdentity(): HostModelProxyRuntimeIdentity {
    return { listenPort: this.port, capabilityToken: this.token };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.requests) request.destroy(new Error("task model access closed"));
    this.upstreamAgents?.http.destroy(); this.upstreamAgents?.https.destroy();
    this.server.closeAllConnections();
    await closeServer(this.server);
    await Promise.allSettled([...this.forwards]);
    const entries = await Promise.all(this.captures.values());
    await Promise.all(entries.map(async (entry) => { entry.finalized ??= entry.capture.close(); await entry.finalized; }));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.forwardProxyOrigin) {
      let url: URL;
      try { url = new URL(request.url ?? ""); } catch { return respondJSON(response, 403, { error: { code: "model_proxy_route_denied" } }); }
      if (url.origin !== this.forwardProxyOrigin || url.username || url.password || url.search || url.hash)
        return respondJSON(response, 403, { error: { code: "model_proxy_route_denied" } });
      request.url = url.pathname;
    }
    const route = parseRoute(request.url, this.token);
    if (!route) return respondJSON(response, 404, { error: { code: "model_proxy_route_not_found" } });
    if (this.generationBudget && (route.kind !== "provider" || route.provider !== "openai" ||
        request.method !== "POST" || route.tail.replace(/^\/v1\//, "/") !== "/responses"))
      return respondJSON(response, 400, { error: { code: "generation_budget_route_unsupported" } });
    if (this.externalEndpointBinding && route.kind === "provider" && (route.provider !== "openai" || request.method !== "POST"
      || route.tail.replace(/^\/v1\//, "/") !== (this.externalEndpointBinding.api === "responses" ? "/responses" : "/chat/completions"))) {
      return respondJSON(response, 404, { error: { code: "endpoint_protocol_unsupported" } });
    }
    if (this.trainingBinding) {
      if (this.trainingRunId && this.trainingRunId !== route.runId) return respondJSON(response, 409, { error: { code: "training_run_fenced" } });
      if (Date.parse(this.trainingBinding.expiresAt) <= Date.now()) return respondJSON(response, 409, { error: { code: "training_lease_expired" } });
      if (this.trainingEndpoint) await bindTrainingRun(this.trainingEndpoint, route.runId);
      this.trainingRunId = route.runId;
      if (route.kind === "provider" && (route.provider !== "openai" || !/^\/(?:v1\/)?chat\/completions$/.test(route.tail) || request.method !== "POST")) {
        return respondJSON(response, 404, { error: { code: "training_generation_only" } });
      }
    }
    await this.onRun?.(route.runId);
    const entry = await this.captureFor(route.runId);
    if (route.kind === "health") return respondJSON(response, 200, { status: "ok" });
    if (entry.finalized) return respondJSON(response, 409, { error: { code: "model_capture_finalized" } });
    await this.forward(request, response, entry, route.provider, route.tail);
  }

  private async forward(request: IncomingMessage, response: ServerResponse, entry: CaptureEntry, provider: Provider, tail: string): Promise<void> {
    const upstream = new URL(this.upstreams[provider]);
    upstream.pathname = joinUrlPath(upstream.pathname, tail);
    upstream.search = request.url?.includes("?") ? `?${request.url.split("?").slice(1).join("?")}` : "";
    const startedAt = new Date().toISOString();
    const wireModel = this.upstreamWireModels[provider];
    let rewritten = wireModel ? rewriteModelRequest(await readBoundedRequest(request), request.headers["content-type"], wireModel, this.externalEndpointBinding) : undefined;
    if (this.generationBudget) {
      if (!rewritten) throw new TypeError("budgeted proxy requires a frozen model");
      const admitted = this.generationBudget.reserve(JSON.parse(rewritten.forwarded.toString("utf8")));
      rewritten = { ...rewritten, forwarded: Buffer.from(JSON.stringify(admitted)) };
    }
    const requestCapture = rewritten
      ? Promise.resolve({ body: rewritten.original, truncated: false })
      : captureStream(request);
    const transport = upstream.protocol === "https:" ? https : http;
    const headers = forwardedHeaders(request.headers, upstream);
    const authorization = this.upstreamAuthorizations[provider];
    if (authorization !== undefined) { delete headers.authorization; if (authorization) headers.authorization = authorization; }
    Object.assign(headers, this.upstreamHeaders?.[provider]);
    if (rewritten) headers["content-length"] = String(rewritten.forwarded.length);
    const upstreamRequest = transport.request(upstream, {
      method: request.method,
      headers,
      ...(this.upstreamAgents ? { agent: upstream.protocol === "https:" ? this.upstreamAgents.https : this.upstreamAgents.http } : {}),
    });
    this.requests.add(upstreamRequest);
    const cancelUpstream = () => { if (!response.writableEnded) upstreamRequest.destroy(new Error("model client disconnected")); };
    response.once("close", cancelUpstream);
    upstreamRequest.once("close", () => { this.requests.delete(upstreamRequest); response.off("close", cancelUpstream); });
    if (rewritten) upstreamRequest.end(rewritten.forwarded);
    else request.pipe(upstreamRequest);
    await new Promise<void>((resolve, reject) => {
      upstreamRequest.once("response", (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers));
        const responseCapture = captureStream(upstreamResponse);
        void responseCapture.catch(() => undefined);
        // Codex closes its SSE reader as soon as response.completed arrives.
        // Budgeted responses are bounded and released only after settlement,
        // so that normal early close cannot discard usage or race another call.
        if (!this.generationBudget) upstreamResponse.pipe(response, { end: false });
        upstreamResponse.once("end", () => {
          Promise.all([requestCapture, responseCapture]).then(async ([requestBody, responseBody]) => {
            const requestValue = capturedPayload(requestBody, request.headers["content-type"]);
            const responseValue = capturedPayload(responseBody, upstreamResponse.headers["content-type"]);
            this.generationBudget?.settle(responseValue);
            const requestedModel = modelFromPayload(requestValue) ?? "unknown";
            await entry.capture.record({
              requestedModel,
              ...(modelFromPayload(responseValue) ? { effectiveModel: modelFromPayload(responseValue) as string } : {}),
              endpoint: upstream.toString(),
              startedAt,
              completedAt: new Date().toISOString(),
              status: (upstreamResponse.statusCode ?? 500) < 400 ? "succeeded" : "failed",
              httpStatus: upstreamResponse.statusCode ?? 502,
              ...(usageFromPayload(responseValue) ? { usage: usageFromPayload(responseValue) as Record<string, number> } : {}),
              request: requestValue,
              requestHeaders: stringHeaders(request.headers),
              response: responseValue,
              responseHeaders: stringHeaders(upstreamResponse.headers),
            });
            // Expose completion only after the reservation has been settled;
            // the next harness request cannot race the previous usage report.
            if (this.generationBudget && responseBody.truncated) throw new Error("budgeted model response exceeds capture limit");
            response.end(this.generationBudget ? responseBody.body : undefined);
            resolve();
          }).catch(reject);
        });
        upstreamResponse.once("error", reject);
      });
      upstreamRequest.once("error", reject);
      request.once("aborted", () => upstreamRequest.destroy(new Error("model proxy client request aborted")));
    }).catch(async (error) => {
      this.generationBudget?.fail();
      await entry.capture.record({
        requestedModel: "unknown",
        endpoint: upstream.toString(),
        startedAt,
        status: "failed",
        requestHeaders: stringHeaders(request.headers),
        error: { code: "model_proxy_upstream_failed", message: (error as Error).message },
      }).catch(() => undefined);
      if (!response.headersSent) respondError(response, 502, "model_proxy_upstream_failed", error);
      else response.destroy(error as Error);
      throw error;
    });
  }

  private captureFor(runId: string): Promise<CaptureEntry> {
    if (!RUN_ID.test(runId)) throw new TypeError("model proxy run identity is invalid");
    let pending = this.captures.get(runId);
    if (!pending) {
      pending = (async () => {
        const directory = await ensureDir(path.join(this.captureRoot, runId));
        const capture = await ModelInteractionCapture.open({
          runDirectory: directory,
          runId,
          evalId: this.evalId,
          mode: this.mode,
          required: this.required,
          topology: this.route.topology,
          credentialValues: this.credentials,
          resumeExisting: this.resumeExisting,
        });
        return { directory, capture };
      })();
      this.captures.set(runId, pending);
    }
    return pending;
  }
}

async function readBoundedRequest(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REWRITE_BYTES) throw new Error("managed model request exceeds 32 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function rewriteModelRequest(
  original: Buffer,
  contentType: string | string[] | undefined,
  wireModel: string,
  binding?: import("../domain/index.js").ExternalEndpointBindingV1,
): { original: Buffer; forwarded: Buffer } {
  const type = Array.isArray(contentType) ? contentType[0] : contentType;
  if (!type?.toLowerCase().includes("json")) throw new Error("managed model request must use JSON");
  let value: unknown;
  try { value = JSON.parse(original.toString("utf8")); }
  catch { throw new Error("managed model request must contain valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("managed model request must be a JSON object");
  const forwarded = Buffer.from(JSON.stringify(binding ? endpointRequest(binding, value as Record<string, unknown>) : { ...(value as Record<string, unknown>), model: wireModel }));
  return { original, forwarded };
}

type ParsedRoute = { runId: string; kind: "health" } | { runId: string; kind: "provider"; provider: Provider; tail: string };

function parseRoute(raw: string | undefined, token: string): ParsedRoute | null {
  let url: URL;
  try { url = new URL(raw ?? "", "http://model-proxy.local"); } catch { return null; }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== token || !RUN_ID.test(segments[1] ?? "")) return null;
  const runId = segments[1] as string;
  if (segments[2] === "health" && segments.length === 3) return { runId, kind: "health" };
  if (segments[2] !== "openai" && segments[2] !== "anthropic") return null;
  return { runId, kind: "provider", provider: segments[2], tail: `/${segments.slice(3).join("/")}` };
}

function modelUpstream(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("model proxy upstream must be an absolute URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:" || url.username || url.password || url.search || url.hash) {
    throw new TypeError("model proxy upstream is invalid");
  }
  return url;
}

function hostForUrl(host: string): string {
  if (!host || /[\s\0\/?#@]/.test(host)) throw new TypeError("model proxy advertised host is invalid");
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function joinUrlPath(base: string, tail: string): string {
  return `${base.replace(/\/+$/, "")}/${tail.replace(/^\/+/, "")}` || "/";
}

function forwardedHeaders(headers: IncomingHttpHeaders, upstream: URL): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = { host: upstream.host };
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "host") result[name] = value;
  }
  return result;
}

function responseHeaders(headers: IncomingHttpHeaders): http.OutgoingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && !HOP_HEADERS.has(name.toLowerCase())));
}

function stringHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined));
}

function captureStream(stream: IncomingMessage): Promise<{ body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const available = Math.max(0, MAX_CAPTURE_BYTES - size);
      if (buffer.length > available) truncated = true;
      if (size < MAX_CAPTURE_BYTES) {
        const retained = buffer.subarray(0, available);
        chunks.push(retained);
        size += retained.length;
      }
    });
    stream.once("end", () => resolve({ body: Buffer.concat(chunks), truncated }));
    stream.once("error", reject);
  });
}

function credentialValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).filter(([name, value]) => value && /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(name)).map(([, value]) => value as string);
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("model proxy has no TCP address"));
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function respondJSON(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function respondError(response: ServerResponse, status: number, code: string, error: unknown): void {
  respondJSON(response, status, { error: { code, message: String((error as Error)?.message || error).slice(0, 512) } });
}
