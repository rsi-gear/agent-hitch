import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { EvalExecutionPolicyV1, EvalId, EvalRequest, ResourceVectorV1 } from "../domain/index.js";
import {
  assertEvalRerunTypeSupported,
  evalRerunSemantics,
  parseEvalRerunType,
  rerunEval,
  validateEvalId,
} from "../evals/index.js";
import type { EvalRerunResult, EvalRerunType, RerunEvalOptions, RerunSelector } from "../evals/index.js";
import { EvalEventSink } from "../evals/index.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, ensureDir, invalidInput, readJSON, statePaths } from "../foundation/index.js";
import { CollisionLockManager } from "./collisions.js";
import type { CollisionLease } from "./collisions.js";
import { defaultEvalExecutionPolicy, evalCollisionKeys, isTerminalControl, parseEvalControl, parseEvalSubmission } from "./eval-records.js";
import { ResourceLedger, scaleResources, zeroResources } from "./resources.js";
import type { ResourceLease } from "./resources.js";

export type EvalRerunExecutor = (options: RerunEvalOptions) => Promise<EvalRerunResult>;

export interface EvalRerunSubmissionInput {
  rerun_type?: EvalRerunType;
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
  private readonly unsubscribeResources: () => void;
  private readonly unsubscribeCollisions: () => void;
  private readonly queue: QueuedRerun[] = [];
  private readonly active = new Map<string, ActiveRerun>();
  private readonly completions = new Map<string, Promise<void>>();
  private accepting = true;
  private draining = false;

