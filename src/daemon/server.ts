import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Scheduler } from "./scheduler.js";
import { EvalScheduler, ResourceLedger } from "../control-plane/index.js";
import type { EvalSchedulerOptions } from "../control-plane/index.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, ensureDir, invalidInput, readJSON, removeIfExists, statePaths } from "../foundation/index.js";
import type { StatePaths } from "../foundation/index.js";
import type { EvalId, ResourceVectorV1, RunId } from "../domain/index.js";
import { acquireInstanceLock, authorized, ensureToken, releaseInstanceLock } from "./auth.js";

export interface DaemonServerOptions {
  root: string;
  port: number;
  maxConcurrent: number;
  logger?: (type: string, fields: Record<string, unknown>) => void;
  discoverHarnesses?: () => Promise<unknown[]>;
  resourceCapacity?: ResourceVectorV1;
  runResources?: ResourceVectorV1;
  evalTrialResources?: ResourceVectorV1;
  evalExecutor?: EvalSchedulerOptions["executor"];
}

export class DaemonServer {
  readonly paths: StatePaths;
  readonly rootId: string;
  readonly instanceId: string;
  port: number;
  readonly maxConcurrent: number;
  private readonly logger: (type: string, fields: Record<string, unknown>) => void;
  private readonly discoverHarnesses: () => Promise<unknown[]>;
  private readonly startedAt: Date;
  private ready = false;
  private closing = false;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private ownsLock = false;
  private token: string | undefined;
  private agents: unknown[] | undefined;
  private scheduler: Scheduler | undefined;
  private evalScheduler: EvalScheduler | undefined;
  private resources: ResourceLedger | undefined;
  private server: ReturnType<typeof createServer> | undefined;
  private readonly resourceCapacity: ResourceVectorV1;
  private readonly runResources: ResourceVectorV1;
  private readonly evalTrialResources: ResourceVectorV1;
  private readonly evalExecutor: EvalSchedulerOptions["executor"] | undefined;

