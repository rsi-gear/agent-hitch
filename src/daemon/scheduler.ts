import { readdir } from "node:fs/promises";
import path from "node:path";
import { createQueuedRun, executeRun, sealTerminalManifest } from "../runs/index.js";
import type { QueuedRun, RunRequestInput } from "../runs/index.js";
import { SCHEMA_VERSION, atomicWriteJSON, credentialValuesFromEnv, ensureDir, readJSON, safeDiagnosticMessage } from "../foundation/index.js";
import { cancelPlannedWorkspace, recoverInterruptedWorkspace } from "../workspaces/index.js";
import type { WorkspacePlan } from "../workspaces/index.js";
import type { ManagedInferenceCoordinator, ResolvedRevision, RunId } from "../domain/index.js";
import type { ResourceVectorV1 } from "../domain/index.js";
import { ResourceLedger, zeroResources } from "../control-plane/index.js";
import type { ResourceLease } from "../control-plane/index.js";

interface QueuedEntry {
  runId: RunId;
  directory: string;
  request: QueuedRun["request"];
  resolvedRevision: ResolvedRevision;
  workspacePlan: WorkspacePlan;
}

interface ActiveRun {
  child?: import("node:child_process").ChildProcess;
  cancel?: () => Promise<void>;
  resources?: ResourceLease;
}

export interface SchedulerOptions {
  runsRoot: string;
  root?: string;
  maxConcurrent?: number;
  onEvent?: (event: Record<string, unknown>) => void;
  resources?: ResourceLedger;
  runResources?: ResourceVectorV1;
  credentialEnv?: NodeJS.ProcessEnv;
  inferenceCoordinator?: ManagedInferenceCoordinator;
}

export class Scheduler {
  readonly runsRoot: string;
  readonly root: string;
  readonly maxConcurrent: number;
  readonly onEvent: (event: Record<string, unknown>) => void;
  readonly resources: ResourceLedger | undefined;
  readonly runResources: ResourceVectorV1;
  readonly credentialEnv: NodeJS.ProcessEnv;
  readonly inferenceCoordinator: ManagedInferenceCoordinator | undefined;
  private queue: QueuedEntry[] = [];
  private active = new Map<RunId, ActiveRun>();
  private completions = new Map<RunId, Promise<unknown>>();
  private accepting = true;
  private readonly unsubscribe: (() => void) | undefined;

  constructor({ runsRoot, root = path.dirname(runsRoot), maxConcurrent = 4, onEvent = () => {}, resources, runResources = zeroResources(), credentialEnv = process.env, inferenceCoordinator }: SchedulerOptions) {
    this.runsRoot = runsRoot;
    this.root = root;
    this.maxConcurrent = maxConcurrent;
    this.onEvent = onEvent;
    this.resources = resources;
    this.runResources = runResources;
    this.credentialEnv = credentialEnv;
    this.inferenceCoordinator = inferenceCoordinator;
    this.unsubscribe = resources?.subscribe(() => this.drain());
  }

  async initialize(): Promise<void> {
    await ensureDir(this.runsRoot);
    await this.recoverInterruptedRuns();
  }

  async submit(request: RunRequestInput): Promise<RunId> {
    if (!this.accepting) throw new Error("daemon is shutting down");
    if (this.resources && !this.resources.canEverFit(this.runResources)) throw new Error("run resource request exceeds daemon capacity");
    const queued = await createQueuedRun({ request, runsRoot: this.runsRoot, root: this.root });
    this.queue.push(queued);
    this.onEvent({ type: "run.queued", run_id: queued.runId });
    queueMicrotask(() => this.drain());
    return queued.runId;
  }

  async cancel(runId: RunId): Promise<boolean> {
    const queuedIndex = this.queue.findIndex((entry) => entry.runId === runId);
    if (queuedIndex >= 0) {
      const entry = this.queue[queuedIndex];
      if (!entry) return false;
      this.queue.splice(queuedIndex, 1);
      const now = new Date().toISOString();
      const result = {
        schema_version: SCHEMA_VERSION,
        run_id: runId,
        status: "cancelled",
        exit_code: 9,
        error: { code: "cancelled", message: "run cancelled before launch" },
        completed_at: now,
      };
      await atomicWriteJSON(path.join(entry.directory, "result.json"), result);
      const manifest = await readJSON<Record<string, unknown>>(path.join(entry.directory, "manifest.json"));
      await atomicWriteJSON(path.join(entry.directory, "manifest.json"), sealTerminalManifest(manifest, "cancelled", now));
      await cancelPlannedWorkspace({ root: this.root, runId });
      return true;
    }
    const active = this.active.get(runId);
    if (!active?.cancel) return false;
    await active.cancel();
    return true;
  }

