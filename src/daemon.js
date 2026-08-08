import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Scheduler } from "./scheduler.js";
import { atomicWriteJSON, ensureDir, readJSON, removeIfExists, writePrivateFile } from "./fs.js";
import { discoverAgents } from "./registry.js";
import { SCHEMA_VERSION, statePaths } from "./config.js";
import { HitchError, invalidInput } from "./errors.js";

export class DaemonServer {
  constructor({ root, port, maxConcurrent, logger = defaultLogger }) {
    this.paths = statePaths(root);
    this.rootId = createHash("sha256").update(this.paths.root).digest("hex").slice(0, 24);
    this.instanceId = randomBytes(16).toString("hex");
    this.port = port;
    this.maxConcurrent = maxConcurrent;
    this.logger = logger;
    this.startedAt = new Date();
    this.ready = false;
    this.closing = false;
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
  }

  async start() {
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
          this.logger("request_error", { error: error.message, path: request.url });
          const status = errorStatus(error);
          json(response, status, {
            error: {
              code: error.code || "internal_error",
              message: error.message,
              exit_code: Number.isInteger(error?.exitCode) ? error.exitCode : 12,
            },
          });
        });
      });
      this.server.requestTimeout = 30_000;
      this.server.headersTimeout = 10_000;

      await new Promise((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.port, "127.0.0.1", resolve);
      });
      this.port = this.server.address().port;
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
      if (this.server?.listening) await new Promise((resolve) => this.server.close(resolve));
      await this.scheduler?.shutdown().catch(() => {});
      await releaseInstanceLock(this.paths.lock, this.instanceId);
      this.ownsLock = false;
      throw error;
    }
  }

  async close() {
    if (this.closing) return this.closed;
    this.closing = true;
    this.ready = false;
    let failure;
    try {
      await this.scheduler?.shutdown();
      if (this.server) await new Promise((resolve) => this.server.close(resolve));
    } catch (error) {
      failure = error;
    } finally {
      try {
        const state = await readJSON(this.paths.daemon, null);
        if (state?.instance_id === this.instanceId) await removeIfExists(this.paths.daemon);
        if (this.ownsLock) {
          await releaseInstanceLock(this.paths.lock, this.instanceId);
          this.ownsLock = false;
        }
      } catch (cleanupError) {
        failure ||= cleanupError;
      }
      this.logger("stopped", { pid: process.pid, instance_id: this.instanceId });
      this.resolveClosed();
    }
    if (failure) throw failure;
  }

  async handle(request, response) {
    const url = new URL(request.url, `http://127.0.0.1:${this.port}`);
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, this.health());
    }

    if (!authorized(request, this.token)) {
      return json(response, 401, { error: { code: "unauthorized", message: "missing or invalid daemon token" } });
    }

    if (request.method === "GET" && ["/v1/harnesses", "/v1/agents"].includes(url.pathname)) {
      this.agents = await discoverAgents();
      const key = url.pathname === "/v1/agents" ? "agents" : "harnesses";
      return json(response, 200, { schema_version: SCHEMA_VERSION, [key]: this.agents });
    }
    if (request.method === "POST" && url.pathname === "/v1/runs") {
      const requestBody = await readBodyJSON(request);
      const runId = await this.scheduler.submit(requestBody);
      return json(response, 202, { schema_version: SCHEMA_VERSION, run_id: runId, status: "queued" });
    }
    if (request.method === "POST" && url.pathname === "/shutdown") {
      json(response, 202, { schema_version: SCHEMA_VERSION, status: "shutting_down" });
      setImmediate(() => this.close().catch((error) => this.logger("shutdown_error", { error: error.message })));
      return;
    }

    const runMatch = url.pathname.match(/^\/v1\/runs\/(run_[a-f0-9]+)(?:\/(events|cancel))?$/);
    if (runMatch) {
      const [, runId, action] = runMatch;
      if (request.method === "GET" && !action) {
        const status = await this.scheduler.status(runId);
        return status
          ? json(response, 200, { schema_version: SCHEMA_VERSION, ...status })
          : json(response, 404, { error: { code: "run_not_found", message: `run not found: ${runId}` } });
      }
      if (request.method === "GET" && action === "events") {
        const offsetValue = url.searchParams.get("offset") || "0";
        if (!/^\d+$/.test(offsetValue)) throw invalidInput("events offset must be a non-negative integer");
        const offset = Number(offsetValue);
        if (!Number.isSafeInteger(offset)) throw invalidInput("events offset is too large");
        const eventsPath = path.join(this.paths.runs, runId, "events.jsonl");
        try {
          const info = await stat(eventsPath);
          if (offset > info.size) throw invalidInput(`events offset ${offset} exceeds current size ${info.size}`);
          response.writeHead(200, {
            "content-type": "application/x-ndjson",
            "x-hitch-next-offset": String(info.size),
            "accept-ranges": "bytes",
          });
          if (offset === info.size) {
            response.end();
          } else {
            await streamFileRange(eventsPath, offset, info.size - 1, response);
          }
        } catch (error) {
          if (error?.code === "ENOENT") return json(response, 404, { error: { code: "events_not_found", message: "events not available" } });
          if (response.headersSent) {
            response.destroy(error);
            return;
          }
          throw error;
        }
        return;
      }
      if (request.method === "POST" && action === "cancel") {
        const cancelled = await this.scheduler.cancel(runId);
        return cancelled
          ? json(response, 202, { schema_version: SCHEMA_VERSION, run_id: runId, status: "cancelling" })
          : json(response, 409, { error: { code: "not_cancellable", message: "run is not queued or running" } });
      }
    }

    json(response, 404, { error: { code: "not_found", message: "endpoint not found" } });
  }

  health() {
    return {
      schema_version: SCHEMA_VERSION,
      status: this.ready ? "running" : this.closing ? "stopping" : "starting",
      pid: process.pid,
      port: this.port,
      instance_id: this.instanceId,
      root_id: this.rootId,
      uptime_seconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      agents: this.agents?.filter((agent) => agent.status === "available").map((agent) => agent.id) || [],
      harnesses: this.agents?.filter((agent) => agent.status === "available").map((agent) => agent.id) || [],
      scheduler: this.scheduler?.snapshot() || null,
    };
  }
}

