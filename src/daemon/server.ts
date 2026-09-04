import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Scheduler } from "./scheduler.js";
import { CollisionLockManager, EvalRerunScheduler, EvalScheduler, LocalInferenceManager, RemoteWorkerProtocol, RemoteWorkerRegistry, ResourceLedger, inspectBuild, validateResourceVector } from "../control-plane/index.js";
import type { EvalRerunExecutor, EvalSchedulerOptions } from "../control-plane/index.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, ensureDir, hitchRootId, invalidInput, readJSON, removeIfExists, statePaths } from "../foundation/index.js";
import type { StatePaths } from "../foundation/index.js";
import type { EvalId, ResourceVectorV1, RunId } from "../domain/index.js";
import { acquireInstanceLock, authorized, ensureToken, releaseInstanceLock } from "./auth.js";
import { handleRemoteWorkRoute, handleWorkerProtocolRoute } from "./worker-routes.js";
import { DaemonTelemetry } from "./telemetry.js";
import { healthParallelism, healthResources, workerHealth } from "./health.js";
import { boundedControlEvent, boundedMessage } from "./logging.js";
import { completeLineSize, isLineBoundary, streamFileRange } from "./event-stream.js";
import { defaultLogger, defaultResourceCapacity, errorStatus, httpErrorCode, json, readBodyJSON } from "./http.js";

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
  evalRerunExecutor?: EvalRerunExecutor;
  /** Test/deployment injection point; credential values remain process-local. */
  credentialEnv?: NodeJS.ProcessEnv;
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
  private evalRerunScheduler: EvalRerunScheduler | undefined;
  private resources: ResourceLedger | undefined;
  private inferenceManager: LocalInferenceManager | undefined;
  private server: ReturnType<typeof createServer> | undefined;
  private readonly remoteWorkers: RemoteWorkerRegistry;
  private readonly remoteWorkerProtocol: RemoteWorkerProtocol;
  private readonly resourceCapacity: ResourceVectorV1;
  private readonly runResources: ResourceVectorV1;
  private readonly evalTrialResources: ResourceVectorV1;
  private readonly evalExecutor: EvalSchedulerOptions["executor"] | undefined;
  private readonly evalRerunExecutor: EvalRerunExecutor | undefined;
  private readonly credentialEnv: NodeJS.ProcessEnv;
  private readonly telemetry = new DaemonTelemetry();

  constructor({ root, port, maxConcurrent, logger = defaultLogger, discoverHarnesses = async () => [], resourceCapacity, runResources, evalTrialResources, evalExecutor, evalRerunExecutor, credentialEnv }: DaemonServerOptions) {
    this.paths = statePaths(root);
    this.rootId = hitchRootId(this.paths.root);
    this.instanceId = randomBytes(16).toString("hex");
    this.port = port;
    this.maxConcurrent = maxConcurrent;
    this.logger = logger;
    this.discoverHarnesses = discoverHarnesses;
    this.resourceCapacity = validateResourceVector(resourceCapacity || defaultResourceCapacity(maxConcurrent), "daemon resource capacity");
    this.runResources = validateResourceVector(runResources || { cpu_millis: 1_000, memory_bytes: 512 * 1024 * 1024, container_slots: 0, build_slots: 0 }, "daemon run reservation");
    this.evalTrialResources = validateResourceVector(evalTrialResources || { cpu_millis: 1_000, memory_bytes: 1024 * 1024 * 1024, container_slots: 1, build_slots: 0 }, "daemon eval trial reservation");
    this.evalExecutor = evalExecutor;
    this.evalRerunExecutor = evalRerunExecutor;
    this.credentialEnv = credentialEnv ?? process.env;
    this.remoteWorkers = new RemoteWorkerRegistry({ root: this.paths.root });
    this.remoteWorkerProtocol = new RemoteWorkerProtocol({ root: this.paths.root, registry: this.remoteWorkers, ...(credentialEnv ? { credentialEnv } : {}) });
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
      await this.remoteWorkers.initialize();
      await this.remoteWorkerProtocol.initialize();
      this.agents = await this.discoverHarnesses();
      this.resources = new ResourceLedger(this.resourceCapacity);
      this.inferenceManager = new LocalInferenceManager({
        root: this.paths.root,
        resources: this.resources,
        onEvent: (event) => this.observeControlEvent(event),
      });
      await this.inferenceManager.initialize();
      this.scheduler = new Scheduler({
        runsRoot: this.paths.runs,
        root: this.paths.root,
        maxConcurrent: this.maxConcurrent,
        resources: this.resources,
        runResources: this.runResources,
        credentialEnv: this.credentialEnv,
        onEvent: (event) => this.observeRunEvent(event),
        inferenceCoordinator: this.inferenceManager,
      });
      await this.scheduler.initialize();
      const collisions = new CollisionLockManager();
      this.evalScheduler = new EvalScheduler({
        root: this.paths.root,
        resources: this.resources,
        trialResources: this.evalTrialResources,
        collisions,
        remoteWorkers: this.remoteWorkers,
        remoteWorkerProtocol: this.remoteWorkerProtocol,
        credentialEnv: this.credentialEnv,
        inferenceCoordinator: this.inferenceManager,
        ...(this.evalExecutor ? { executor: this.evalExecutor } : {}),
        onEvent: (event) => this.observeControlEvent(event),
      });
      await this.evalScheduler.initialize();
      this.evalRerunScheduler = new EvalRerunScheduler({
        root: this.paths.root,
        resources: this.resources,
        trialResources: this.evalTrialResources,
        collisions,
        ...(this.evalRerunExecutor ? { executor: this.evalRerunExecutor } : {}),
        credentialEnv: this.credentialEnv,
        inferenceCoordinator: this.inferenceManager,
        onEvent: (event) => this.observeControlEvent(event),
      });
      await this.evalRerunScheduler.initialize();

      this.server = createServer((request, response) => {
        this.handle(request, response).catch((error) => {
          this.logger("request_error", { error: boundedMessage((error as Error).message), path: boundedMessage(request.url || "", 2_048) });
          const status = errorStatus(error);
          json(response, status, {
            error: {
              code: (error as { code?: string }).code || "internal_error",
              message: boundedMessage((error as Error).message),
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
        resource_policy: this.resourcePolicy(),
      });
      this.ready = true;
      this.logger("started", { pid: process.pid, port: this.port, instance_id: this.instanceId });
      return this;
    } catch (error) {
      if (this.server?.listening) await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      await Promise.all([
        this.scheduler?.shutdown().catch(() => {}),
        this.evalScheduler?.shutdown().catch(() => {}),
        this.evalRerunScheduler?.shutdown().catch(() => {}),
        this.inferenceManager?.close().catch(() => {}),
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
      await Promise.all([this.scheduler?.shutdown(), this.evalScheduler?.shutdown(), this.evalRerunScheduler?.shutdown()]);
      await this.inferenceManager?.close();
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
      return json(response, 200, await this.health());
    }

    const workerRoute = { request, response, url, registry: this.remoteWorkers, protocol: this.remoteWorkerProtocol, adminToken: this.token || "", onEvent: (event: Record<string, unknown>) => this.observeControlEvent(event) };
    if (await handleWorkerProtocolRoute(workerRoute) || await handleRemoteWorkRoute(workerRoute)) return;

    if (!authorized(request, this.token || "")) {
      return json(response, 401, { error: { code: "unauthorized", message: "missing or invalid daemon token" } });
    }

    if (request.method === "GET" && ["/v1/harnesses", "/v1/agents"].includes(url.pathname)) {
      this.agents = await this.discoverHarnesses();
      const key = url.pathname === "/v1/agents" ? "agents" : "harnesses";
      return json(response, 200, { schema_version: SCHEMA_VERSION, [key]: this.agents });
    }
    if (request.method === "GET" && url.pathname === "/v1/workers") {
      const local = this.evalScheduler?.providerSnapshot();
      const remote = (await this.remoteWorkers.list()).map((record) => ({
        ...record.provider_status,
        generation: record.generation,
        status: record.worker.status,
        capabilities: record.worker.capabilities,
        active_leases: record.active_leases,
        ...(record.revoked_at ? { revoked_at: record.revoked_at } : {}),
      }));
      return json(response, 200, { schema_version: SCHEMA_VERSION, workers: [...(local ? [local] : []), ...remote] });
    }
    if (request.method === "GET" && url.pathname === "/v1/inference/services") {
      return json(response, 200, { schema_version: SCHEMA_VERSION, services: await this.inferenceManager?.list() ?? [] });
    }
    const inferenceStop = url.pathname.match(/^\/v1\/inference\/services\/(inference_[a-f0-9]{32})\/stop$/);
    if (request.method === "POST" && inferenceStop) {
      const body = await readBodyJSON(request);
      const force = (body as { force?: unknown }).force === true;
      await this.inferenceManager?.stop(inferenceStop[1], force);
      return json(response, 200, { schema_version: SCHEMA_VERSION, service_id: inferenceStop[1], status: "stopped" });
    }
    const buildMatch = url.pathname.match(/^\/v1\/builds\/(build_[a-f0-9]{32})$/);
    if (request.method === "GET" && buildMatch) {
      const inspected = await inspectBuild(this.paths.root, buildMatch[1] as string);
      return inspected
        ? json(response, 200, { schema_version: SCHEMA_VERSION, build_id: buildMatch[1], ...inspected })
        : json(response, 404, { error: { code: "build_not_found", message: `build not found: ${buildMatch[1]}` } });
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
      return json(response, 202, {
        schema_version: SCHEMA_VERSION,
        eval_id: evalId,
        status: "queued",
        links: {
          self: `/v1/evals/${evalId}`,
          events: `/v1/evals/${evalId}/events`,
          cancel: `/v1/evals/${evalId}/cancel`,
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/shutdown") {
      json(response, 202, { schema_version: SCHEMA_VERSION, status: "shutting_down" });
      setImmediate(() => this.close().catch((error) => this.logger("shutdown_error", { error: boundedMessage((error as Error).message) })));
      return;
    }

    const rerunsCollectionMatch = url.pathname.match(/^\/v1\/evals\/(eval_[a-f0-9]+)\/reruns$/);
    if (request.method === "POST" && rerunsCollectionMatch) {
      const evalId = rerunsCollectionMatch[1] as EvalId;
      const accepted = await this.evalRerunScheduler?.submit(evalId, await readBodyJSON(request));
      return json(response, 202, {
        schema_version: SCHEMA_VERSION,
        eval_id: accepted?.evalId,
        rerun_id: accepted?.rerunId,
        rerun_type: accepted?.rerunType,
        status: "queued",
        links: {
          self: `/v1/evals/${accepted?.evalId}/reruns/${accepted?.rerunId}`,
          events: `/v1/evals/${accepted?.evalId}/reruns/${accepted?.rerunId}/events`,
          cancel: `/v1/evals/${accepted?.evalId}/reruns/${accepted?.rerunId}/cancel`,
        },
      });
    }
    const rerunMatch = url.pathname.match(/^\/v1\/evals\/(eval_[a-f0-9]+)\/reruns\/(rerun_[a-f0-9]+)(?:\/(events|cancel))?$/);
    if (rerunMatch) {
      const [, evalId, rerunId, action] = rerunMatch;
      if (request.method === "POST" && action === "cancel") {
        const status = await this.evalRerunScheduler?.cancel(evalId as EvalId, rerunId as string);
        return json(response, 200, { schema_version: SCHEMA_VERSION, eval_id: evalId, rerun_id: rerunId, status });
      }
      if (request.method === "GET" && !action) {
        const status = await this.evalRerunScheduler?.status(evalId as EvalId, rerunId as string);
        return status
          ? json(response, 200, { schema_version: SCHEMA_VERSION, eval_id: evalId, rerun_id: rerunId, ...status })
          : json(response, 404, { error: { code: "eval_rerun_not_found", message: `eval rerun not found: ${rerunId}` } });
      }
      if (request.method === "GET" && action === "events") {
        return this.streamEvents(response, path.join(this.paths.evals, evalId as string, "reruns", rerunId as string, "events.jsonl"), url.searchParams.get("offset") || "0");
      }
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

  async health(): Promise<Record<string, unknown>> {
    const runScheduler = this.scheduler?.snapshot() || null;
    const evalScheduler = this.evalScheduler?.snapshot() || null;
    const resourceSnapshot = this.resources?.snapshot() || null;
    const remoteWorkers = await this.remoteWorkers.list().catch(() => []);
    const workers = workerHealth(
      remoteWorkers,
      this.evalScheduler?.providerSnapshot(),
      Number((evalScheduler?.work_items as { active?: unknown } | undefined)?.active ?? 0),
    );
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
      scheduler: runScheduler ? {
        ...runScheduler,
        queued_runs: runScheduler.queued,
        queued_evals: Number(evalScheduler?.queued ?? 0),
        active_work_items: Number((evalScheduler?.work_items as { active?: unknown } | undefined)?.active ?? 0),
        resources: healthResources(resourceSnapshot),
      } : null,
      eval_scheduler: evalScheduler,
      eval_rerun_scheduler: this.evalRerunScheduler?.snapshot() || null,
      resources: resourceSnapshot,
      resource_policy: this.resourcePolicy(),
      workers,
      metrics: {
        ...this.telemetry.snapshot(),
        parallelism: healthParallelism(evalScheduler),
        resources: healthResources(resourceSnapshot),
        workers,
      },
    };
  }

  private observeRunEvent(event: Record<string, unknown>): void {
    this.telemetry.observe(event);
    this.logger("event", boundedControlEvent(event));
  }

  private observeControlEvent(event: Record<string, unknown>): void {
    this.telemetry.observe(event);
    this.logger("event", boundedControlEvent(event));
  }

  private resourcePolicy(): Record<string, ResourceVectorV1> {
    return {
      capacity: { ...this.resourceCapacity },
      run: { ...this.runResources },
      eval_trial: { ...this.evalTrialResources },
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

type RunRequestInput = import("../runs/index.js").RunRequestInput;
type EvalRequestInput = import("../evals/index.js").EvalRequestInput;