  constructor({ root, port, maxConcurrent, logger = defaultLogger, discoverHarnesses = async () => [], resourceCapacity, runResources, evalTrialResources, evalExecutor }: DaemonServerOptions) {
    this.paths = statePaths(root);
    this.rootId = createHash("sha256").update(this.paths.root).digest("hex").slice(0, 24);
    this.instanceId = randomBytes(16).toString("hex");
    this.port = port;
    this.maxConcurrent = maxConcurrent;
    this.logger = logger;
    this.discoverHarnesses = discoverHarnesses;
    this.resourceCapacity = resourceCapacity || defaultResourceCapacity(maxConcurrent);
    this.runResources = runResources || { cpu_millis: 1_000, memory_bytes: 512 * 1024 * 1024, container_slots: 0, build_slots: 0 };
    this.evalTrialResources = evalTrialResources || { cpu_millis: 1_000, memory_bytes: 1024 * 1024 * 1024, container_slots: 1, build_slots: 0 };
    this.evalExecutor = evalExecutor;
    this.startedAt = new Date();
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve; });
  }

  get closed(): Promise<void> {
    return this.closedPromise;
  }

  async start(): Promise<this> {
    await ensureDir(this.paths.root);
    await acquireInstanceLock(this.paths.lock, this.instanceId);
    this.ownsLock = true;
    try {
      this.token = await ensureToken(this.paths.token);
      this.agents = await this.discoverHarnesses();
      this.resources = new ResourceLedger(this.resourceCapacity);
      this.scheduler = new Scheduler({
        runsRoot: this.paths.runs,
        root: this.paths.root,
        maxConcurrent: this.maxConcurrent,
        resources: this.resources,
        runResources: this.runResources,
        onEvent: (event) => this.logger("event", { type: event.type, run_id: event.run_id }),
      });
      await this.scheduler.initialize();
      this.evalScheduler = new EvalScheduler({
        root: this.paths.root,
        resources: this.resources,
        trialResources: this.evalTrialResources,
        ...(this.evalExecutor ? { executor: this.evalExecutor } : {}),
        onEvent: (event) => this.logger("event", { type: event.type, eval_id: event.eval_id }),
      });
      await this.evalScheduler.initialize();

      this.server = createServer((request, response) => {
        this.handle(request, response).catch((error) => {
          this.logger("request_error", { error: (error as Error).message, path: request.url });
          const status = errorStatus(error);
          json(response, status, {
            error: {
              code: (error as { code?: string }).code || "internal_error",
              message: (error as Error).message,
              exit_code: Number.isInteger((error as { exitCode?: unknown }).exitCode) ? (error as { exitCode: number }).exitCode : 12,
            },
          });
        });
      });
      this.server.requestTimeout = 30_000;
      this.server.headersTimeout = 10_000;

      await new Promise<void>((resolve, reject) => {
        this.server?.once("error", reject);
        this.server?.listen(this.port, "127.0.0.1", () => resolve());
      });
      this.port = (this.server?.address() as { port: number }).port;
      await atomicWriteJSON(this.paths.daemon, {
        schema_version: SCHEMA_VERSION,
        pid: process.pid,
        port: this.port,
        root_id: this.rootId,
        instance_id: this.instanceId,
        root: this.paths.root,
        started_at: this.startedAt.toISOString(),
      });
      this.ready = true;
      this.logger("started", { pid: process.pid, port: this.port, instance_id: this.instanceId });
      return this;
    } catch (error) {
      if (this.server?.listening) await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      await Promise.all([
        this.scheduler?.shutdown().catch(() => {}),
        this.evalScheduler?.shutdown().catch(() => {}),
      ]);
      await releaseInstanceLock(this.paths.lock, this.instanceId);
      this.ownsLock = false;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closedPromise;
    this.closing = true;
    this.ready = false;
    let failure: Error | undefined;
    try {
      await Promise.all([this.scheduler?.shutdown(), this.evalScheduler?.shutdown()]);
      if (this.server) await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    } catch (error) {
      failure = error as Error;
    } finally {
      try {
        const state = await readJSON<{ instance_id?: string } | null>(this.paths.daemon, null);
        if (state?.instance_id === this.instanceId) await removeIfExists(this.paths.daemon);
        if (this.ownsLock) {
          await releaseInstanceLock(this.paths.lock, this.instanceId);
          this.ownsLock = false;
        }
      } catch (cleanupError) {
        failure ||= cleanupError as Error;
      }
      this.logger("stopped", { pid: process.pid, instance_id: this.instanceId });
      this.resolveClosed();
    }
    if (failure) throw failure;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url || "/", `http://127.0.0.1:${this.port}`);
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, this.health());
    }

    if (!authorized(request, this.token || "")) {
      return json(response, 401, { error: { code: "unauthorized", message: "missing or invalid daemon token" } });
    }

    if (request.method === "GET" && ["/v1/harnesses", "/v1/agents"].includes(url.pathname)) {
      this.agents = await this.discoverHarnesses();
      const key = url.pathname === "/v1/agents" ? "agents" : "harnesses";
      return json(response, 200, { schema_version: SCHEMA_VERSION, [key]: this.agents });
    }
    if (request.method === "GET" && url.pathname === "/v1/workers") {
      const worker = this.evalScheduler?.workerSnapshot();
      return json(response, 200, { schema_version: SCHEMA_VERSION, workers: worker ? [worker] : [] });
    }
    if (request.method === "POST" && url.pathname === "/v1/runs") {
      const requestBody = await readBodyJSON(request);
      const runId = await this.scheduler?.submit(requestBody as RunRequestInput);
      return json(response, 202, { schema_version: SCHEMA_VERSION, run_id: runId, status: "queued" });
    }
    if (request.method === "POST" && url.pathname === "/v1/evals") {
      const requestBody = await readBodyJSON(request);
      const header = request.headers["idempotency-key"];
      if (Array.isArray(header)) throw invalidInput("idempotency-key header must appear once");
      const evalId = await this.evalScheduler?.submit(requestBody as EvalRequestInput, header ? { idempotencyKey: header } : {});
      return json(response, 202, { schema_version: SCHEMA_VERSION, eval_id: evalId, status: "queued" });
    }
    if (request.method === "POST" && url.pathname === "/shutdown") {
      json(response, 202, { schema_version: SCHEMA_VERSION, status: "shutting_down" });
      setImmediate(() => this.close().catch((error) => this.logger("shutdown_error", { error: (error as Error).message })));
      return;
    }

    const evalMatch = url.pathname.match(/^\/v1\/evals\/(eval_[a-f0-9]+)(?:\/(events|cancel))?$/);
    if (evalMatch) {
      const [, evalId, action] = evalMatch;
      if (request.method === "GET" && !action) {
        const status = await this.evalScheduler?.status(evalId as EvalId);
        return status
          ? json(response, 200, { schema_version: SCHEMA_VERSION, eval_id: evalId, ...status })
          : json(response, 404, { error: { code: "eval_not_found", message: `eval not found: ${evalId}` } });
      }
      if (request.method === "GET" && action === "events") {
        return this.streamEvents(response, path.join(this.paths.evals, evalId as string, "events.jsonl"), url.searchParams.get("offset") || "0");
      }
      if (request.method === "POST" && action === "cancel") {
        const outcome = await this.evalScheduler?.cancel(evalId as EvalId);
        if (outcome === "accepted") return json(response, 202, { schema_version: SCHEMA_VERSION, eval_id: evalId, status: "cancelling" });
        if (outcome === "terminal") {
          const status = await this.evalScheduler?.status(evalId as EvalId);
          return json(response, 200, { schema_version: SCHEMA_VERSION, eval_id: evalId, status: status?.control.state || "terminal" });
        }
        if (outcome === "not_found") return json(response, 404, { error: { code: "eval_not_found", message: `eval not found: ${evalId}` } });
        return json(response, 409, { error: { code: "not_cancellable", message: "eval is not queued or running" } });
      }
    }

    const runMatch = url.pathname.match(/^\/v1\/runs\/(run_[a-f0-9]+)(?:\/(events|cancel))?$/);
    if (runMatch) {
      const [, runId, action] = runMatch;
      if (request.method === "GET" && !action) {
        const status = await this.scheduler?.status(runId as RunId);
        return status
          ? json(response, 200, { schema_version: SCHEMA_VERSION, ...status })
          : json(response, 404, { error: { code: "run_not_found", message: `run not found: ${runId}` } });
      }
      if (request.method === "GET" && action === "events") {
        return this.streamEvents(response, path.join(this.paths.runs, runId as string, "events.jsonl"), url.searchParams.get("offset") || "0");
      }
      if (request.method === "POST" && action === "cancel") {
        const cancelled = await this.scheduler?.cancel(runId as RunId);
        return cancelled
          ? json(response, 202, { schema_version: SCHEMA_VERSION, run_id: runId, status: "cancelling" })
          : json(response, 409, { error: { code: "not_cancellable", message: "run is not queued or running" } });
      }
    }

    json(response, 404, { error: { code: "not_found", message: "endpoint not found" } });
  }

  health(): Record<string, unknown> {
    return {
      schema_version: SCHEMA_VERSION,
      status: this.ready ? "running" : this.closing ? "stopping" : "starting",
      pid: process.pid,
      port: this.port,
      instance_id: this.instanceId,
      root_id: this.rootId,
      uptime_seconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      agents: this.agents?.filter((agent) => (agent as { status?: string }).status === "available").map((agent) => (agent as { id: string }).id) || [],
      harnesses: this.agents?.filter((agent) => (agent as { status?: string }).status === "available").map((agent) => (agent as { id: string }).id) || [],
      scheduler: this.scheduler?.snapshot() || null,
      eval_scheduler: this.evalScheduler?.snapshot() || null,
      resources: this.resources?.snapshot() || null,
    };
  }

  private async streamEvents(response: ServerResponse, eventsPath: string, offsetValue: string): Promise<void> {
    if (!/^\d+$/.test(offsetValue)) throw invalidInput("events offset must be a non-negative integer");
    const offset = Number(offsetValue);
    if (!Number.isSafeInteger(offset)) throw invalidInput("events offset is too large");
    try {
      const info = await stat(eventsPath);
      if (offset > info.size) throw invalidInput(`events offset ${offset} exceeds current size ${info.size}`);
      const completeSize = await completeLineSize(eventsPath, info.size);
      if (offset > completeSize) throw invalidInput(`events offset ${offset} exceeds committed size ${completeSize}`);
      if (!await isLineBoundary(eventsPath, offset)) throw invalidInput(`events offset ${offset} is not at an event boundary`);
      response.writeHead(200, {
        "content-type": "application/x-ndjson",
        "x-hitch-next-offset": String(completeSize),
        "accept-ranges": "bytes",
      });
      if (offset === completeSize) response.end();
      else await streamFileRange(eventsPath, offset, completeSize - 1, response);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return json(response, 404, { error: { code: "events_not_found", message: "events not available" } });
      if (response.headersSent) {
        response.destroy(error as Error);
        return;
      }
      throw error;
    }
  }
}

