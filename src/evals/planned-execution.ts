import path from "node:path";
import type { ResolvedRevision } from "../artifacts/index.js";
import { runHarborBackend } from "../backends/index.js";
import type { HarborBackendResult, HarborPreparedArtifactUse, LocalGitTransportUse } from "../backends/index.js";
import type { ControllerRuntimeUseResult } from "../controller-runtime/index.js";
import type { BackendWorkItemV1, EvalExecutionPlanV1, EvalId, EvalProgressV1, EvalRequest, EvalTrialRefV1, ExecutionLeaseV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import { EvalEventSink } from "./events.js";
import { DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS, DEFAULT_EXECUTION_LEASE_TTL_MS, createExecutionLease } from "./execution-leases.js";
import type { ExecutionWorkerIdentity } from "./execution-leases.js";
import { recordLocalDockerProcessExit, recordLocalDockerProcessStart, releaseLocalDockerProcessRecord } from "./local-docker-provider.js";
import { dockerResourceOwnership } from "./docker-ownership.js";
import { runInfrastructureRetries } from "./infrastructure-retry.js";
import type { InfrastructureRetryRun } from "./infrastructure-retry.js";
import { beginPlannedInfrastructureRetry } from "./planned-retry-lifecycle.js";
import { mergeEvalProgressTrial, writeEvalProgress } from "./progress.js";
import { assertBackendTrialSet, localSourceBackendFailure } from "./result-helpers.js";
import { importEvalTrialRun, importEvalTrialRuns, TrialBundlePendingError, validateEvalTrialReferences } from "./trial-import.js";
import type { WorkItemAdmissionController } from "./service-types.js";
import type { EvalDockerResourceReaper } from "./service-types.js";
import type { EvalEnvironmentImageManifestLoader } from "./service-types.js";
import { resourceRequirementForTask, runtimeResourcesForTask } from "./execution-plan-resources.js";
import { startDockerResourceObserver } from "./docker-resource-observer.js";
import { resolvedImageMapping } from "./environment-image-planning.js";
import { loadTrialEnvironmentImages, verifyTrialEnvironmentImageExecution } from "./trial-environment-evidence.js";
import type { TrialEnvironmentImagesV1 } from "./trial-environment-evidence.js";

export interface PlannedBackendRun {
  attempt: number;
  workId: string;
  tasks: string[];
  refs: EvalTrialRefV1[];
  leaseId: string;
  run: HarborBackendResult;
  environmentImages?: TrialEnvironmentImagesV1;
}

export interface ExecutePlannedHarborOptions {
  evalId: EvalId;
  evalDirectory: string;
  plan: EvalExecutionPlanV1;
  progress: EvalProgressV1;
  request: EvalRequest;
  root: string;
  resolvedRevision: ResolvedRevision;
  controllerRuntime: ControllerRuntimeUseResult;
  preparedArtifact: HarborPreparedArtifactUse;
  localTransport?: LocalGitTransportUse;
  env: NodeJS.ProcessEnv;
  harborExecutable?: string;
  signal?: AbortSignal;
  trialBundleGraceMs?: number;
  sink: EvalEventSink;
  worker: ExecutionWorkerIdentity;
  admission?: WorkItemAdmissionController;
  onWorkItemState?: (workId: string, leaseId: string, state: "running" | "terminal") => Promise<void>;
  dockerResourceReaper?: EvalDockerResourceReaper;
  environmentImageManifestLoader?: EvalEnvironmentImageManifestLoader;
}

export async function executePlannedHarborTasks(options: ExecutePlannedHarborOptions): Promise<{
  progress: EvalProgressV1;
  backendRuns: PlannedBackendRun[];
  infrastructureRetryRuns: InfrastructureRetryRun[];
}> {
  assertTaskSlotPlan(options.plan);
  const publisher = new ProgressPublisher(options.progress, options);
  const semaphore = options.admission ? undefined : new FairSemaphore(options.plan.max_parallelism);
  const byTask = new Map<string, BackendWorkItemV1[]>();
  for (const item of options.plan.work_items) {
    const taskId = item.task_ids[0] as string;
    if (options.progress.trials.some((trial) => trial.task_id === taskId && trial.attempt === item.logical_attempt)) continue;
    const items = byTask.get(taskId) || [];
    items.push(item);
    byTask.set(taskId, items);
  }
  for (const items of byTask.values()) items.sort((left, right) => (left.logical_attempt as number) - (right.logical_attempt as number));
  const results: PlannedBackendRun[] = [];
  let stopDispatch = false;
  let executionFailure: unknown;
  await Promise.all([...byTask.entries()].map(async ([taskId, items]) => {
    for (const item of items) {
      if (stopDispatch || options.signal?.aborted) break;
      let release: (() => void) | undefined;
      try {
        let parentAllocationId: string | undefined;
        if (options.admission) {
          const permit = await options.admission.acquire({
            evalId: options.evalId,
            workItem: item,
            maxParallelism: options.plan.max_parallelism,
            ...(options.signal ? { signal: options.signal } : {}),
          });
          parentAllocationId = permit.allocationId;
          release = permit.release;
          options.sink.emit({
            type: "eval.work-item.admitted",
            work_id: item.work_id,
            allocation_id: permit.allocationId,
            collision_keys: permit.collisionKeys,
            reservation: item.reservation,
          });
        } else {
          release = await semaphore?.acquire(options.signal);
        }
        if (stopDispatch || options.signal?.aborted) break;
        const completed = await executeWorkItem(options, publisher, item, parentAllocationId);
        results.push(completed);
        const failed = completed.run.backend.process_exit_code !== 0 || completed.run.rawResult === null
          || Boolean(options.localTransport && localSourceBackendFailure(completed.run.rawResult));
        options.sink.emit({
          type: "eval.work-item.completed",
          work_id: item.work_id,
          lease_id: completed.leaseId,
          task_id: taskId,
          attempt: item.logical_attempt,
          process_exit_code: completed.run.backend.process_exit_code,
          result_available: completed.run.rawResult !== null,
        });
        if (failed) stopDispatch = true;
      } catch (error) {
        executionFailure ??= error;
        stopDispatch = true;
        break;
      } finally {
        release?.();
      }
    }
  }));
  await publisher.settle();
  if (executionFailure !== undefined) throw executionFailure;
  results.sort((left, right) => workOrder(options.plan, left.workId) - workOrder(options.plan, right.workId));

  const infrastructureRetryRuns: InfrastructureRetryRun[] = [];
  let progress = publisher.current();
  for (const completed of results) {
    if (options.signal?.aborted || completed.run.backend.process_exit_code !== 0 || completed.run.rawResult === null) break;
    if (options.localTransport && localSourceBackendFailure(completed.run.rawResult)) break;
    const workItem = options.plan.work_items.find((entry) => entry.work_id === completed.workId) as BackendWorkItemV1;
    const retries = await runInfrastructureRetries({
      evalId: options.evalId,
      evalDirectory: options.evalDirectory,
      backendBaseDirectory: path.join(options.evalDirectory, "harbor", "work-items", completed.workId, "infrastructure-retries"),
      logicalAttempt: completed.attempt,
      initialRefs: completed.refs,
      progress,
      request: options.request,
      root: options.root,
      resolvedRevision: options.resolvedRevision,
      controllerRuntime: options.controllerRuntime,
      preparedArtifact: options.preparedArtifact,
      executionResources: resourceRequirementForTask(options.plan, completed.tasks[0] as string)?.main_limits ?? options.plan.default_trial_resources,
      resolvedImages: resolvedImageMapping(options.plan.work_items.find((entry) => entry.work_id === completed.workId)?.image_refs ?? []),
      ...(completed.environmentImages ? { environmentImages: completed.environmentImages } : {}),
      beginRetry: ({ retry, triggers, backendDirectory }) => beginPlannedInfrastructureRetry({
        options, item: workItem, retry, triggers, backendDirectory,
        ...(completed.environmentImages ? { environmentImages: completed.environmentImages } : {}),
      }),
      ...(options.localTransport ? { localTransport: options.localTransport } : {}),
      env: options.env,
      ...(options.harborExecutable !== undefined ? { harborExecutable: options.harborExecutable } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.trialBundleGraceMs === undefined ? {} : { trialBundleGraceMs: options.trialBundleGraceMs }),
      sink: options.sink,
      ...(options.localTransport ? { stopAfterResult: localSourceBackendFailure } : {}),
    });
    progress = retries.progress;
    infrastructureRetryRuns.push(...retries.runs);
  }
  return { progress, backendRuns: results, infrastructureRetryRuns };
}

async function executeWorkItem(
  options: ExecutePlannedHarborOptions,
  publisher: ProgressPublisher,
  item: BackendWorkItemV1,
  parentAllocationId?: string,
): Promise<PlannedBackendRun> {
  const lease = await createExecutionLease({
    evalDirectory: options.evalDirectory,
    evalId: options.evalId,
    workId: item.work_id,
    worker: parentAllocationId ? { ...options.worker, parentAllocationId } : options.worker,
    reservation: item.reservation,
    ttlMs: DEFAULT_EXECUTION_LEASE_TTL_MS,
  });
  const epoch = lease.current().epoch;
  const providerProcess = { recorded: false };
  await lease.markRunning(epoch);
  await options.onWorkItemState?.(item.work_id, lease.leaseId, "running");
  options.sink.emit({
    type: "eval.work-item.started",
    work_id: item.work_id,
    lease_id: lease.leaseId,
    lease_epoch: lease.current().epoch,
    task_id: item.task_ids[0],
    attempt: item.logical_attempt,
  });
  let heartbeatFailure: unknown;
  let heartbeatTail: Promise<void> = Promise.resolve();
  const heartbeatTimer = setInterval(() => {
    if (heartbeatFailure !== undefined) return;
    heartbeatTail = heartbeatTail.then(async () => {
      const renewed = await lease.heartbeat(epoch);
      options.sink.emit({
        type: "lease.renewed",
        work_id: item.work_id,
        lease_id: lease.leaseId,
        lease_epoch: renewed.epoch,
        heartbeat_at: renewed.heartbeat_at,
        expires_at: renewed.expires_at,
      });
    }).catch((error) => { heartbeatFailure ??= error; });
  }, DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS);
  heartbeatTimer.unref();
  try {
    const completed = await executeLeasedWorkItem(options, publisher, item, lease.current(), providerProcess);
    await heartbeatTail;
    if (heartbeatFailure !== undefined) throw heartbeatFailure;
    return { ...completed, leaseId: lease.leaseId };
  } finally {
    clearInterval(heartbeatTimer);
    await heartbeatTail;
    if (providerProcess.recorded) await releaseLocalDockerProcessRecord({ root: options.root, leaseId: lease.leaseId, epoch });
    const released = await lease.release(epoch);
    options.sink.emit({
      type: "eval.work-item.lease-released",
      work_id: item.work_id,
      lease_id: lease.leaseId,
      lease_epoch: released.epoch,
      state: released.state,
    });
    if (options.dockerResourceReaper) {
      try {
        const report = await options.dockerResourceReaper({
          root: options.root,
          leaseIds: [lease.leaseId],
          env: options.env,
        });
        options.sink.emit({ type: "eval.work-item.resources-reaped", work_id: item.work_id, lease_id: lease.leaseId, scanned: report.scanned, deleted: report.deleted.length, issues: report.issues.length });
      } catch (error) {
        options.sink.emit({ type: "eval.work-item.reaper-failed", work_id: item.work_id, lease_id: lease.leaseId, code: (error as { code?: string }).code || "docker_reaper_failed" });
      }
    }
    await options.onWorkItemState?.(item.work_id, lease.leaseId, "terminal");
  }
}

async function executeLeasedWorkItem(
  options: ExecutePlannedHarborOptions,
  publisher: ProgressPublisher,
  item: BackendWorkItemV1,
  lease: ExecutionLeaseV1,
  providerProcess: { recorded: boolean },
): Promise<Omit<PlannedBackendRun, "leaseId">> {
  const logicalAttempt = item.logical_attempt as number;
  const taskId = item.task_ids[0] as string;
  const environmentImages = await loadTrialEnvironmentImages({ taskId, uses: item.image_refs ?? [], ...(options.environmentImageManifestLoader ? { loader: options.environmentImageManifestLoader } : {}) });
  const runtimeResources = runtimeResourcesForTask(options.plan, taskId, item.reservation);
  const ownership = dockerResourceOwnership(options.root, lease, taskId);
  const resourceObserver = startDockerResourceObserver({ ownership, workerId: options.worker.workerId, collisionDomainId: options.worker.collisionDomainId, reservation: item.reservation, mainLimits: runtimeResources.mainLimits, sidecarLimits: runtimeResources.sidecarLimits, env: options.env, ...(options.signal ? { signal: options.signal } : {}) });
  const backendDirectory = path.join(options.evalDirectory, "harbor", "work-items", item.work_id, `epoch-${String(lease.epoch).padStart(6, "0")}`);
  const harborJobDirectory = path.join(backendDirectory, "job");
  const refs: EvalTrialRefV1[] = [];
  const publish = async (ref: EvalTrialRefV1): Promise<void> => {
    if (ref.attempt !== logicalAttempt || ref.task_id !== taskId) {
      throw new HitchError(`Harbor work item returned an unselected trial: ${ref.task_id}#${ref.attempt}`, {
        code: "eval_work_item_trial_mismatch",
        exitCode: 12,
      });
    }
    const existing = refs.find((current) => current.trial_id === ref.trial_id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(ref)) throw new Error(`work item trial identity changed: ${ref.trial_id}`);
      return;
    }
    refs.push(ref);
    await publisher.publish(ref, item.work_id);
  };
  const run = await runHarborBackend({
    evalId: options.evalId,
    evalDirectory: options.evalDirectory,
    backendDirectory,
    logicalAttempt,
    taskNames: [taskId],
    request: { ...options.request, attempts: 1, max_concurrent: 1 },
    root: options.root,
    resolvedRevision: options.resolvedRevision,
    runtimeDirectory: options.controllerRuntime.directory,
    runtimeId: options.controllerRuntime.runtime_id,
    preparedArtifact: options.preparedArtifact,
    executionResources: runtimeResources.mainLimits,
    ...(Object.keys(runtimeResources.sidecarLimits).length > 0 ? { dockerServiceLimits: runtimeResources.sidecarLimits } : {}),
    dockerOwnership: ownership,
    resolvedImages: resolvedImageMapping(item.image_refs ?? []),
    ...(options.localTransport ? { localTransport: options.localTransport } : {}),
    env: options.env,
    ...(options.harborExecutable !== undefined ? { harborExecutable: options.harborExecutable } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.trialBundleGraceMs === undefined ? {} : { trialBundleGraceMs: options.trialBundleGraceMs }),
    ...(options.worker.provider === "local-docker" && process.platform !== "win32" ? {
      recoverableProcess: true,
      onProcessStarted: (pid: number) => recordLocalDockerProcessStart({
        root: options.root,
        workerId: options.worker.workerId,
        evalDirectory: options.evalDirectory,
        lease,
        backendDirectory,
        pid,
      }).then(() => { providerProcess.recorded = true; }),
      onProcessExited: (result: { code: number | null; signal: NodeJS.Signals | null }) => recordLocalDockerProcessExit({
        root: options.root,
        leaseId: lease.lease_id,
        epoch: lease.epoch,
        ...result,
      }).then(() => undefined),
    } : {}),
    emit: (event) => options.sink.emit({ ...event, work_id: item.work_id, task_id: taskId }),
    onTrialSettled: async (trial, context): Promise<boolean> => {
      try {
        const ref = await importEvalTrialRun({
          root: options.root,
          evalId: options.evalId,
          evalDirectory: options.evalDirectory,
          harborJobDirectory,
          expectedAttempt: logicalAttempt,
          request: options.request,
          resolvedRevision: options.resolvedRevision,
          benchmarkId: options.request.benchmark_id,
          benchmarkRevision: options.request.benchmark_revision,
          runtimeId: options.controllerRuntime.runtime_id,
          executionEvidence: verifyTrialEnvironmentImageExecution(await resourceObserver.capture(), environmentImages),
          ...(environmentImages ? { environmentImages } : {}),
          requireCompleteMarker: true,
          allowMissingBundleDiagnostic: context.bundleWaitExpired,
        }, trial, refs.length, refs);
        await publish(ref);
        return true;
      } catch (error) {
        if (error instanceof TrialBundlePendingError) return false;
        throw error;
      }
    },
  }).finally(async () => { await resourceObserver.stop(); });
  const terminalRefs = await importEvalTrialRuns({
    root: options.root,
    evalId: options.evalId,
    evalDirectory: options.evalDirectory,
    harborJobDirectory,
    expectedAttempt: logicalAttempt,
    request: options.request,
    resolvedRevision: options.resolvedRevision,
    benchmarkId: options.request.benchmark_id,
    benchmarkRevision: options.request.benchmark_revision,
    runtimeId: options.controllerRuntime.runtime_id,
    executionEvidence: verifyTrialEnvironmentImageExecution(await resourceObserver.capture(), environmentImages),
    ...(environmentImages ? { environmentImages } : {}),
    rawResult: run.rawResult,
  }, refs);
  for (const ref of terminalRefs) await publish(ref);
  if (run.rawResult !== null) assertBackendTrialSet(run.rawResult, refs);
  return { attempt: logicalAttempt, workId: item.work_id, tasks: [taskId], refs, run, ...(environmentImages ? { environmentImages } : {}) };
}

