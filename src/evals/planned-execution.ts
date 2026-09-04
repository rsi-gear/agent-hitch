import { ProgressPublisher } from "./planned-progress-publisher.js";
import path from "node:path";
import type { ResolvedRevision } from "../artifacts/index.js";
import { runHarborBackend } from "../backends/index.js";
import type { HarborBackendResult, HarborPreparedArtifactUse, LocalGitTransportUse } from "../backends/index.js";
import type { ControllerRuntimeUseResult } from "../controller-runtime/index.js";
import type { BackendWorkItemV1, EvalExecutionPlanV1, EvalId, EvalProgressV1, EvalRequest, EvalSchedulerSummaryV1, EvalTrialRefV1, ExecutionLeaseV1 } from "../domain/index.js";
import { HitchError, readJSON } from "../foundation/index.js";
import { EvalEventSink } from "./events.js";
import { DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS, DEFAULT_EXECUTION_LEASE_TTL_MS, createExecutionLease } from "./execution-leases.js";
import type { ExecutionWorkerIdentity } from "./execution-leases.js";
import { recordLocalDockerProcessExit, recordLocalDockerProcessStart, releaseLocalDockerProcessRecord } from "./local-docker-provider.js";
import { dockerResourceOwnership } from "./docker-ownership.js";
import type { InfrastructureRetryRun } from "./infrastructure-retry.js";
import { assertBackendTrialSet, localSourceBackendFailure } from "./result-helpers.js";
import { importEvalTrialRun, importEvalTrialRuns, TrialBundlePendingError } from "./trial-import.js";
import type { EvalDockerResourceReaper, EvalEnvironmentImageManifestLoader, EvalInteractionCaptureExporter, EvalRemoteWorkExecutor, WorkItemAdmissionController } from "./service-types.js";
import { executeRemotePlannedWorkItem } from "./planned-remote-execution.js";
import { runtimeResourcesForTask } from "./execution-plan-resources.js";
import { startDockerResourceObserver } from "./docker-resource-observer.js";
import { resolvedImageMapping } from "./environment-image-planning.js";
import { loadTrialEnvironmentImages, prebuiltTaskImage, verifyTrialEnvironmentImageExecution } from "./trial-environment-evidence.js";
import type { TrialEnvironmentImagesV1 } from "./trial-environment-evidence.js";
import { PrioritySemaphore, assertTaskSlotPlan, workOrder, workSchedulingPriority } from "./planned-execution-support.js";
import type { PlannedBackendRun } from "./planned-execution-support.js";
export type { PlannedBackendRun } from "./planned-execution-support.js";
import { harborPhaseTimingEvents } from "./harbor-phase-timings.js";
import { preparedArtifactForWorkItem } from "./work-item-artifacts.js";
import { recordTaskDuration } from "./duration-estimator.js";
import { classifyTrialFailure, physicalRetryAllowed } from "./failure-classifier.js";
import { EvalSchedulerMetrics } from "./scheduler-metrics.js";
import { pendingRetryWork, reconcilePersistedInitialRetryDecisions, runPlannedInfrastructureRetries, runPlannedInfrastructureRetriesFromSource } from "./planned-retry-execution.js";

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
  preparedArtifacts?: ReadonlyMap<string, HarborPreparedArtifactUse>;
  localTransport?: LocalGitTransportUse;
  env: NodeJS.ProcessEnv;
  harborExecutable?: string;
  signal?: AbortSignal;
  trialBundleGraceMs?: number;
  sink: EvalEventSink;
  worker: ExecutionWorkerIdentity;
  admission?: WorkItemAdmissionController;
  onWorkItemState?: (workId: string, leaseId: string, state: "running" | "terminal") => Promise<void>;
  onWorkItemQueued?: (workId: string) => Promise<void>;
  dockerResourceReaper?: EvalDockerResourceReaper;
  environmentImageManifestLoader?: EvalEnvironmentImageManifestLoader;
  interactionCaptureExporter?: EvalInteractionCaptureExporter;
  remoteWorkExecutor?: EvalRemoteWorkExecutor;
}

