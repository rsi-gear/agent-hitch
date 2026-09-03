import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { EvalExecutionPolicyV1, EvalId, EvalRequest, ResourceVectorV1 } from "../domain/index.js";
import {
  assertEvalRerunTypeSupported,
  evalRerunSemantics,
  rerunEval,
  validateEvalId,
  parseEvalExecutionPlan,
} from "../evals/index.js";
import type { EvalRerunResult, EvalRerunType, RerunEvalOptions, RerunSelector } from "../evals/index.js";
import { EvalEventSink } from "../evals/index.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, credentialValuesFromEnv, ensureDir, readJSON, safeDiagnosticMessage, statePaths } from "../foundation/index.js";
import { CollisionLockManager } from "./collisions.js";
import type { CollisionLease } from "./collisions.js";
import { defaultEvalExecutionPolicy, evalCollisionKeys, isTerminalControl, parseEvalControl, parseEvalSubmission } from "./eval-records.js";
import { ResourceLedger, scaleResources, zeroResources } from "./resources.js";
import type { ResourceLease } from "./resources.js";

import { parseEvalRerunSubmissionInput, parsePersistedSubmission, serializedSelector, validateRerunId } from "./rerun-submission.js";
import type { ParsedRerunInput } from "./rerun-submission.js";
export { parseEvalRerunSubmissionInput } from "./rerun-submission.js";

export type EvalRerunExecutor = (options: RerunEvalOptions) => Promise<EvalRerunResult>;

export interface EvalRerunSubmissionInput {
  rerun_id?: string;
  rerun_type?: EvalRerunType;
  verifier_runtime_id?: string;
  selector: RerunSelector;
}

export interface EvalRerunSchedulerOptions {
  root: string;
  resources: ResourceLedger;
  trialResources: ResourceVectorV1;
  collisions?: CollisionLockManager;
  collisionDomainId?: string;
  executor?: EvalRerunExecutor;
  onEvent?: (event: Record<string, unknown>) => void;
  credentialEnv?: NodeJS.ProcessEnv;
}

export interface EvalRerunStatus {
  submission: Record<string, unknown>;
  state: Record<string, unknown>;
  result: Record<string, unknown> | null;
}

interface QueuedRerun {
  evalId: EvalId;
  rerunId: string;
  rerunType: EvalRerunType;
  verifierRuntimeId?: string;
  selector: RerunSelector;
  request: EvalRequest;
  execution: EvalExecutionPolicyV1;
  directory: string;
  collisionKeys: string[];
}

interface ActiveRerun {
  controller: AbortController;
  resources: ResourceLease;
  collisions: CollisionLease;
}

export class EvalRerunScheduler {
  readonly root: string;
  readonly rerunsRoot: string;
  private readonly resources: ResourceLedger;
  private readonly trialResources: ResourceVectorV1;
  private readonly collisions: CollisionLockManager;
  private readonly collisionDomainId: string;
  private readonly executor: EvalRerunExecutor;
  private readonly onEvent: (event: Record<string, unknown>) => void;
  private readonly credentialEnv: NodeJS.ProcessEnv;
  private readonly unsubscribeResources: () => void;
  private readonly unsubscribeCollisions: () => void;
  private readonly queue: QueuedRerun[] = [];
  private readonly active = new Map<string, ActiveRerun>();
  private readonly completions = new Map<string, Promise<void>>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private accepting = true;
  private draining = false;

  constructor({ root, resources, trialResources, collisions = new CollisionLockManager(), collisionDomainId = "local-docker", executor = rerunEval, onEvent = () => {}, credentialEnv = process.env }: EvalRerunSchedulerOptions) {
    this.root = root;
    this.rerunsRoot = statePaths(root).evals;
    this.resources = resources;
    this.trialResources = trialResources;
    this.collisions = collisions;
    this.collisionDomainId = collisionDomainId;
    this.executor = executor;
    this.onEvent = onEvent;
    this.credentialEnv = credentialEnv;
    this.unsubscribeResources = resources.subscribe(() => this.scheduleDrain());
    this.unsubscribeCollisions = collisions.subscribe(() => this.scheduleDrain());
  }

  async initialize(): Promise<void> {
    await ensureDir(this.rerunsRoot);
    await this.recoverInterrupted();
    this.scheduleDrain();
  }

