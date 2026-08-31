import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { EvalControlV1, EvalId, EvalRequest, EvalSubmissionV1, ResourceVectorV1 } from "../domain/index.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, ensureDir, readJSON, sha256Bytes, sha256JSON, statePaths, withFileLock } from "../foundation/index.js";
import { EvalEventSink, newEvalId, runEval, validateEvalId, validateEvalRequest } from "../evals/index.js";
import type { EvalRequestInput, EvalResult, RunEvalOptions } from "../evals/index.js";
import { ResourceLedger, scaleResources } from "./resources.js";
import type { ResourceLease } from "./resources.js";
import { CollisionLockManager } from "./collisions.js";
import type { CollisionLease } from "./collisions.js";
import { evalCollisionKeys, idempotencyIndexPath, isTerminalControl, parseEvalControl, parseEvalSubmission, terminalControlState, validateIdempotencyKey } from "./eval-records.js";

interface QueuedEval {
  evalId: EvalId;
  request: EvalRequest;
  directory: string;
  collisionKeys: string[];
}

interface ActiveEval {
  controller: AbortController;
  lease: ResourceLease;
  admittedParallelism: number;
  collisions: CollisionLease;
}

export interface EvalSchedulerOptions {
  root: string;
  resources: ResourceLedger;
  trialResources: ResourceVectorV1;
  executor?: (options: RunEvalOptions) => Promise<EvalResult>;
  onEvent?: (event: Record<string, unknown>) => void;
  collisions?: CollisionLockManager;
}

export interface SubmitEvalOptions {
  idempotencyKey?: string;
}

export interface EvalSchedulerStatus {
  request: EvalRequest;
  control: EvalControlV1;
  progress: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  effective_parallelism: {
    requested: number;
    admitted: number;
    running: number;
  };
}

export type CancelEvalOutcome = "accepted" | "terminal" | "not_found" | "not_cancellable";

export class EvalScheduler {
  readonly root: string;
  readonly evalsRoot: string;
  readonly resources: ResourceLedger;
  readonly trialResources: ResourceVectorV1;
  private readonly executor: (options: RunEvalOptions) => Promise<EvalResult>;
  private readonly onEvent: (event: Record<string, unknown>) => void;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeCollisions: () => void;
  private readonly collisions: CollisionLockManager;
  private queue: QueuedEval[] = [];
  private active = new Map<EvalId, ActiveEval>();
  private completions = new Map<EvalId, Promise<void>>();
  private accepting = true;
  private draining = false;

  constructor({ root, resources, trialResources, executor = runEval, onEvent = () => {}, collisions = new CollisionLockManager() }: EvalSchedulerOptions) {
    this.root = root;
    this.evalsRoot = statePaths(root).evals;
    this.resources = resources;
    this.trialResources = trialResources;
    this.executor = executor;
    this.onEvent = onEvent;
    this.collisions = collisions;
    this.unsubscribe = resources.subscribe(() => this.scheduleDrain());
    this.unsubscribeCollisions = collisions.subscribe(() => this.scheduleDrain());
  }

  async initialize(): Promise<void> {
    await ensureDir(this.evalsRoot);
    await this.recoverInterruptedEvals();
    this.scheduleDrain();
  }

  async submit(request: EvalRequestInput, options: SubmitEvalOptions = {}): Promise<EvalId> {
    if (!this.accepting) throw new HitchError("daemon is shutting down", { code: "daemon_shutting_down", exitCode: 12 });
    const normalized = await validateEvalRequest(request);
    if (!this.resources.canEverFit(this.trialResources)) {
      throw new HitchError("one eval trial exceeds the daemon resource capacity", {
        code: "resource_request_unsatisfiable",
        exitCode: 10,
      });
    }
    const submissionDigest = sha256JSON(normalized);
    if (options.idempotencyKey !== undefined) validateIdempotencyKey(options.idempotencyKey);
    if (options.idempotencyKey) {
      const keyHash = sha256Bytes(options.idempotencyKey);
      return withFileLock(path.join(this.root, "locks", "eval-idempotency"), keyHash, async () => {
        const indexPath = idempotencyIndexPath(this.root, keyHash);
        const existing = await readJSON<{ eval_id?: unknown; submission_digest?: unknown } | null>(indexPath, null);
        if (existing) {
          if (existing.submission_digest !== submissionDigest || typeof existing.eval_id !== "string") {
            throw new HitchError("idempotency key was already used for a different eval request", {
              code: "idempotency_conflict",
              exitCode: 2,
            });
          }
          return validateEvalId(existing.eval_id);
        }
        const entry = await this.persistSubmission(normalized, submissionDigest, keyHash);
        try {
          await atomicWriteJSON(indexPath, { schema_version: "1", eval_id: entry.evalId, submission_digest: submissionDigest });
        } catch (error) {
          await rm(entry.directory, { recursive: true, force: true });
          throw error;
        }
        return this.enqueue(entry);
      }, { timeoutCode: "idempotency_locked", timeoutExitCode: 12 });
    }
    return this.enqueue(await this.persistSubmission(normalized, submissionDigest));
  }