export async function executePlannedHarborTasks(options: ExecutePlannedHarborOptions): Promise<{
  progress: EvalProgressV1;
  backendRuns: PlannedBackendRun[];
  infrastructureRetryRuns: InfrastructureRetryRun[];
  schedulerSummary: EvalSchedulerSummaryV1;
}> {
  assertTaskSlotPlan(options.plan);
  const publisher = new ProgressPublisher(options.progress, options);
  const semaphore = options.admission ? undefined : new PrioritySemaphore(options.plan.max_parallelism);
  const metrics = new EvalSchedulerMetrics();
  await reconcilePersistedInitialRetryDecisions(options);
  const pendingRetriesByTask = await pendingRetryWork(options);
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
  const infrastructureRetryRuns: InfrastructureRetryRun[] = [];
  let stopDispatch = false;
  let executionFailure: unknown;
  const taskIds = [...new Set([...byTask.keys(), ...pendingRetriesByTask.keys()])];
  const taskEntries = taskIds.map((taskId) => ({
    taskId,
    items: byTask.get(taskId) ?? [],
    retries: pendingRetriesByTask.get(taskId) ?? [],
  })).sort((left, right) => workSchedulingPriority((right.items[0] ?? right.retries[0]?.item) as BackendWorkItemV1)
    - workSchedulingPriority((left.items[0] ?? left.retries[0]?.item) as BackendWorkItemV1)
    || Buffer.compare(Buffer.from(left.taskId), Buffer.from(right.taskId)));
  await Promise.all(taskEntries.map(async ({ taskId, items, retries: pendingRetries }) => {
    for (const pending of pendingRetries) {
      if (stopDispatch || options.signal?.aborted) break;
      try {
        const environmentImages = await loadTrialEnvironmentImages({
          taskId, uses: pending.item.image_refs ?? [],
          ...(options.environmentImageManifestLoader ? { loader: options.environmentImageManifestLoader } : {}),
        });
        const retries = await runPlannedInfrastructureRetriesFromSource(options, publisher, semaphore, metrics, pending.item, {
          attempt: pending.item.logical_attempt as number, workId: pending.item.work_id, tasks: [taskId], refs: [pending.trigger],
          ...(environmentImages ? { environmentImages } : {}),
        }, pending.decision.retry_index);
        infrastructureRetryRuns.push(...retries);
      } catch (error) {
        executionFailure ??= error;
        stopDispatch = true;
      }
    }
    for (const item of items) {
      if (stopDispatch || options.signal?.aborted) break;
      let release: (() => void) | undefined;
      let completed: PlannedBackendRun | undefined;
      let initialStarted = false;
      try {
        options.sink.emit({
          type: "eval.work.ready", work_id: item.work_id, slot_id: item.slots[0], task_id: taskId,
          attempt: item.logical_attempt, priority: workSchedulingPriority(item), policy: item.scheduling?.policy ?? "fifo-compat",
        });
        let parentAllocationId: string | undefined;
        if (options.admission) {
          const admissionStartedAt = Date.now();
          const permit = await options.admission.acquire({
            evalId: options.evalId,
            workItem: item,
            maxParallelism: options.plan.max_parallelism,
            ...(options.signal ? { signal: options.signal } : {}),
          });
          parentAllocationId = permit.allocationId;
          release = permit.release;
          const waitMs = Date.now() - admissionStartedAt;
          metrics.addBlocked("resource", waitMs);
          if (waitMs > 0) options.sink.emit({
            type: "eval.resource.blocked",
            work_id: item.work_id,
            duration_ms: waitMs,
            reason: "resource-or-collision-admission",
          });
          options.sink.emit({
            type: "eval.work-item.admitted",
            work_id: item.work_id,
            allocation_id: permit.allocationId,
            collision_keys: permit.collisionKeys,
            reservation: item.reservation,
          });
        } else {
          release = await semaphore?.acquire(options.signal, workSchedulingPriority(item));
        }
        if (stopDispatch || options.signal?.aborted) break;
        metrics.startWork(item.work_id, "initial");
        initialStarted = true;
        completed = await executeWorkItem(options, publisher, item, metrics, parentAllocationId);
        results.push(completed);
        if (completed.durationMs !== undefined) {
          await recordTaskDuration({
            root: options.root,
            benchmarkId: options.request.benchmark_id,
            benchmarkRevision: options.request.benchmark_revision,
            taskId,
            provider: item.provider,
            model: options.request.model,
            durationMs: completed.durationMs,
            retryableInfrastructureFailure: completed.refs.some((ref) => physicalRetryAllowed(classifyTrialFailure(ref))),
          }).catch((error) => options.sink.emit({
            type: "eval.work-duration.recording-failed",
            work_id: item.work_id,
            task_id: taskId,
            code: (error as { code?: string }).code || "duration_stats_write_failed",
          }));
        }
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
        options.sink.emit({
          type: "eval.work.completed",
          work_id: item.work_id,
          lease_id: completed.leaseId,
          task_id: taskId,
          attempt: item.logical_attempt,
          process_exit_code: completed.run.backend.process_exit_code,
          result_available: completed.run.rawResult !== null,
        });
        if (failed) stopDispatch = true;
      } catch (error) {
        options.sink.emit({
          type: "eval.work.lost",
          work_id: item.work_id,
          task_id: taskId,
          attempt: item.logical_attempt,
          code: (error as { code?: string }).code || "work_execution_failed",
        });
        executionFailure ??= error;
        stopDispatch = true;
        break;
      } finally {
        if (initialStarted) metrics.finishWork(item.work_id);
        release?.();
      }
      if (!completed || stopDispatch || options.signal?.aborted) break;
      try {
        const retries = await runPlannedInfrastructureRetries(options, publisher, semaphore, metrics, item, completed);
        infrastructureRetryRuns.push(...retries);
      } catch (error) {
        options.sink.emit({
          type: "eval.work.lost",
          work_id: item.work_id,
          task_id: taskId,
          attempt: item.logical_attempt,
          execution_kind: "physical-infrastructure-retry",
          code: (error as { code?: string }).code || "infrastructure_retry_failed",
        });
        executionFailure ??= error;
        stopDispatch = true;
        break;
      }
    }
  }));
  await publisher.settle();
  if (executionFailure !== undefined) throw executionFailure;
  results.sort((left, right) => workOrder(options.plan, left.workId) - workOrder(options.plan, right.workId));
  infrastructureRetryRuns.sort((left, right) => left.tasks.join("\0").localeCompare(right.tasks.join("\0"))
    || left.attempt - right.attempt || left.retry - right.retry);
  const schedulerSummary = metrics.summary({
    maxParallelism: options.plan.max_parallelism,
    verifierSkipped: publisher.current().trials.filter((trial) => trial.invalid_reason === "candidate_evidence_unavailable").length,
    prioritized: options.plan.work_items.some((item) => item.scheduling?.policy === "critical-path-lpt-v1"),
  });
  options.sink.emit({ type: "eval.scheduler.summary", ...schedulerSummary });
  return { progress: publisher.current(), backendRuns: results, infrastructureRetryRuns, schedulerSummary };
}

