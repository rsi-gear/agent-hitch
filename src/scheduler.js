import { readdir } from "node:fs/promises";
import path from "node:path";
import { createQueuedRun, executeRun } from "./engine.js";
import { atomicWriteJSON, ensureDir, readJSON } from "./fs.js";
import { SCHEMA_VERSION } from "./config.js";

export class Scheduler {
  constructor({ runsRoot, maxConcurrent = 4, onEvent = () => {} }) {
    this.runsRoot = runsRoot;
    this.maxConcurrent = maxConcurrent;
    this.onEvent = onEvent;
    this.queue = [];
    this.active = new Map();
    this.completions = new Map();
    this.accepting = true;
  }

  async initialize() {
    await ensureDir(this.runsRoot);
    await this.recoverInterruptedRuns();
  }

  async submit(request) {
    if (!this.accepting) throw new Error("daemon is shutting down");
    const queued = await createQueuedRun({ request, runsRoot: this.runsRoot });
    this.queue.push(queued);
    this.onEvent({ type: "run.queued", run_id: queued.runId });
    queueMicrotask(() => this.drain());
    return queued.runId;
  }

  async cancel(runId) {
    const queuedIndex = this.queue.findIndex((entry) => entry.runId === runId);
    if (queuedIndex >= 0) {
      const [entry] = this.queue.splice(queuedIndex, 1);
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
      const manifest = await readJSON(path.join(entry.directory, "manifest.json"));
      await atomicWriteJSON(path.join(entry.directory, "manifest.json"), { ...manifest, status: "cancelled", completed_at: now });
      return true;
    }
    const active = this.active.get(runId);
    if (!active?.cancel) return false;
    await active.cancel();
    return true;
  }

  async status(runId) {
    const directory = path.join(this.runsRoot, runId);
    const manifest = await readJSON(path.join(directory, "manifest.json"), null);
    if (!manifest) return null;
    const result = await readJSON(path.join(directory, "result.json"), null);
    return { manifest, result };
  }

  snapshot() {
    return {
      queued: this.queue.length,
      running: this.active.size,
      max_concurrent: this.maxConcurrent,
      accepting: this.accepting,
    };
  }

  async shutdown() {
    this.accepting = false;
    for (const entry of [...this.queue]) await this.cancel(entry.runId);
    await Promise.all([...this.active.values()].map((run) => run.cancel?.()));
    await Promise.all([...this.completions.values()]);
  }

  drain() {
    while (this.accepting && this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift();
      const controller = new AbortController();
      this.active.set(entry.runId, { cancel: async () => controller.abort() });
      const completion = executeRun({
        runId: entry.runId,
        request: entry.request,
        runsRoot: this.runsRoot,
        onEvent: this.onEvent,
        signal: controller.signal,
        onProcess: (processControl) => {
          if (processControl) this.active.set(entry.runId, {
            ...processControl,
            cancel: async () => controller.abort(),
          });
        },
      }).catch(async (error) => {
        await this.recordUnexpectedFailure(entry, error);
        this.onEvent({ type: "scheduler.error", run_id: entry.runId, error: error.message });
      }).finally(() => {
        this.active.delete(entry.runId);
        this.completions.delete(entry.runId);
        this.drain();
      });
      this.completions.set(entry.runId, completion);
    }
  }

  async recordUnexpectedFailure(entry, error) {
    const resultPath = path.join(entry.directory, "result.json");
    if (await readJSON(resultPath, null)) return;
    const now = new Date().toISOString();
    const result = {
      schema_version: SCHEMA_VERSION,
      run_id: entry.runId,
      status: "failed",
      exit_code: 12,
      error: { code: "scheduler_error", message: error?.message || String(error) },
      completed_at: now,
    };
    await atomicWriteJSON(resultPath, result);
    const manifestPath = path.join(entry.directory, "manifest.json");
    const manifest = await readJSON(manifestPath, { schema_version: SCHEMA_VERSION, run_id: entry.runId });
    await atomicWriteJSON(manifestPath, { ...manifest, status: "failed", completed_at: now });
  }

  async recoverInterruptedRuns() {
    const entries = await readdir(this.runsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("run_")) continue;
      const directory = path.join(this.runsRoot, entry.name);
      const manifestPath = path.join(directory, "manifest.json");
      const manifest = await readJSON(manifestPath, null);
      const result = await readJSON(path.join(directory, "result.json"), null);
      if (!manifest || result || !["queued", "running"].includes(manifest.status)) continue;
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
      await atomicWriteJSON(manifestPath, { ...manifest, status: "failed", completed_at: now });
    }
  }
}