export async function daemonClient(root) {
  const paths = statePaths(root);
  const state = await readJSON(paths.daemon, null);
  if (!state?.port) throw new Error("daemon is not running");
  const token = (await readFile(paths.token, "utf8")).trim();
  const performRequest = async (pathname, options = {}) => {
    const headers = { ...options.headers, authorization: `Bearer ${token}` };
    if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
    const response = await fetch(`http://127.0.0.1:${state.port}${pathname}`, { ...options, headers });
    const contentType = response.headers.get("content-type") || "";
    const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
    const isJSONDocument = mediaType === "application/json" || mediaType.endsWith("+json");
    const payload = isJSONDocument ? await response.json() : await response.text();
    if (!response.ok) {
      const message = payload?.error?.message || `daemon request failed (${response.status})`;
      const error = new HitchError(message, {
        code: payload?.error?.code || httpErrorCode(response.status),
        exitCode: Number.isInteger(payload?.error?.exit_code)
          ? payload.error.exit_code
          : httpExitCode(response.status),
      });
      error.status = response.status;
      throw error;
    }
    return { payload, headers: response.headers, status: response.status };
  };
  const request = async (pathname, options) => (await performRequest(pathname, options)).payload;
  return { state, request, requestWithMetadata: performRequest };
}

async function acquireInstanceLock(file, instanceId) {
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
      if (error?.code !== "EEXIST") throw error;
      let existing;
      try {
        existing = JSON.parse(await readFile(file, "utf8"));
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
      const stale = `${file}.stale.${instanceId}`;
      try {
        await rename(file, stale);
        await rm(stale, { force: true });
      } catch (renameError) {
        if (renameError?.code !== "ENOENT") throw renameError;
      }
    }
  }
  throw new HitchError("could not acquire daemon root lock", { code: "daemon_lock_failed", exitCode: 12 });
}

async function releaseInstanceLock(file, instanceId) {
  let owner;
  try {
    owner = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    return;
  }
  if (owner.instance_id === instanceId) await rm(file, { force: true });
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function httpExitCode(status) {
  if (status === 400) return 2;
  if (status === 404) return 3;
  return 12;
}

function errorStatus(error) {
  if (error?.exitCode === 2) return 400;
  if (error?.exitCode === 3) return 404;
  if (error?.exitCode === 11) return 403;
  if ([4, 5, 10].includes(error?.exitCode)) return 422;
  return 500;
}

function httpErrorCode(status) {
  if (status === 400) return "invalid_input";
  if (status === 404) return "not_found";
  return "daemon_request_failed";
}

function streamFileRange(file, start, end, response) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { start, end });
    stream.once("error", reject);
    response.once("error", reject);
    response.once("finish", resolve);
    stream.pipe(response);
  });
}

async function ensureToken(file) {
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("hex");
  await writePrivateFile(file, `${token}\n`);
  return token;
}

function authorized(request, token) {
  const value = request.headers.authorization || "";
  if (!value.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBodyJSON(request, limit = 1_048_576) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw invalidInput("request body exceeds 1 MiB");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw invalidInput("invalid JSON request body");
  }
}

function json(response, status, value) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

function defaultLogger(type, fields) {
  process.stdout.write(`${new Date().toISOString()} ${type} ${JSON.stringify(fields)}\n`);
}
