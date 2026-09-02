import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { EvalControlV1, EvalExecutionPolicyV1, EvalId, EvalRequest, EvalSubmissionV1, ExecutionLeaseV1, ExecutionProviderStatusV1, ExecutionWorkerV1, ModelCapturePlanV1, ResourceVectorV1 } from "../domain/index.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, credentialValuesFromEnv, ensureDir, hitchRootId, readJSON, safeDiagnosticMessage, sha256Bytes, sha256JSON, statePaths, withFileLock } from "../foundation/index.js";
import { newEvalId, parseEvalExecutionPlan, readExecutionLeases, reapOwnedDockerResources, resolveLocalDatasetTaskIds, runEval, validateEvalId } from "../evals/index.js";
import type { EvalDockerResourceReaper, EvalEnvironmentImageBuilder, EvalEnvironmentImageResolver, EvalRequestInput, EvalResult, RunEvalOptions } from "../evals/index.js";
import { ResourceLedger, scaleResources } from "./resources.js";
import type { ResourceLease } from "./resources.js";
import { CollisionLockManager } from "./collisions.js";
import type { CollisionLease } from "./collisions.js";
import { assertExecutionPolicySupported, defaultEvalExecutionPolicy, evalTaskCollisionKey, idempotencyIndexPath, isTerminalControl, normalizeEvalSubmissionInput, parseEvalControl, reconcileIdempotencyKeys, terminalControlState, validateIdempotencyKey } from "./eval-records.js";
import type { EvalSubmissionInputV1 } from "./eval-records.js";
import { WorkItemDispatcher } from "./work-dispatcher.js";
import { workItemAdmission } from "./work-admission.js";
import { localProviderStatusSnapshot, localWorkerSnapshot } from "./local-worker.js";
import { recoverPersistedEvals } from "./eval-recovery.js";
import { applyEvalPhase, applyEvalWorkItem, settleEvalWorkItems } from "./eval-control-work.js";
import { EvalImageServices } from "./eval-image-services.js";
import { writeSyntheticEvalResult } from "./synthetic-result.js";
import { RemoteWorkCoordinator } from "./remote-work-coordinator.js";
import type { RemoteWorkerProtocol } from "./remote-worker-protocol.js";
import type { RemoteWorkerRegistry } from "./remote-workers.js";
import { schedulerCapturePlan, schedulerQueuedEval } from "./scheduler-eval-entry.js";
import type { SchedulerQueuedEval } from "./scheduler-eval-entry.js";
import { emitPersistedEvalEvent, updateEvalControl } from "./eval-control-state.js";

type QueuedEval = SchedulerQueuedEval;

interface ActiveEval {
  controller: AbortController;
  lease?: ResourceLease;
  requestedParallelism: number;
  admittedParallelism: number;
  collisions?: CollisionLease;
  fineGrained: boolean;
}

export interface EvalSchedulerOptions {
  root: string;
  resources: ResourceLedger;
  trialResources: ResourceVectorV1;
  executor?: (options: RunEvalOptions) => Promise<EvalResult>;
  onEvent?: (event: Record<string, unknown>) => void;
  collisions?: CollisionLockManager;
  workerId?: string;
  provider?: string;
  collisionDomainId?: string;
  dockerResourceReaper?: EvalDockerResourceReaper;
  environmentImageResolver?: EvalEnvironmentImageResolver;
  environmentImageBuilder?: EvalEnvironmentImageBuilder;
  remoteWorkers?: RemoteWorkerRegistry;
  remoteWorkerProtocol?: RemoteWorkerProtocol;
  credentialEnv?: NodeJS.ProcessEnv;
}

export interface SubmitEvalOptions {
  idempotencyKey?: string;
}