  async submit(evalIdValue: string, value: unknown): Promise<{ evalId: EvalId; rerunId: string; rerunType: EvalRerunType }> {
    if (!this.accepting) throw new HitchError("daemon is shutting down", { code: "daemon_shutting_down", exitCode: 12 });
    const evalId = validateEvalId(evalIdValue);
    const input = parseEvalRerunSubmissionInput(value);
    assertEvalRerunTypeSupported(input.rerun_type);
    const rerunId = input.rerun_id ?? `rerun_${randomUUID().replaceAll("-", "")}`;
    return this.serialize(evalId, rerunId, async () => {
      const directory = path.join(this.rerunsRoot, evalId, "reruns", rerunId);
      if (await readJSON(path.join(directory, "cancellation.json"), null)) {
        throw new HitchError("rerun identity has been cancelled", { code: "eval_rerun_cancelled", exitCode: 12 });
      }
      const existing = await readJSON<Record<string, unknown> | null>(path.join(directory, "submission.json"), null);
      if (existing) {
        const parsed = parsePersistedSubmission(existing, evalId, rerunId);
        if (parsed.rerun_type !== input.rerun_type || parsed.verifier_runtime_id !== input.verifier_runtime_id || JSON.stringify(parsed.selector) !== JSON.stringify(input.selector)) {
          throw new HitchError("rerun identity already belongs to a different request", { code: "idempotency_conflict", exitCode: 12 });
        }
        return { evalId, rerunId, rerunType: input.rerun_type };
      }
      return this.submitNew(evalId, rerunId, input);
    });
  }

  private async submitNew(evalId: EvalId, rerunId: string, input: ParsedRerunInput): Promise<{ evalId: EvalId; rerunId: string; rerunType: EvalRerunType }> {
    const source = await this.loadSource(evalId, input.rerun_type);
    if (!this.resources.canEverFit(rerunResourceUnit(input.rerun_type, source.execution.resources.default_trial))) {
      throw new HitchError("one rerun trial exceeds the daemon resource capacity", { code: "resource_request_unsatisfiable", exitCode: 10 });
    }
    const directory = path.join(this.rerunsRoot, evalId, "reruns", rerunId);
    const entry = await this.queuedEntry(evalId, rerunId, input.rerun_type, input.selector, source.request, source.execution, directory);
    if (input.verifier_runtime_id) entry.verifierRuntimeId = input.verifier_runtime_id;
    await ensureDir(path.dirname(directory));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const submittedAt = new Date().toISOString();
    try {
      await atomicWriteJSON(path.join(directory, "submission.json"), {
        schema_version: SCHEMA_VERSION,
        rerun_id: rerunId,
        eval_id: evalId,
        rerun_type: input.rerun_type,
        ...(input.verifier_runtime_id ? { verifier_runtime_id: input.verifier_runtime_id } : {}),
        semantics: evalRerunSemantics(input.rerun_type),
        selector: serializedSelector(input.selector),
        submitted_at: submittedAt,
      });
      await atomicWriteJSON(path.join(directory, "state.json"), queuedState(evalId, rerunId, input.rerun_type, submittedAt));
      await this.emit(entry, { type: "eval.rerun.queued", rerun_type: input.rerun_type, selector: serializedSelector(input.selector) });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    this.queue.push(entry);
    this.scheduleDrain();
    return { evalId, rerunId, rerunType: input.rerun_type };
  }

  /** Acknowledges only after execution, source publication and lease cleanup stop.
   * Unknown IDs are durably fenced so a delayed submission cannot launch later. */
  async cancel(evalIdValue: string, rerunId: string): Promise<string> {
    const evalId = validateEvalId(evalIdValue);
    validateRerunId(rerunId);
    return this.serialize(evalId, rerunId, async () => {
      const key = operationKey(evalId, rerunId);
      const directory = path.join(this.rerunsRoot, evalId, "reruns", rerunId);
      const status = await this.status(evalId, rerunId);
      if (status?.state.status === "failed" && (status.state.error as { code?: string })?.code === "execution_state_ambiguous") {
        throw new HitchError("cannot prove interrupted rerun execution has stopped", { code: "execution_state_ambiguous", exitCode: 12 });
      }
      const index = this.queue.findIndex(entry => entry.evalId === evalId && entry.rerunId === rerunId);
      const queued = index < 0 ? undefined : this.queue.splice(index, 1)[0];
      try {
        await ensureDir(directory);
        await atomicWriteJSON(path.join(directory, "cancellation.json"), { schema_version: SCHEMA_VERSION, eval_id: evalId, rerun_id: rerunId });
      } catch (error) {
        if (queued) { this.queue.push(queued); this.scheduleDrain(); }
        throw error;
      }
      this.active.get(key)?.controller.abort();
      await this.completions.get(key);
      const state = await readJSON<Record<string, unknown> | null>(path.join(directory, "state.json"), null);
      if (state && state.status !== "completed" && state.status !== "failed" && state.status !== "cancelled") {
        await atomicWriteJSON(path.join(directory, "state.json"), { ...state, status: "cancelled", updated_at: new Date().toISOString(), completed_at: new Date().toISOString() });
      }
      return state?.status === "completed" || state?.status === "failed" ? state.status : "cancelled";
    });
  }

  private async serialize<T>(evalId: EvalId, rerunId: string, action: () => Promise<T>): Promise<T> {
    const key = operationKey(evalId, rerunId);
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.mutations.set(key, current);
    try { return await current; }
    finally { if (this.mutations.get(key) === current) this.mutations.delete(key); }
  }

  async status(evalIdValue: string, rerunId: string): Promise<EvalRerunStatus | null> {
    const evalId = validateEvalId(evalIdValue);
    validateRerunId(rerunId);
    const directory = path.join(this.rerunsRoot, evalId, "reruns", rerunId);
    const submission = await readJSON<Record<string, unknown> | null>(path.join(directory, "submission.json"), null);
    let state = await readJSON<Record<string, unknown> | null>(path.join(directory, "state.json"), null);
    if (!submission || !state || submission.eval_id !== evalId || submission.rerun_id !== rerunId) return null;
    assertRerunStateIdentity(state, evalId, rerunId);
    // The terminal state is written before the terminal event is flushed. Do
    // not expose that narrow intermediate state through the API while this
    // scheduler still owns the completion tail.
    if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
      const completion = this.completions.get(operationKey(evalId, rerunId));
      if (completion) {
        await completion;
        state = await readJSON<Record<string, unknown>>(path.join(directory, "state.json"));
        assertRerunStateIdentity(state, evalId, rerunId);
      }
    }
    return { submission, state, result: await readJSON<Record<string, unknown> | null>(path.join(directory, "result.json"), null) };
  }