  private async persistSubmission(normalized: EvalRequest, submissionDigest: `sha256:${string}`, keyHash?: `sha256:${string}`): Promise<QueuedEval> {
    const evalId = newEvalId();
    const directory = path.join(this.evalsRoot, evalId);
    await mkdir(directory, { mode: 0o700 });
    try {
      const now = new Date().toISOString();
      const submission: EvalSubmissionV1 = {
        schema_version: "1",
        eval_id: evalId,
        request: normalized,
        submission_digest: submissionDigest,
        ...(keyHash ? { idempotency_key_hash: keyHash } : {}),
        submitted_at: now,
      };
      const control: EvalControlV1 = {
        schema_version: "1",
        eval_id: evalId,
        generation: 0,
        state: "queued",
        requested_parallelism: normalized.max_concurrent,
        admitted_parallelism: 0,
        created_at: now,
        updated_at: now,
      };
      await atomicWriteJSON(path.join(directory, "request.json"), normalized);
      await atomicWriteJSON(path.join(directory, "submission.json"), submission);
      await atomicWriteJSON(path.join(directory, "control.json"), control);
      await this.emitPersisted(directory, evalId, { type: "eval.queued", requested_parallelism: normalized.max_concurrent });
      return { evalId, request: normalized, directory, collisionKeys: await evalCollisionKeys(normalized) };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private enqueue(entry: QueuedEval): EvalId {
    this.queue.push(entry);
    this.scheduleDrain();
    return entry.evalId;
  }

  async status(evalIdValue: string): Promise<EvalSchedulerStatus | null> {
    const evalId = validateEvalId(evalIdValue);
    const directory = path.join(this.evalsRoot, evalId);
    const request = await readJSON<EvalRequest | null>(path.join(directory, "request.json"), null);
    const controlValue = await readJSON<unknown | null>(path.join(directory, "control.json"), null);
    if (!request || !controlValue) return null;
    const control = parseEvalControl(controlValue);
    const result = await readJSON<Record<string, unknown> | null>(path.join(directory, "result.json"), null);
    const progress = await readJSON<Record<string, unknown> | null>(path.join(directory, "progress.json"), null);
    return {
      request,
      control,
      progress,
      result,
      effective_parallelism: {
        requested: control.requested_parallelism,
        admitted: control.admitted_parallelism,
        running: this.active.has(evalId) ? control.admitted_parallelism : 0,
      },
    };
  }

  async cancel(evalIdValue: string): Promise<CancelEvalOutcome> {
    const evalId = validateEvalId(evalIdValue);
    const queuedIndex = this.queue.findIndex((entry) => entry.evalId === evalId);
    if (queuedIndex >= 0) {
      const [entry] = this.queue.splice(queuedIndex, 1);
      if (!entry) return "not_cancellable";
      const now = new Date().toISOString();
      await this.writeSyntheticResult(entry, "cancelled", "cancelled", "eval cancelled before launch", now);
      await this.updateControl(entry.directory, (control) => ({
        ...control,
        state: "cancelled",
        admitted_parallelism: 0,
        cancel_requested_at: now,
      }));
      await this.emitPersisted(entry.directory, evalId, { type: "eval.cancelled", phase: "queued" });
      return "accepted";
    }
    const active = this.active.get(evalId);
    if (active) {
      const directory = path.join(this.evalsRoot, evalId);
      const now = new Date().toISOString();
      await this.updateControl(directory, (control) => ({
        ...control,
        state: "cancelling",
        cancel_requested_at: control.cancel_requested_at || now,
      }));
      active.controller.abort();
      return "accepted";
    }
    const status = await this.status(evalId).catch(() => null);
    if (!status) return "not_found";
    return isTerminalControl(status.control.state) || status.result ? "terminal" : "not_cancellable";
  }

  snapshot(): Record<string, unknown> {
    return {
      queued: this.queue.length,
      running: this.active.size,
      accepting: this.accepting,
      active: [...this.active.entries()].map(([evalId, active]) => ({
        eval_id: evalId,
        admitted_parallelism: active.admittedParallelism,
        allocation_id: active.lease.allocation.allocation_id,
        collision_keys: active.collisions.keys,
      })),
      collisions: this.collisions.snapshot(),
    };
  }

  async shutdown(): Promise<void> {
    if (!this.accepting && this.completions.size === 0) return;
    this.accepting = false;
    for (const entry of [...this.queue]) await this.cancel(entry.evalId);
    for (const [evalId] of this.active) await this.cancel(evalId);
    await Promise.all([...this.completions.values()]);
    this.unsubscribe();
    this.unsubscribeCollisions();
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    queueMicrotask(() => this.drain());
  }

  private drain(): void {
    if (this.draining || !this.accepting) return;
    this.draining = true;
    try {
      for (;;) {
        const selected = this.selectRunnable();
        if (!selected) break;
        const { index, parallelism, lease, collisions } = selected;
        const [entry] = this.queue.splice(index, 1);
        if (!entry) {
          lease.release();
          collisions.release();
          continue;
        }
        this.start(entry, parallelism, lease, collisions);
      }
    } finally {
      this.draining = false;
    }
  }

  private selectRunnable(): { index: number; parallelism: number; lease: ResourceLease; collisions: CollisionLease } | null {
    for (let index = 0; index < this.queue.length; index += 1) {
      const entry = this.queue[index] as QueuedEval;
      const parallelism = this.resources.maximumUnits(this.trialResources, entry.request.max_concurrent);
      if (parallelism < 1) continue;
      const collisions = this.collisions.tryAcquire(entry.evalId, entry.collisionKeys);
      if (!collisions) continue;
      const lease = this.resources.tryAcquire(entry.evalId, "eval", scaleResources(this.trialResources, parallelism));
      if (lease) return { index, parallelism, lease, collisions };
      collisions.release();
    }
    return null;
  }

  private start(entry: QueuedEval, parallelism: number, lease: ResourceLease, collisions: CollisionLease): void {
    const controller = new AbortController();
    this.active.set(entry.evalId, { controller, lease, admittedParallelism: parallelism, collisions });
    const completion = this.execute(entry, parallelism, lease, controller)
      .catch((error) => this.recordUnexpectedFailure(entry, error))
      .finally(() => {
        this.active.delete(entry.evalId);
        this.completions.delete(entry.evalId);
        lease.release();
        collisions.release();
        this.scheduleDrain();
      });
    this.completions.set(entry.evalId, completion);
  }

  private async execute(entry: QueuedEval, parallelism: number, lease: ResourceLease, controller: AbortController): Promise<void> {
    await this.updateControl(entry.directory, (control) => ({
      ...control,
      state: "running",
      admitted_parallelism: parallelism,
      allocation_id: lease.allocation.allocation_id,
    }));
    const result = await this.executor({
      evalId: entry.evalId,
      request: entry.request,
      normalizedRequest: entry.request,
      maxConcurrentOverride: parallelism,
      precreated: true,
      root: this.root,
      signal: controller.signal,
      onEvent: this.onEvent,
    });
    if (!await readJSON(path.join(entry.directory, "result.json"), null)) {
      await atomicWriteJSON(path.join(entry.directory, "result.json"), result);
    }
    const state = terminalControlState(result.status);
    await this.updateControl(entry.directory, (control) => {
      const { allocation_id: _allocationId, ...released } = control;
      return {
        ...released,
        state,
        admitted_parallelism: parallelism,
        ...(result.error ? { error: result.error } : {}),
      };
    });
  }

  private async recordUnexpectedFailure(entry: QueuedEval, error: unknown): Promise<void> {
    const now = new Date().toISOString();
    const cancelled = this.active.get(entry.evalId)?.controller.signal.aborted === true;
    const code = cancelled ? "cancelled" : "control_plane_error";
    const message = cancelled ? "eval was cancelled" : (error as Error)?.message || String(error);
    await this.writeSyntheticResult(entry, cancelled ? "cancelled" : "failed", code, message, now);
    await this.updateControl(entry.directory, (control) => {
      const { allocation_id: _allocationId, ...released } = control;
      return { ...released, state: cancelled ? "cancelled" : "failed", error: { code, message } };
    });
    this.onEvent({ type: "eval.scheduler.error", eval_id: entry.evalId, code });
  }

  private async recoverInterruptedEvals(): Promise<void> {
    const entries = await readdir(this.evalsRoot, { withFileTypes: true });
    for (const item of entries) {
      if (!item.isDirectory() || !/^eval_[a-f0-9]{32}$/.test(item.name)) continue;
      const evalId = item.name as EvalId;
      const directory = path.join(this.evalsRoot, evalId);
      const submissionValue = await readJSON<unknown | null>(path.join(directory, "submission.json"), null);
      const controlValue = await readJSON<unknown | null>(path.join(directory, "control.json"), null);
      if (!submissionValue || !controlValue) continue;
      const submission = await parseEvalSubmission(submissionValue, evalId);
      const control = parseEvalControl(controlValue);
      const result = await readJSON<Record<string, unknown> | null>(path.join(directory, "result.json"), null);
      if (result) {
        if (!isTerminalControl(control.state)) {
          await this.updateControl(directory, (current) => {
            const { allocation_id: _allocationId, ...released } = current;
            return { ...released, state: terminalControlState(result.status) };
          });
        }
        continue;
      }
      if (control.state === "queued") {
        this.queue.push({ evalId, request: submission.request, directory, collisionKeys: await evalCollisionKeys(submission.request) });
        continue;
      }
      if (isTerminalControl(control.state)) continue;
      const cancelled = control.state === "cancelling";
      const now = new Date().toISOString();
      const entry = { evalId, request: submission.request, directory, collisionKeys: await evalCollisionKeys(submission.request) };
      const code = cancelled ? "cancelled" : "execution_state_ambiguous";
      const message = cancelled ? "eval cancellation was recovered after daemon restart" : "daemon restarted while eval execution state was ambiguous";
      await this.writeSyntheticResult(entry, cancelled ? "cancelled" : "failed", code, message, now);
      await this.updateControl(directory, (current) => {
        const { allocation_id: _allocationId, ...released } = current;
        return { ...released, state: cancelled ? "cancelled" : "failed", error: { code, message } };
      });
      await this.emitPersisted(directory, evalId, { type: "eval.recovered", status: cancelled ? "cancelled" : "failed", code });
    }
  }

  private async writeSyntheticResult(entry: QueuedEval, status: "failed" | "cancelled", code: string, message: string, completedAt: string): Promise<void> {
    if (await readJSON(path.join(entry.directory, "result.json"), null)) return;
    const control = parseEvalControl(await readJSON(path.join(entry.directory, "control.json")));
    await atomicWriteJSON(path.join(entry.directory, "result.json"), {
      schema_version: SCHEMA_VERSION,
      eval_id: entry.evalId,
      status,
      exit_code: status === "cancelled" ? 9 : 12,
      error: { code, message },
      benchmark_id: entry.request.benchmark_id,
      benchmark_revision: entry.request.benchmark_revision,
      trials: [],
      started_at: control.created_at,
      completed_at: completedAt,
    });
  }

  private async updateControl(directory: string, update: (control: EvalControlV1) => EvalControlV1): Promise<EvalControlV1> {
    const current = parseEvalControl(await readJSON(path.join(directory, "control.json")));
    const next = parseEvalControl({
      ...update(current),
      schema_version: "1",
      eval_id: current.eval_id,
      generation: current.generation + 1,
      created_at: current.created_at,
      updated_at: new Date().toISOString(),
    });
    await atomicWriteJSON(path.join(directory, "control.json"), next);
    return next;
  }

  private async emitPersisted(directory: string, evalId: EvalId, event: Record<string, unknown>): Promise<void> {
    const sink = new EvalEventSink(directory, evalId, this.onEvent);
    await sink.open();
    sink.emit(event);
    await sink.close();
  }
}
