import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Scheduler } from "./scheduler.js";
import { atomicWriteJSON, ensureDir, readJSON, removeIfExists, writePrivateFile } from "./fs.js";
import { discoverAgents } from "./registry.js";
import { SCHEMA_VERSION, statePaths } from "./config.js";
import type { StatePaths } from "./config.js";
import { HitchError, invalidInput } from "./errors.js";
import { reclaimStaleLock } from "./locks.js";
import type { RunId } from "./domain/types.js";

export interface DaemonServerOptions {
  root: string;
  port: number;
  maxConcurrent: number;
  logger?: (type: string, fields: Record<string, unknown>) => void;
}

export class DaemonServer {
  readonly paths: StatePaths;
  readonly rootId: string;
  readonly instanceId: string;
  port: number;
  readonly maxConcurrent: number;
  private readonly logger: (type: string, fields: Record<string, unknown>) => void;
  private readonly startedAt: Date;
  private ready = false;
  private closing = false;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private ownsLock = false;
  private token: string | undefined;
  private agents: unknown[] | undefined;
  private scheduler: Scheduler | undefined;
  private server: ReturnType<typeof createServer> | undefined;

  constructor({ root, port, maxConcurrent, logger = defaultLogger }: DaemonServerOptions) {
    this.paths = statePaths(root);
    this.rootId = createHash("sha256").update(this.paths.root).digest("hex").slice(0, 24);
    this.instanceId = randomBytes(16).toString("hex");
    this.port = port;
    this.maxConcurrent = maxConcurrent;
    this.logger = logger;
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
      this.agents = await discoverAgents();
      this.scheduler = new Scheduler({
        runsRoot: this.paths.runs,
        root: this.paths.root,
        maxConcurrent: this.maxConcurrent,
        onEvent: (event) => this.logger("event", { type: event.type, run_id: event.run_id }),
      });
      await this.scheduler.initialize();

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
      await this.scheduler?.shutdown().catch(() => {});
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
      await this.scheduler?.shutdown();
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
      this.agents = await discoverAgents();
      const key = url.pathname === "/v1/agents" ? "agents" : "harnesses";
      return json(response, 200, { schema_version: SCHEMA_VERSION, [key]: this.agents });
    }
    if (request.method === "POST" && url.pathname === "/v1/runs") {
      const requestBody = await readBodyJSON(request);
      const runId = await this.scheduler?.submit(requestBody as RunRequestInput);
      return json(response, 202, { schema_version: SCHEMA_VERSION, run_id: runId, status: "queued" });
    }
    if (request.method === "POST" && url.pathname === "/shutdown") {
      json(response, 202, { schema_version: SCHEMA_VERSION, status: "shutting_down" });
      setImmediate(() => this.close().catch((error) => this.logger("shutdown_error", { error: (error as Error).message })));
      return;
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
        const offsetValue = url.searchParams.get("offset") || "0";
        if (!/^\d+$/.test(offsetValue)) throw invalidInput("events offset must be a non-negative integer");
        const offset = Number(offsetValue);
        if (!Number.isSafeInteger(offset)) throw invalidInput("events offset is too large");
        const eventsPath = path.join(this.paths.runs, runId as string, "events.jsonl");
        try {
          const info = await stat(eventsPath);
          if (offset > info.size) throw invalidInput(`events offset ${offset} exceeds current size ${info.size}`);
          const completeSize = await completeLineSize(eventsPath, info.size);
          if (offset > completeSize) {
            throw invalidInput(`events offset ${offset} exceeds committed size ${completeSize}`);
          }
          if (!await isLineBoundary(eventsPath, offset)) {
            throw invalidInput(`events offset ${offset} is not at an event boundary`);
          }
          response.writeHead(200, {
            "content-type": "application/x-ndjson",
            "x-hitch-next-offset": String(completeSize),
            "accept-ranges": "bytes",
          });
          if (offset === completeSize) {
            response.end();
          } else {
            await streamFileRange(eventsPath, offset, completeSize - 1, response);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return json(response, 404, { error: { code: "events_not_found", message: "events not available" } });
          if (response.headersSent) {
            response.destroy(error as Error);
            return;
          }
          throw error;
        }
        return;
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
    };
  }
}