export interface EvalSchedulerStatus {
  request: EvalRequest;
  execution: EvalExecutionPolicyV1 | null;
  control: EvalControlV1;
  progress: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  leases: ExecutionLeaseV1[];
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
  readonly workerId: string;
  readonly provider: string;
  readonly collisionDomainId: string;
  private readonly executor: (options: RunEvalOptions) => Promise<EvalResult>;
  private readonly onEvent: (event: Record<string, unknown>) => void;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeCollisions: () => void;
  private readonly collisions: CollisionLockManager;
  private readonly workItems: WorkItemDispatcher;
  private readonly dockerResourceReaper: EvalDockerResourceReaper;
  private readonly environmentImages: EvalImageServices;
  private readonly remoteWork: RemoteWorkCoordinator | undefined;
  private readonly credentialEnv: NodeJS.ProcessEnv;
  private queue: QueuedEval[] = [];
  private active = new Map<EvalId, ActiveEval>();
  private completions = new Map<EvalId, Promise<void>>();
  private accepting = true;
  private draining = false;

  constructor({ root, resources, trialResources, executor = runEval, onEvent = () => {}, collisions = new CollisionLockManager(), workerId, provider = "local-docker", collisionDomainId, dockerResourceReaper = reapOwnedDockerResources, environmentImageResolver, environmentImageBuilder, remoteWorkers, remoteWorkerProtocol, credentialEnv = process.env }: EvalSchedulerOptions) {
    this.root = root;
    this.evalsRoot = statePaths(root).evals;
    this.resources = resources;
    this.trialResources = trialResources;
    const rootHash = hitchRootId(root);
    this.workerId = workerId || `worker_${rootHash}`;
    this.provider = provider;
    this.collisionDomainId = collisionDomainId || `local-docker-root:${rootHash}`;
    this.executor = executor;
    this.onEvent = onEvent;
    this.collisions = collisions;
    this.workItems = new WorkItemDispatcher({ resources, collisions });
    this.dockerResourceReaper = dockerResourceReaper;
    this.credentialEnv = credentialEnv;
    this.environmentImages = new EvalImageServices({ root, provider, resources, onEvent: this.onEvent, ...(environmentImageResolver ? { resolver: environmentImageResolver } : {}), ...(environmentImageBuilder ? { builder: environmentImageBuilder } : {}) });
    this.remoteWork = remoteWorkers && remoteWorkerProtocol
      ? new RemoteWorkCoordinator({ root, registry: remoteWorkers, protocol: remoteWorkerProtocol, collisions })
      : undefined;
    this.unsubscribe = resources.subscribe(() => this.scheduleDrain());
    this.unsubscribeCollisions = collisions.subscribe(() => this.scheduleDrain());
  }

  async initialize(): Promise<void> {
    await ensureDir(this.evalsRoot);
    await this.recoverInterruptedEvals();
    if (this.provider === "local-docker") {
      try {
        const report = await this.dockerResourceReaper({ root: this.root });
        this.onEvent({ type: "docker.reaper.completed", root_id: report.root_id, scanned: report.scanned, deleted: report.deleted.length, issues: report.issues.length });
      } catch (error) {
        this.onEvent({ type: "docker.reaper.failed", code: (error as { code?: string }).code || "docker_reaper_failed" });
      }
    }
    this.scheduleDrain();
  }