function errorStatus(error: unknown): number {
  if ((error as { code?: unknown }).code === "idempotency_conflict") return 409;
  const exitCode = (error as { exitCode?: unknown }).exitCode;
  if (exitCode === 2) return 400;
  if (exitCode === 3) return 404;
  if (exitCode === 11) return 403;
  if ([4, 5, 10].includes(exitCode as number)) return 422;
  return 500;
}

function httpErrorCode(status: number): string {
  if (status === 400) return "invalid_input";
  if (status === 404) return "not_found";
  return "daemon_request_failed";
}

function streamFileRange(file: string, start: number, end: number, response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { start, end });
    stream.once("error", reject);
    response.once("error", reject);
    response.once("finish", resolve);
    stream.pipe(response);
  });
}

async function completeLineSize(file: string, size: number): Promise<number> {
  if (size === 0) return 0;
  const handle = await open(file, "r");
  try {
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - 64 * 1024);
      const buffer = Buffer.allocUnsafe(end - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline >= 0) return start + newline + 1;
      end = start;
    }
    return 0;
  } finally {
    await handle.close();
  }
}

async function isLineBoundary(file: string, offset: number): Promise<boolean> {
  if (offset === 0) return true;
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(buffer, 0, 1, offset - 1);
    return bytesRead === 1 && buffer[0] === 0x0a;
  } finally {
    await handle.close();
  }
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
  } catch {
    throw invalidInput("invalid JSON request body");
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

function defaultLogger(type: string, fields: Record<string, unknown>): void {
  process.stdout.write(`${new Date().toISOString()} ${type} ${JSON.stringify(fields)}\n`);
}

type RunRequestInput = import("../runs/index.js").RunRequestInput;
type EvalRequestInput = import("../evals/index.js").EvalRequestInput;

function defaultResourceCapacity(maxConcurrent: number): ResourceVectorV1 {
  return {
    cpu_millis: maxConcurrent * 1_000,
    memory_bytes: maxConcurrent * 1024 * 1024 * 1024,
    container_slots: maxConcurrent,
    build_slots: 1,
  };
}