  constructor({ root, resources, trialResources, collisions = new CollisionLockManager(), collisionDomainId = "local-docker", executor = rerunEval, onEvent = () => {} }: EvalRerunSchedulerOptions) {
    this.root = root;
    this.rerunsRoot = statePaths(root).evals;
    this.resources = resources;
    this.trialResources = trialResources;
    this.collisions = collisions;
    this.collisionDomainId = collisionDomainId;
    this.executor = executor;
    this.onEvent = onEvent;
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
    const source = await this.loadSource(evalId);
    if (!this.resources.canEverFit(rerunResourceUnit(input.rerun_type, source.execution.resources.default_trial))) {
      throw new HitchError("one rerun trial exceeds the daemon resource capacity", { code: "resource_request_unsatisfiable", exitCode: 10 });
    }
    const rerunId = `rerun_${randomUUID().replaceAll("-", "")}`;
    const directory = path.join(this.rerunsRoot, evalId, "reruns", rerunId);
    const entry = await this.queuedEntry(evalId, rerunId, input.rerun_type, input.selector, source.request, source.execution, directory);
    await ensureDir(path.dirname(directory));
    await mkdir(directory, { recursive: false, mode: 0o700 });
    const submittedAt = new Date().toISOString();
    try {
      await atomicWriteJSON(path.join(directory, "submission.json"), {
        schema_version: SCHEMA_VERSION,
        rerun_id: rerunId,
        eval_id: evalId,
        rerun_type: input.rerun_type,
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

  async status(evalIdValue: string, rerunId: string): Promise<EvalRerunStatus | null> {
    const evalId = validateEvalId(evalIdValue);
    if (!/^rerun_[a-f0-9]{32}$/.test(rerunId)) throw invalidInput("eval rerun id is invalid");
    const directory = path.join(this.rerunsRoot, evalId, "reruns", rerunId);
    const submission = await readJSON<Record<string, unknown> | null>(path.join(directory, "submission.json"), null);
    const state = await readJSON<Record<string, unknown> | null>(path.join(directory, "state.json"), null);
    if (!submission || !state || submission.eval_id !== evalId || submission.rerun_id !== rerunId) return null;
    assertRerunStateIdentity(state, evalId, rerunId);
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
      const collisions = this.collisions.tryAcquire(entry.rerunId, entry.collisionKeys);
      if (!collisions) continue;
      const resources = this.resources.tryAcquire(entry.rerunId, "eval", scaleResources(unit, parallelism));
      if (resources) return { index, parallelism, resources, collisions };
      collisions.release();
    }
    return null;
  }

  private start(entry: QueuedRerun, parallelism: number, resources: ResourceLease, collisions: CollisionLease): void {
    const controller = new AbortController();
    this.active.set(entry.rerunId, { controller, resources, collisions });
    const completion = this.execute(entry, parallelism, resources, controller)
      .catch((error) => this.fail(entry, errorCode(error), boundedMessage(error)))
      .finally(() => {
        this.active.delete(entry.rerunId);
        this.completions.delete(entry.rerunId);
        resources.release();
        collisions.release();
        this.scheduleDrain();
      });
    this.completions.set(entry.rerunId, completion);
  }

  private async execute(entry: QueuedRerun, parallelism: number, resources: ResourceLease, controller: AbortController): Promise<void> {
    await this.mergeState(entry, {
      status: "running",
      admitted_parallelism: parallelism,
      allocation_id: resources.allocation.allocation_id,
      started_at: new Date().toISOString(),
    });
    await this.emit(entry, { type: "eval.rerun.started", rerun_type: entry.rerunType, admitted_parallelism: parallelism });
    const result = await this.executor({
      evalId: entry.evalId,
      rerunId: entry.rerunId,
      rerunType: entry.rerunType,
      selector: entry.selector,
      root: this.root,
      maxConcurrentOverride: parallelism,
      executionResources: rerunResourceUnit(entry.rerunType, entry.execution.resources.default_trial),
      signal: controller.signal,
    });
    await atomicWriteJSON(path.join(entry.directory, "result.json"), result);
    await this.synchronizeSourceControl(entry.evalId, result);
    await this.mergeState(entry, { status: "completed", completed_at: result.completed_at });
    await this.emit(entry, { type: "eval.rerun.completed", rerun_type: entry.rerunType, eval_status: result.eval_status });
  }

  private async fail(entry: QueuedRerun, code: string, message: string): Promise<void> {
    const completedAt = new Date().toISOString();
    await this.mergeState(entry, { status: "failed", error: { code, message }, completed_at: completedAt });
    await this.emit(entry, { type: "eval.rerun.failed", rerun_type: entry.rerunType, code });
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

  private async loadSource(evalId: EvalId): Promise<{ request: EvalRequest; execution: EvalExecutionPolicyV1 }> {
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
    return {
      request: submission.request,
      execution: submission.execution || defaultEvalExecutionPolicy(submission.request, { provider: "local-docker", trialResources: this.trialResources, buildMode: "backend" }),
    };
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
        const source = await this.loadSource(evalEntry.name as EvalId);
        const queued = await this.queuedEntry(evalEntry.name as EvalId, entry.name, parsed.rerun_type, parsed.selector, source.request, source.execution, directory);
        if (state.status === "queued") this.queue.push(queued);
        else await this.fail(queued, "execution_state_ambiguous", "daemon restarted while rerun execution state was ambiguous");
      }
    }
  }
}

export function parseEvalRerunSubmissionInput(value: unknown): Required<EvalRerunSubmissionInput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput("eval rerun request must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "rerun_type" && key !== "selector")) throw invalidInput("eval rerun request has unknown fields");
  const rerunType = parseEvalRerunType(input.rerun_type ?? "candidate-restart");
  return { rerun_type: rerunType, selector: parseSelector(input.selector) };
}

function parsePersistedSubmission(value: Record<string, unknown>, evalId: EvalId, rerunId: string): Required<EvalRerunSubmissionInput> {
  const allowed = new Set(["schema_version", "rerun_id", "eval_id", "rerun_type", "semantics", "selector", "submitted_at"]);
  if (value.schema_version !== "1" || value.eval_id !== evalId || value.rerun_id !== rerunId
    || Object.keys(value).some((key) => !allowed.has(key))
    || typeof value.submitted_at !== "string" || !Number.isFinite(Date.parse(value.submitted_at))) {
    throw new TypeError("eval rerun submission identity is invalid");
  }
  const parsed = parseEvalRerunSubmissionInput({ rerun_type: value.rerun_type, selector: value.selector });
  if (JSON.stringify(value.semantics) !== JSON.stringify(evalRerunSemantics(parsed.rerun_type))) {
    throw new TypeError("eval rerun submission semantics do not match rerun_type");
  }
  return parsed;
}

function parseSelector(value: unknown): RerunSelector {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput("eval rerun selector must be an object");
  const selector = value as Record<string, unknown>;
  if (selector.mode === "invalid") {
    if (Object.keys(selector).some((key) => key !== "mode")) throw invalidInput("invalid selector has unknown fields");
    return { mode: "invalid" };
  }
  if (selector.mode !== "tasks" || Object.keys(selector).some((key) => key !== "mode" && key !== "task_names")
    || !Array.isArray(selector.task_names) || selector.task_names.length < 1 || selector.task_names.length > 10_000
    || selector.task_names.some((task) => typeof task !== "string" || task.length < 1 || task.length > 1_024)) {
    throw invalidInput("task selector requires 1-10000 bounded task_names");
  }
  const taskNames = selector.task_names as string[];
  if (new Set(taskNames).size !== taskNames.length) throw invalidInput("eval rerun task_names must be unique");
  return { mode: "tasks", taskNames: [...taskNames] };
}

function serializedSelector(selector: RerunSelector): Record<string, unknown> {
  return selector.mode === "invalid" ? { mode: "invalid" } : { mode: "tasks", task_names: [...selector.taskNames] };
}

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
    || typeof state.status !== "string" || !new Set(["queued", "running", "completed", "failed"]).has(state.status)) {
    throw new TypeError("eval rerun state identity is invalid");
  }
}

function errorCode(error: unknown): string {
  return error instanceof HitchError ? error.code : "eval_rerun_failed";
}

function boundedMessage(error: unknown): string {
  const message = (error as Error)?.message || String(error);
  return message.slice(0, 4_096);
}

function rerunResourceUnit(type: EvalRerunType, trialResources: ResourceVectorV1): ResourceVectorV1 {
  return type === "collect-only" ? zeroResources() : trialResources;
}