  async status(runId: RunId): Promise<{ manifest: Record<string, unknown>; result: Record<string, unknown> | null } | null> {
    const directory = path.join(this.runsRoot, runId);
    const manifest = await readJSON<Record<string, unknown> | null>(path.join(directory, "manifest.json"), null);
    if (!manifest) return null;
    const result = await readJSON<Record<string, unknown> | null>(path.join(directory, "result.json"), null);
    return { manifest, result };
  }

  snapshot(): { queued: number; running: number; max_concurrent: number; accepting: boolean } {
    return {
      queued: this.queue.length,
      running: this.active.size,
      max_concurrent: this.maxConcurrent,
      accepting: this.accepting,
    };
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    for (const entry of [...this.queue]) await this.cancel(entry.runId);
    await Promise.all([...this.active.values()].map((run) => run.cancel?.()));
    await Promise.all([...this.completions.values()]);
    this.unsubscribe?.();
  }

  drain(): void {
    while (this.accepting && this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const candidate = this.queue[0] as QueuedEntry;
      const resources = this.resources ? this.resources.tryAcquire(candidate.runId, "run", this.runResources) : null;
      if (this.resources && !resources) break;
      const entry = this.queue.shift() as QueuedEntry;
      const controller = new AbortController();
      this.active.set(entry.runId, { ...(resources ? { resources } : {}), cancel: async () => controller.abort() });
      const completion = executeRun({
        runId: entry.runId,
        request: entry.request,
        runsRoot: this.runsRoot,
        root: this.root,
        resolvedRevision: entry.resolvedRevision,
        workspacePlan: entry.workspacePlan,
        onEvent: this.onEvent,
        ...(this.inferenceCoordinator ? { inferenceCoordinator: this.inferenceCoordinator } : {}),
        signal: controller.signal,
        onProcess: (processControl) => {
          if (processControl) this.active.set(entry.runId, {
            ...processControl,
            ...(resources ? { resources } : {}),
            cancel: async () => controller.abort(),
          });
        },
      }).catch(async (error) => {
        await this.recordUnexpectedFailure(entry, error);
        this.onEvent({ type: "scheduler.error", run_id: entry.runId, code: "scheduler_error" });
      }).finally(() => {
        this.active.delete(entry.runId);
        this.completions.delete(entry.runId);
        resources?.release();
        this.drain();
      });
      this.completions.set(entry.runId, completion);
    }
  }

  async recordUnexpectedFailure(entry: QueuedEntry, error: unknown): Promise<void> {
    const resultPath = path.join(entry.directory, "result.json");
    if (await readJSON<unknown | null>(resultPath, null)) return;
    const now = new Date().toISOString();
    const result = {
      schema_version: SCHEMA_VERSION,
      run_id: entry.runId,
      status: "failed",
      exit_code: 12,
      error: {
        code: "scheduler_error",
        message: safeDiagnosticMessage(error, credentialValuesFromEnv(entry.request.credential_names, this.credentialEnv)),
      },
      completed_at: now,
    };
    await atomicWriteJSON(resultPath, result);
    const manifestPath = path.join(entry.directory, "manifest.json");
    const manifest = await readJSON<Record<string, unknown>>(manifestPath, { schema_version: SCHEMA_VERSION, run_id: entry.runId });
    await atomicWriteJSON(manifestPath, sealTerminalManifest(manifest, "failed", now));
  }

  async recoverInterruptedRuns(): Promise<void> {
    const entries = await readdir(this.runsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("run_")) continue;
      const directory = path.join(this.runsRoot, entry.name);
      const manifestPath = path.join(directory, "manifest.json");
      const manifest = await readJSON<{ status?: string } | null>(manifestPath, null);
      const result = await readJSON<unknown | null>(path.join(directory, "result.json"), null);
      if (!manifest || result || !["queued", "preparing", "running"].includes(manifest.status || "")) continue;
      const now = new Date().toISOString();
      const recovered = {
        schema_version: SCHEMA_VERSION,
        run_id: entry.name,
        status: "failed",
        exit_code: 12,
        error: { code: "daemon_restarted", message: "daemon stopped before the run completed" },
        completed_at: now,
      };
      await atomicWriteJSON(path.join(directory, "result.json"), recovered);
      await atomicWriteJSON(manifestPath, sealTerminalManifest(manifest, "failed", now));
      await recoverInterruptedWorkspace({ root: this.root, runId: entry.name as RunId });
    }
  }
}