  snapshot(): Record<string, unknown> {
    return {
      queued: this.queue.length,
      running: this.active.size,
      active: [...this.active.keys()].sort(),
    };
  }

  async shutdown(): Promise<void> {
    if (!this.accepting && this.completions.size === 0) return;
    this.accepting = false;
    await Promise.allSettled([...this.mutations.values()]);
    for (const entry of this.queue.splice(0)) {
      await this.fail(entry, "daemon_shutdown", "rerun was cancelled before launch because the daemon shut down");
    }
    for (const active of this.active.values()) active.controller.abort();
    await Promise.all([...this.completions.values()]);
    this.unsubscribeResources();
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
        const [entry] = this.queue.splice(selected.index, 1);
        if (!entry) {
          selected.resources.release();
          selected.collisions.release();
          continue;
        }
        this.start(entry, selected.parallelism, selected.resources, selected.collisions);
      }
    } finally {
      this.draining = false;
    }
  }

  private selectRunnable(): { index: number; parallelism: number; resources: ResourceLease; collisions: CollisionLease } | null {
    for (let index = 0; index < this.queue.length; index += 1) {
      const entry = this.queue[index] as QueuedRerun;
      const unit = rerunResourceUnit(entry.rerunType, entry.execution.resources.default_trial);
      const parallelism = entry.rerunType === "collect-only" ? 1 : this.resources.maximumUnits(unit, entry.execution.max_parallelism);
      if (parallelism < 1) continue;
      const collisions = this.collisions.tryAcquire(operationKey(entry.evalId, entry.rerunId), entry.collisionKeys);
      if (!collisions) continue;
      const resources = this.resources.tryAcquire(operationKey(entry.evalId, entry.rerunId), "eval", scaleResources(unit, parallelism));
      if (resources) return { index, parallelism, resources, collisions };
      collisions.release();
    }
    return null;
  }

  private start(entry: QueuedRerun, parallelism: number, resources: ResourceLease, collisions: CollisionLease): void {
    const controller = new AbortController();
    const key = operationKey(entry.evalId, entry.rerunId);
    this.active.set(key, { controller, resources, collisions });
    const completion = this.execute(entry, parallelism, resources, controller)
      .catch((error) => this.fail(entry, errorCode(error), safeDiagnosticMessage(error, credentialValuesFromEnv(entry.request.pass_env, this.credentialEnv)), controller.signal.aborted ? "cancelled" : "failed"))
      .finally(() => {
        this.active.delete(key);
        this.completions.delete(key);
        resources.release();
        collisions.release();
        this.scheduleDrain();
      });
    this.completions.set(key, completion);
  }

  private async execute(entry: QueuedRerun, parallelism: number, resources: ResourceLease, controller: AbortController): Promise<void> {
    await this.mergeState(entry, {
      status: "running",
      admitted_parallelism: parallelism,
      allocation_id: resources.allocation.allocation_id,
      started_at: new Date().toISOString(),
    });
    await this.emit(entry, { type: "eval.rerun.started", rerun_type: entry.rerunType, admitted_parallelism: parallelism });
    controller.signal.throwIfAborted();
    const result = await this.executor({
      evalId: entry.evalId,
      rerunId: entry.rerunId,
      rerunType: entry.rerunType,
      ...(entry.verifierRuntimeId ? { verifierRuntimeId: entry.verifierRuntimeId } : {}),
      selector: entry.selector,
      root: this.root,
      maxConcurrentOverride: parallelism,
      executionResources: rerunResourceUnit(entry.rerunType, entry.execution.resources.default_trial),
      env: this.credentialEnv,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    await atomicWriteJSON(path.join(entry.directory, "result.json"), result);
    await this.synchronizeSourceControl(entry.evalId, result);
    await this.mergeState(entry, { status: "completed", completed_at: result.completed_at });
    await this.emit(entry, { type: "eval.rerun.completed", rerun_type: entry.rerunType, eval_status: result.eval_status });
  }

  private async fail(entry: QueuedRerun, code: string, message: string, status: "failed" | "cancelled" = "failed"): Promise<void> {
    const completedAt = new Date().toISOString();
    await this.mergeState(entry, { status, error: { code, message }, completed_at: completedAt });
    await this.emit(entry, { type: `eval.rerun.${status}`, rerun_type: entry.rerunType, code });
  }

  private async mergeState(entry: QueuedRerun, patch: Record<string, unknown>): Promise<void> {
    const state = await readJSON<Record<string, unknown>>(path.join(entry.directory, "state.json"));
    assertRerunStateIdentity(state, entry.evalId, entry.rerunId);
    const { allocation_id: _allocationId, admitted_parallelism: _admitted, ...base } = state;
    await atomicWriteJSON(path.join(entry.directory, "state.json"), { ...base, ...patch, updated_at: new Date().toISOString() });
  }

  private async emit(entry: QueuedRerun, event: Record<string, unknown>): Promise<void> {
    const sink = new EvalEventSink(entry.directory, entry.evalId, this.onEvent);
    await sink.open();
    sink.emit({ ...event, rerun_id: entry.rerunId });
    await sink.close();
  }

  private async synchronizeSourceControl(evalId: EvalId, result: EvalRerunResult): Promise<void> {
    const file = path.join(this.rerunsRoot, evalId, "control.json");
    const current = parseEvalControl(await readJSON<unknown>(file));
    if (current.eval_id !== evalId) throw new TypeError("eval control identity changed during rerun");
    const sourceResult = await readJSON<Record<string, unknown> | null>(path.join(this.rerunsRoot, evalId, "result.json"), null);
    const { error: _error, allocation_id: _allocationId, ...base } = current;
    const error = sourceResult?.error;
    const next = parseEvalControl({
      ...base,
      state: result.eval_status,
      admitted_parallelism: 0,
      ...(result.eval_status === "failed" && error && typeof error === "object" && !Array.isArray(error) ? { error } : {}),
      generation: current.generation + 1,
      updated_at: new Date().toISOString(),
    });
    await atomicWriteJSON(file, next);
  }

  private async loadSource(evalId: EvalId, rerunType: EvalRerunType): Promise<{ request: EvalRequest; execution: EvalExecutionPolicyV1 }> {
    const directory = path.join(this.rerunsRoot, evalId);
    const submissionValue = await readJSON<unknown | null>(path.join(directory, "submission.json"), null);
    const controlValue = await readJSON<unknown | null>(path.join(directory, "control.json"), null);
    if (!submissionValue || !controlValue) throw new HitchError(`eval not found: ${evalId}`, { code: "eval_not_found", exitCode: 3 });
    const submission = await parseEvalSubmission(submissionValue, evalId);
    const control = parseEvalControl(controlValue);
    if (control.eval_id !== evalId) throw new TypeError("eval control identity does not match its directory");
    const result = await readJSON<Record<string, unknown> | null>(path.join(directory, "result.json"), null);
    if (!isTerminalControl(control.state) || !result) {
      throw new HitchError("eval rerun requires a terminal source eval", { code: "eval_rerun_source_not_terminal", exitCode: 12 });
    }
    if (control.state === "cancelled" || result.status === "cancelled") {
      throw new HitchError("cancelled eval cannot be rerun", { code: "eval_rerun_cancelled", exitCode: 12 });
    }
    let execution = submission.execution || defaultEvalExecutionPolicy(submission.request, { provider: "local-docker", trialResources: this.trialResources, buildMode: "backend" });
    if (rerunType === "verifier-only") {
      const plan = parseEvalExecutionPlan(await readJSON(path.join(directory, "execution-plan.json")));
      const upper = { ...execution.resources.default_trial };
      for (const item of plan.work_items) for (const key of Object.keys(item.reservation) as Array<keyof ResourceVectorV1>) upper[key] = Math.max(upper[key] ?? 0, item.reservation[key] ?? 0);
      // Artifact regrades run serially and preserve the source resource limits.
      execution = { ...execution, max_parallelism: 1, resources: { ...execution.resources, default_trial: upper } };
    }
    return { request: submission.request, execution };
  }

  private async queuedEntry(evalId: EvalId, rerunId: string, rerunType: EvalRerunType, selector: RerunSelector, request: EvalRequest, execution: EvalExecutionPolicyV1, directory: string): Promise<QueuedRerun> {
    return {
      evalId,
      rerunId,
      rerunType,
      selector,
      request,
      execution,
      directory,
      collisionKeys: rerunType === "collect-only" ? [] : await evalCollisionKeys(request, this.collisionDomainId),
    };
  }

  private async recoverInterrupted(): Promise<void> {
    for (const evalEntry of await readdir(this.rerunsRoot, { withFileTypes: true })) {
      if (!evalEntry.isDirectory() || !/^eval_[a-f0-9]{32}$/.test(evalEntry.name)) continue;
      const reruns = path.join(this.rerunsRoot, evalEntry.name, "reruns");
      let entries;
      try { entries = await readdir(reruns, { withFileTypes: true }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^rerun_[a-f0-9]{32}$/.test(entry.name)) continue;
        const directory = path.join(reruns, entry.name);
        const state = await readJSON<Record<string, unknown> | null>(path.join(directory, "state.json"), null);
        const submission = await readJSON<Record<string, unknown> | null>(path.join(directory, "submission.json"), null);
        if (!state || !submission || !new Set(["queued", "running"]).has(String(state.status))) continue;
        const parsed = parsePersistedSubmission(submission, evalEntry.name as EvalId, entry.name);
        assertRerunStateIdentity(state, evalEntry.name as EvalId, entry.name);
        if (state.status === "queued" && await readJSON(path.join(directory, "cancellation.json"), null)) {
          await atomicWriteJSON(path.join(directory, "state.json"), { ...state, status: "cancelled", updated_at: new Date().toISOString(), completed_at: new Date().toISOString() });
          continue;
        }
        const source = await this.loadSource(evalEntry.name as EvalId, parsed.rerun_type);
        const queued = await this.queuedEntry(evalEntry.name as EvalId, entry.name, parsed.rerun_type, parsed.selector, source.request, source.execution, directory);
        if (parsed.verifier_runtime_id) queued.verifierRuntimeId = parsed.verifier_runtime_id;
        if (state.status === "queued") this.queue.push(queued);
        else await this.fail(queued, "execution_state_ambiguous", "daemon restarted while rerun execution state was ambiguous");
      }
    }
  }
}

function operationKey(evalId: EvalId, rerunId: string): string { return `${evalId}/${rerunId}`; }

function queuedState(evalId: EvalId, rerunId: string, rerunType: EvalRerunType, timestamp: string): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    rerun_id: rerunId,
    eval_id: evalId,
    rerun_type: rerunType,
    semantics: evalRerunSemantics(rerunType),
    status: "queued",
    tasks: [],
    repaired_tasks: [],
    submitted_at: timestamp,
    updated_at: timestamp,
  };
}

function assertRerunStateIdentity(state: Record<string, unknown>, evalId: EvalId, rerunId: string): void {
  if (state.schema_version !== "1" || state.eval_id !== evalId || state.rerun_id !== rerunId
    || typeof state.status !== "string" || !new Set(["queued", "running", "completed", "failed", "cancelled"]).has(state.status)) {
    throw new TypeError("eval rerun state identity is invalid");
  }
}

function errorCode(error: unknown): string {
  return error instanceof HitchError ? error.code : "eval_rerun_failed";
}

function rerunResourceUnit(type: EvalRerunType, trialResources: ResourceVectorV1): ResourceVectorV1 {
  return type === "collect-only" ? zeroResources() : trialResources;
}