  async submit(input: EvalSubmissionInputV1 | EvalRequestInput, options: SubmitEvalOptions = {}): Promise<EvalId> {
    if (!this.accepting) throw new HitchError("daemon is shutting down", { code: "daemon_shutting_down", exitCode: 12 });
    const normalized = await normalizeEvalSubmissionInput(input, { provider: this.provider, trialResources: this.trialResources });
    const remote = normalized.execution.provider !== this.provider;
    assertExecutionPolicySupported(normalized.execution, remote ? normalized.execution.provider : this.provider);
    if (remote && !this.remoteWork) throw new HitchError(`execution provider is unavailable: ${normalized.execution.provider}`, { code: "execution_provider_unavailable", exitCode: 10 });
    if (remote && normalized.execution.build.mode !== "backend") throw new HitchError("remote worker image prebuild is not available yet", { code: "remote_build_mode_unsupported", exitCode: 10 });
    if (remote && await resolveLocalDatasetTaskIds(normalized.request.dataset) === null) throw new HitchError("remote workers require enumerable task membership", { code: "remote_opaque_membership_unsupported", exitCode: 10 });
    const modelCapturePlan = await schedulerCapturePlan({ request: normalized.request, execution: normalized.execution, localProvider: this.provider, localStatus: this.providerSnapshot(), ...(this.remoteWork ? { remoteWork: this.remoteWork } : {}) });
    const idempotencyKey = reconcileIdempotencyKeys(normalized.idempotencyKey, options.idempotencyKey);
    const canFit = remote
      ? await (this.remoteWork as RemoteWorkCoordinator).canEverFit(normalized.execution.provider, normalized.execution.resources.default_trial)
      : this.resources.canEverFit(normalized.execution.resources.default_trial);
    if (!canFit) {
      throw new HitchError("one eval trial exceeds the daemon resource capacity", {
        code: "resource_request_unsatisfiable",
        exitCode: 10,
      });
    }
    const submissionDigest = sha256JSON({ request: normalized.request, execution: normalized.execution });
    if (idempotencyKey !== undefined) validateIdempotencyKey(idempotencyKey);
    if (idempotencyKey) {
      const keyHash = sha256Bytes(idempotencyKey);
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
        const entry = await this.persistSubmission(normalized.request, normalized.execution, modelCapturePlan, submissionDigest, keyHash);
        try {
          await atomicWriteJSON(indexPath, { schema_version: "1", eval_id: entry.evalId, submission_digest: submissionDigest });
        } catch (error) {
          await rm(entry.directory, { recursive: true, force: true });
          throw error;
        }
        return this.enqueue(entry);
      }, { timeoutCode: "idempotency_locked", timeoutExitCode: 12 });
    }
    return this.enqueue(await this.persistSubmission(normalized.request, normalized.execution, modelCapturePlan, submissionDigest));
  }

  private async persistSubmission(normalized: EvalRequest, execution: EvalExecutionPolicyV1, modelCapturePlan: ModelCapturePlanV1, submissionDigest: `sha256:${string}`, keyHash?: `sha256:${string}`): Promise<QueuedEval> {
    const evalId = newEvalId();
    const directory = path.join(this.evalsRoot, evalId);
    await mkdir(directory, { mode: 0o700 });
    try {
      const now = new Date().toISOString();
      const submission: EvalSubmissionV1 = {
        schema_version: "1",
        eval_id: evalId,
        request: normalized,
        execution,
        submission_digest: submissionDigest,
        ...(keyHash ? { idempotency_key_hash: keyHash } : {}),
        submitted_at: now,
      };
      const control: EvalControlV1 = {
        schema_version: "1",
        eval_id: evalId,
        generation: 0,
        state: "queued",
        requested_parallelism: execution.max_parallelism,
        admitted_parallelism: 0,
        active_leases: [],
        queued_work_items: [],
        terminal_work_items: [],
        created_at: now,
        updated_at: now,
      };
      await atomicWriteJSON(path.join(directory, "request.json"), normalized);
      await atomicWriteJSON(path.join(directory, "submission.json"), submission);
      await atomicWriteJSON(path.join(directory, "control.json"), control);
      await this.emitPersisted(directory, evalId, { type: "eval.queued", requested_parallelism: execution.max_parallelism, model_capture: modelCapturePlan });
      return this.queuedEval(evalId, normalized, execution, modelCapturePlan, directory);
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
    const submission = await readJSON<EvalSubmissionV1 | null>(path.join(directory, "submission.json"), null);
    const controlValue = await readJSON<unknown | null>(path.join(directory, "control.json"), null);
    if (!request || !controlValue) return null;
    const control = parseEvalControl(controlValue);
    const persistedResult = await readJSON<Record<string, unknown> | null>(path.join(directory, "result.json"), null);
    const result = isTerminalControl(control.state) ? persistedResult : null;
    const progress = await readJSON<Record<string, unknown> | null>(path.join(directory, "progress.json"), null);
    const active = this.active.get(evalId);
    const workItems = this.workItems.evalSnapshot(evalId);
    const admitted = active?.fineGrained ? workItems?.active ?? 0 : control.admitted_parallelism;
    return {
      request,
      execution: submission?.execution ?? null,
      control,
      progress,
      result,
      leases: await readExecutionLeases(directory),
      effective_parallelism: {
        requested: control.requested_parallelism,
        admitted,
        running: active ? admitted : 0,
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
      await this.emitPersisted(entry.directory, evalId, { type: "eval.cancel.requested", phase: "queued" });
      await writeSyntheticEvalResult({ directory: entry.directory, evalId: entry.evalId, request: entry.request, status: "cancelled", code: "cancelled", message: "eval cancelled before launch", completedAt: now });
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
      await this.emitPersisted(directory, evalId, { type: "eval.cancel.requested", phase: "running" });
      const control = await this.updateControl(directory, (control) => isTerminalControl(control.state) ? control : ({
        ...control,
        state: "cancelling",
        cancel_requested_at: control.cancel_requested_at || now,
      }));
      if (isTerminalControl(control.state)) return "terminal";
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
        requested_parallelism: active.requestedParallelism,
        admitted_parallelism: active.fineGrained ? this.workItems.evalSnapshot(evalId)?.active ?? 0 : active.admittedParallelism,
        ...(active.lease ? { allocation_id: active.lease.allocation.allocation_id } : {}),
        collision_keys: active.collisions?.keys ?? [],
        scheduling: active.fineGrained ? "work-item-drr-v1" : "coarse-eval-v1",
      })),
      collisions: this.collisions.snapshot(),
      work_items: this.workItems.snapshot(),
    };
  }

  workerSnapshot(): ExecutionWorkerV1 {
    return localWorkerSnapshot({ workerId: this.workerId, provider: this.provider, collisionDomainId: this.collisionDomainId, accepting: this.accepting, resources: this.resources });
  }

  providerSnapshot(): ExecutionProviderStatusV1 {
    return localProviderStatusSnapshot({ workerId: this.workerId, provider: this.provider, collisionDomainId: this.collisionDomainId, accepting: this.accepting, resources: this.resources });
  }

  async shutdown(): Promise<void> {
    if (!this.accepting && this.completions.size === 0) return;
    this.accepting = false;
    for (const entry of [...this.queue]) await this.cancel(entry.evalId);
    for (const [evalId] of this.active) await this.cancel(evalId);
    await Promise.all([...this.completions.values()]);
    this.workItems.close(); this.environmentImages.close();
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
        const { index, parallelism, lease, collisions, fineGrained } = selected;
        const [entry] = this.queue.splice(index, 1);
        if (!entry) {
          lease?.release();
          collisions?.release();
          continue;
        }
        this.start(entry, parallelism, fineGrained, lease, collisions);
      }
    } finally {
      this.draining = false;
    }
  }

  private selectRunnable(): { index: number; parallelism: number; fineGrained: boolean; lease?: ResourceLease; collisions?: CollisionLease } | null {
    for (let index = 0; index < this.queue.length; index += 1) {
      const entry = this.queue[index] as QueuedEval;
      if (entry.fineGrained) return { index, parallelism: entry.execution.max_parallelism, fineGrained: true };
      const unit = entry.execution.resources.default_trial;
      const parallelism = this.resources.maximumUnits(unit, entry.execution.max_parallelism);
      if (parallelism < 1) continue;
      const collisions = this.collisions.tryAcquire(entry.evalId, entry.collisionKeys);
      if (!collisions) continue;
      const lease = this.resources.tryAcquire(entry.evalId, "eval", scaleResources(unit, parallelism));
      if (lease) return { index, parallelism, fineGrained: false, lease, collisions };
      collisions.release();
    }
    return null;
  }

  private start(entry: QueuedEval, parallelism: number, fineGrained: boolean, lease?: ResourceLease, collisions?: CollisionLease): void {
    const controller = new AbortController();
    this.active.set(entry.evalId, { controller, requestedParallelism: entry.execution.max_parallelism, admittedParallelism: parallelism, fineGrained, ...(lease ? { lease } : {}), ...(collisions ? { collisions } : {}) });
    const completion = this.execute(entry, parallelism, fineGrained, lease, controller)
      .catch((error) => this.recordUnexpectedFailure(entry, error))
      .finally(() => {
        this.active.delete(entry.evalId);
        this.completions.delete(entry.evalId);
        lease?.release();
        collisions?.release();
        this.scheduleDrain();
      });
    this.completions.set(entry.evalId, completion);
  }

  private async execute(entry: QueuedEval, parallelism: number, fineGrained: boolean, lease: ResourceLease | undefined, controller: AbortController): Promise<void> {
    const remote = entry.execution.provider !== this.provider;
    const queuedControl = parseEvalControl(await readJSON(path.join(entry.directory, "control.json")));
    await this.emitPersisted(entry.directory, entry.evalId, {
      type: "eval.dispatch.started",
      duration_ms: Math.max(0, Date.now() - Date.parse(queuedControl.created_at)),
      requested_parallelism: entry.execution.max_parallelism,
      admitted_parallelism: fineGrained ? 0 : parallelism,
    });
    await this.updateControl(entry.directory, (control) => ({
      ...control,
      state: "planning",
      admitted_parallelism: fineGrained ? 0 : parallelism,
      active_leases: [],
      ...(lease ? { allocation_id: lease.allocation.allocation_id } : {}),
    }));
    const result = await this.executor({
      evalId: entry.evalId,
      request: entry.request,
      normalizedRequest: entry.request,
      maxConcurrentOverride: parallelism,
      executionResources: entry.execution.resources.default_trial,
      ...(entry.modelCapturePlan ? { modelCapturePlan: entry.modelCapturePlan } : {}),
      executionResourceSource: "submission-default",
      executionStrategy: "local-task-slots-v1",
      environmentBuildMode: entry.execution.build.mode,
      ...this.environmentImages.runOptions(),
      executionWorker: {
        workerId: remote ? "worker_remote_pool" : this.workerId,
        provider: entry.execution.provider,
        collisionDomainId: remote ? `remote-pool:${entry.execution.provider}` : this.collisionDomainId,
        ...(lease ? { parentAllocationId: lease.allocation.allocation_id } : {}),
      },
      ...(fineGrained && !remote ? {
        workItemAdmission: workItemAdmission({ dispatcher: this.workItems, request: entry.request, collisionDomainId: this.collisionDomainId }),
      } : {}),
      ...(remote && this.remoteWork ? { remoteWorkExecutor: this.remoteWork.execute } : {}),
      precreated: true,
      resumeExisting: entry.resumeExisting,
      root: this.root,
      env: this.credentialEnv,
      signal: controller.signal,
      onEvent: this.onEvent,
      ...(remote ? {} : { dockerResourceReaper: this.dockerResourceReaper }),
      onControlPhase: async (phase, work) => {
        await this.updateControl(entry.directory, (control) => applyEvalPhase(control, phase, work?.queuedWorkItems, work?.terminalWorkItems));
      },
      onWorkItemState: async (workId, leaseId, state) => {
        await this.updateControl(entry.directory, (control) => applyEvalWorkItem(control, workId, leaseId, state));
      },
    });
    if (!await readJSON(path.join(entry.directory, "result.json"), null)) {
      await atomicWriteJSON(path.join(entry.directory, "result.json"), result);
    }
    const state = terminalControlState(result.status);
    await this.updateControl(entry.directory, (control) => {
      const { allocation_id: _allocationId, ...released } = control;
      return {
        ...settleEvalWorkItems(released as EvalControlV1),
        state,
        admitted_parallelism: fineGrained ? 0 : parallelism,
        ...(result.error ? { error: result.error } : {}),
      };
    });
  }

  private async recordUnexpectedFailure(entry: QueuedEval, error: unknown): Promise<void> {
    const now = new Date().toISOString();
    const cancelled = this.active.get(entry.evalId)?.controller.signal.aborted === true;
    const code = cancelled ? "cancelled" : "control_plane_error";
    const message = cancelled
      ? "eval was cancelled"
      : safeDiagnosticMessage(error, credentialValuesFromEnv(entry.request.pass_env, this.credentialEnv));
    await writeSyntheticEvalResult({ directory: entry.directory, evalId: entry.evalId, request: entry.request, status: cancelled ? "cancelled" : "failed", code, message, completedAt: now });
    await this.updateControl(entry.directory, (control) => {
      const { allocation_id: _allocationId, ...released } = control;
      return { ...settleEvalWorkItems(released as EvalControlV1), state: cancelled ? "cancelled" : "failed", error: { code, message } };
    });
    this.onEvent({ type: "eval.scheduler.error", eval_id: entry.evalId, code });
  }

  private async recoverInterruptedEvals(): Promise<void> {
    const remoteWork = this.remoteWork;
    const recovered = await recoverPersistedEvals({
      root: this.root, evalsRoot: this.evalsRoot, onEvent: this.onEvent, credentialEnv: this.credentialEnv,
      ...(remoteWork ? { recoverProviderLeases: (input: Parameters<RemoteWorkCoordinator["recoverEvalLeases"]>[0]) => remoteWork.recoverEvalLeases(input) } : {}),
    });
    for (const entry of recovered) {
      const execution = entry.execution || defaultEvalExecutionPolicy(entry.request, { provider: this.provider, trialResources: this.trialResources, buildMode: "backend" });
      assertExecutionPolicySupported(execution, execution.provider === this.provider ? this.provider : execution.provider);
      if (execution.provider !== this.provider && !this.remoteWork) throw new HitchError(`execution provider is unavailable: ${execution.provider}`, { code: "execution_provider_unavailable", exitCode: 10 });
      const persistedPlan = entry.resumeExisting
        ? parseEvalExecutionPlan(await readJSON(path.join(entry.directory, "execution-plan.json")))
        : null;
      const capturePlan = persistedPlan ? persistedPlan.model_capture : await schedulerCapturePlan({ request: entry.request, execution, localProvider: this.provider, localStatus: this.providerSnapshot(), ...(this.remoteWork ? { remoteWork: this.remoteWork } : {}) });
      this.queue.push(await this.queuedEval(entry.evalId, entry.request, execution, capturePlan, entry.directory, entry.resumeExisting));
    }
  }

  private async queuedEval(evalId: EvalId, request: EvalRequest, execution: EvalExecutionPolicyV1, modelCapturePlan: ModelCapturePlanV1 | undefined, directory: string, resumeExisting = false): Promise<QueuedEval> {
    return schedulerQueuedEval({ evalId, request, execution, ...(modelCapturePlan ? { modelCapturePlan } : {}), directory, collisionDomainId: this.collisionDomainId, resumeExisting });
  }

  private async updateControl(directory: string, update: (control: EvalControlV1) => EvalControlV1): Promise<EvalControlV1> {
    return updateEvalControl(directory, update);
  }

  private async emitPersisted(directory: string, evalId: EvalId, event: Record<string, unknown>): Promise<void> {
    return emitPersistedEvalEvent(directory, evalId, this.onEvent, event);
  }
}