class ProgressPublisher {
  private progress: EvalProgressV1;
  private tail: Promise<void> = Promise.resolve();
  private readonly options: ExecutePlannedHarborOptions;

  constructor(progress: EvalProgressV1, options: ExecutePlannedHarborOptions) {
    this.progress = progress;
    this.options = options;
  }

  publish(ref: EvalTrialRefV1, workId: string): Promise<void> {
    const operation = this.tail.then(async () => {
      const previous = this.progress.generation;
      const next = mergeEvalProgressTrial(this.progress, ref);
      if (next.generation === previous) return;
      await validateEvalTrialReferences(this.options.root, this.options.evalId, [ref], {
        benchmarkId: this.options.request.benchmark_id,
        benchmarkRevision: this.options.request.benchmark_revision,
      });
      this.progress = next;
      await writeEvalProgress(this.options.evalDirectory, this.progress);
      this.options.sink.emit({
        type: "eval.trial.published",
        work_id: workId,
        trial_id: ref.trial_id,
        task_id: ref.task_id,
        attempt: ref.attempt,
        run_id: ref.run_id,
        observation_status: ref.observation_status,
        settled_trials: this.progress.trials.length,
        generation: this.progress.generation,
      });
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  async settle(): Promise<void> {
    await this.tail;
  }

  current(): EvalProgressV1 {
    return this.progress;
  }
}

class FairSemaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.available = capacity;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("eval work item scheduling was cancelled");
    if (this.available > 0) {
      this.available -= 1;
      return this.releaseFunction();
    }
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal?.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = () => {
        const index = this.waiters.indexOf(ready);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("eval work item scheduling was cancelled"));
      };
      this.waiters.push(ready);
      signal?.addEventListener("abort", aborted, { once: true });
    });
    return this.releaseFunction();
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.available += 1;
    };
  }
}

function assertTaskSlotPlan(plan: EvalExecutionPlanV1): void {
  if (plan.membership !== "known" || plan.work_items.length === 0
    || plan.work_items.some((item) => item.opaque_membership || item.task_ids.length !== 1 || item.slots.length !== 1
      || item.logical_attempt === null || item.requested_parallelism !== 1)) {
    throw new TypeError("planned Harbor execution requires one known trial slot per work item");
  }
}

function workOrder(plan: EvalExecutionPlanV1, workId: string): number {
  return plan.work_items.findIndex((item) => item.work_id === workId);
}