async function executeWorkItem(
  options: ExecutePlannedHarborOptions,
  publisher: ProgressPublisher,
  item: BackendWorkItemV1,
  metrics: EvalSchedulerMetrics,
  parentAllocationId?: string,
): Promise<PlannedBackendRun> {
  const startedAt = Date.now();
  if (options.remoteWorkExecutor) {
    const completed = await executeRemotePlannedWorkItem({ options, item, publish: (ref) => publisher.publish(ref, item.work_id) });
    return { ...completed, durationMs: Math.max(1, Date.now() - startedAt) };
  }
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
  options.sink.emit({
    type: "lease.offered",
    work_id: item.work_id,
    lease_id: lease.leaseId,
    lease_epoch: epoch,
    worker_id: options.worker.workerId,
  });
  await lease.markRunning(epoch);
  options.sink.emit({
    type: "lease.accepted",
    work_id: item.work_id,
    lease_id: lease.leaseId,
    lease_epoch: epoch,
    worker_id: options.worker.workerId,
  });
  await options.onWorkItemState?.(item.work_id, lease.leaseId, "running");
  options.sink.emit({
    type: "eval.work.leased",
    work_id: item.work_id,
    lease_id: lease.leaseId,
    lease_epoch: lease.current().epoch,
    reservation: item.reservation,
  });
  options.sink.emit({
    type: "eval.work-item.started",
    work_id: item.work_id,
    lease_id: lease.leaseId,
    lease_epoch: lease.current().epoch,
    task_id: item.task_ids[0],
    attempt: item.logical_attempt,
  });
  options.sink.emit({
    type: "eval.work.started",
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
    const completed = await executeLeasedWorkItem(options, publisher, item, lease.current(), providerProcess, metrics);
    await heartbeatTail;
    if (heartbeatFailure !== undefined) throw heartbeatFailure;
    return { ...completed, leaseId: lease.leaseId, durationMs: Math.max(1, Date.now() - startedAt) };
  } finally {
    clearInterval(heartbeatTimer);
    await heartbeatTail;
    if (providerProcess.recorded) await releaseLocalDockerProcessRecord({ root: options.root, leaseId: lease.leaseId, epoch });
    const released = await lease.release(epoch);
    options.sink.emit({
      type: "lease.released",
      work_id: item.work_id,
      lease_id: lease.leaseId,
      lease_epoch: released.epoch,
      worker_id: options.worker.workerId,
    });
    options.sink.emit({
      type: "eval.work-item.lease-released",
      work_id: item.work_id,
      lease_id: lease.leaseId,
      lease_epoch: released.epoch,
      state: released.state,
    });
    if (options.dockerResourceReaper) {
      options.sink.emit({ type: "sandbox.cleanup.started", work_id: item.work_id, lease_id: lease.leaseId });
      try {
        const report = await options.dockerResourceReaper({
          root: options.root,
          leaseIds: [lease.leaseId],
          env: options.env,
        });
        options.sink.emit({ type: "eval.work-item.resources-reaped", work_id: item.work_id, lease_id: lease.leaseId, scanned: report.scanned, deleted: report.deleted.length, issues: report.issues.length });
        options.sink.emit({ type: "sandbox.cleanup.completed", work_id: item.work_id, lease_id: lease.leaseId, scanned: report.scanned, deleted: report.deleted.length, residual_resources: report.issues.length });
      } catch (error) {
        options.sink.emit({ type: "eval.work-item.reaper-failed", work_id: item.work_id, lease_id: lease.leaseId, code: (error as { code?: string }).code || "docker_reaper_failed" });
        options.sink.emit({ type: "sandbox.cleanup.failed", work_id: item.work_id, lease_id: lease.leaseId, code: (error as { code?: string }).code || "docker_reaper_failed" });
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
  metrics: EvalSchedulerMetrics,
): Promise<Omit<PlannedBackendRun, "leaseId">> {
  const logicalAttempt = item.logical_attempt as number;
  const taskId = item.task_ids[0] as string;
  const environmentImages = await loadTrialEnvironmentImages({ taskId, uses: item.image_refs ?? [], ...(options.environmentImageManifestLoader ? { loader: options.environmentImageManifestLoader } : {}) });
  const runtimeResources = runtimeResourcesForTask(options.plan, taskId, item.reservation);
  const ownership = dockerResourceOwnership(options.root, lease, taskId);
  const resourceObserver = startDockerResourceObserver({ ownership, workerId: options.worker.workerId, collisionDomainId: options.worker.collisionDomainId, reservation: item.reservation, mainLimits: runtimeResources.mainLimits, sidecarLimits: runtimeResources.sidecarLimits, env: options.env, ...(options.signal ? { signal: options.signal } : {}) });
  const backendDirectory = path.join(options.evalDirectory, "harbor", "work-items", item.work_id, `epoch-${String(lease.epoch).padStart(6, "0")}`);
  const harborJobDirectory = path.join(backendDirectory, "job");
  const prebuiltImage = prebuiltTaskImage(environmentImages);
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
    if (ref.invalid_reason === "candidate_evidence_unavailable") options.sink.emit({
      type: "eval.verifier.skipped", work_id: item.work_id, trial_id: ref.trial_id, task_id: ref.task_id,
      reason: "candidate_evidence_unavailable", candidate_executes: true, verifier_executes: false,
    });
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
    preparedArtifact: preparedArtifactForWorkItem(options, item),
    ...(options.interactionCaptureExporter ? { modelProxy: options.interactionCaptureExporter.route } : {}),
    executionResources: runtimeResources.mainLimits,
    ...(Object.keys(runtimeResources.sidecarLimits).length > 0 ? { dockerServiceLimits: runtimeResources.sidecarLimits } : {}),
    dockerOwnership: ownership,
    resolvedImages: resolvedImageMapping(item.image_refs ?? []),
    ...(prebuiltImage ? { prebuiltTaskImage: prebuiltImage } : {}),
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
          env: options.env, ...(options.signal ? { signal: options.signal } : {}),
          ...(options.plan.model_capture ? { modelCapturePlan: options.plan.model_capture } : {}),
          ...(options.interactionCaptureExporter ? {
            interactionCaptureExporter: options.interactionCaptureExporter,
          } : {}),
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
  const collectionStartedAt = Date.now();
  for (const event of await harborPhaseTimingEvents(harborJobDirectory, run.rawResult)) {
    options.sink.emit(event);
    if (event.type === "eval.verifier.completed" && typeof event.duration_ms === "number") metrics.addVerifier(event.duration_ms);
  }
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
    env: options.env, ...(options.signal ? { signal: options.signal } : {}),
    ...(options.plan.model_capture ? { modelCapturePlan: options.plan.model_capture } : {}),
    ...(options.interactionCaptureExporter ? {
      interactionCaptureExporter: options.interactionCaptureExporter,
    } : {}),
    executionEvidence: verifyTrialEnvironmentImageExecution(await resourceObserver.capture(), environmentImages),
    ...(environmentImages ? { environmentImages } : {}),
    rawResult: run.rawResult,
  }, refs);
  for (const ref of terminalRefs) await publish(ref);
  options.sink.emit({ type: "eval.collection.completed", work_id: item.work_id, duration_ms: Date.now() - collectionStartedAt });
  if (run.rawResult !== null) assertBackendTrialSet(run.rawResult, refs);
  return { attempt: logicalAttempt, workId: item.work_id, tasks: [taskId], refs, run, ...(environmentImages ? { environmentImages } : {}) };
}