interface DaemonClient {
  state: { port?: number; instance_id?: string };
  request: (pathname: string, options?: RequestInit) => Promise<Record<string, unknown>>;
  requestWithMetadata: (pathname: string, options?: RequestInit) => Promise<{
    payload: Record<string, unknown> | string;
    headers: Headers;
    status: number;
  }>;
}

export async function daemonClient(root: string): Promise<DaemonClient> {
  const paths = statePaths(root);
  const state = await readJSON<{ port?: number; instance_id?: string } | null>(paths.daemon, null);
  if (!state?.port) throw new Error("daemon is not running");
  const token = (await readFile(paths.token, "utf8")).trim();
  const performRequest = async (pathname: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(`http://127.0.0.1:${state.port as number}${pathname}`, { ...options, headers });
    const contentType = response.headers.get("content-type") || "";
    const mediaType = (contentType.split(";", 1)[0] || "").trim().toLowerCase();
    const isJSONDocument = mediaType === "application/json" || mediaType.endsWith("+json");
    const payload: Record<string, unknown> | string = isJSONDocument ? await response.json() as Record<string, unknown> : await response.text();
    if (!response.ok) {
      const errorPayload = typeof payload === "object" && payload !== null ? payload : {};
      const message = (errorPayload.error as { message?: string } | undefined)?.message || `daemon request failed (${response.status})`;
      const error = new HitchError(message, {
        code: (errorPayload.error as { code?: string } | undefined)?.code || httpErrorCode(response.status),
        exitCode: Number.isInteger((errorPayload.error as { exit_code?: unknown } | undefined)?.exit_code)
          ? (errorPayload.error as { exit_code: number }).exit_code
          : httpExitCode(response.status),
      });
      (error as { status?: number }).status = response.status;
      throw error;
    }
    return { payload, headers: response.headers, status: response.status };
  };
  const request = async (pathname: string, options?: RequestInit) => (await performRequest(pathname, options)).payload as Record<string, unknown>;
  return { state, request, requestWithMetadata: performRequest };
}

async function acquireInstanceLock(file: string, instanceId: string): Promise<void> {
  const owner = {
    schema_version: SCHEMA_VERSION,
    instance_id: instanceId,
    pid: process.pid,
    created_at: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      let existing: { pid?: unknown } | null;
      try {
        existing = JSON.parse(await readFile(file, "utf8")) as { pid?: unknown };
      } catch (readError) {
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        throw new HitchError("daemon lock exists but its owner record is unreadable", { code: "daemon_lock_invalid", exitCode: 12, cause: readError });
      }
      if (processIsAlive(existing.pid)) {
        throw new HitchError(`another daemon owns this root (pid ${existing.pid})`, { code: "already_running", exitCode: 2 });
      }
      const reclaimed = await reclaimStaleLock(file, async (candidate) => {
        let current: { pid?: unknown } | null;
        try {
          current = JSON.parse(await readFile(candidate, "utf8")) as { pid?: unknown };
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException)?.code === "ENOENT") return false;
          throw new HitchError("daemon lock exists but its owner record is unreadable", {
            code: "daemon_lock_invalid",
            exitCode: 12,
            cause: readError,
          });
        }
        return !processIsAlive(current.pid);
      });
      if (!reclaimed) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new HitchError("could not acquire daemon root lock", { code: "daemon_lock_failed", exitCode: 12 });
}

async function releaseInstanceLock(file: string, instanceId: string): Promise<void> {
  let owner: { instance_id?: unknown };
  try {
    owner = JSON.parse(await readFile(file, "utf8")) as { instance_id?: unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    return;
  }
  if (owner.instance_id === instanceId) await rm(file, { force: true });
}

function processIsAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function httpExitCode(status: number): number {
  if (status === 400) return 2;
  if (status === 404) return 3;
  return 12;
}

function errorStatus(error: unknown): number {
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

async function ensureToken(file: string): Promise<string> {
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("hex");
  await writePrivateFile(file, `${token}\n`);
  return token;
}

function authorized(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization || "";
  if (!value.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
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

type RunRequestInput = import("./engine.js").RunRequestInput;
