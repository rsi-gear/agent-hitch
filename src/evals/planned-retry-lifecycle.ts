import type { BackendWorkItemV1, EvalTrialRefV1 } from "../domain/index.js";
import { dockerResourceOwnership } from "./docker-ownership.js";
import { startDockerResourceObserver } from "./docker-resource-observer.js";
import { DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS, DEFAULT_EXECUTION_LEASE_TTL_MS, createExecutionLease } from "./execution-leases.js";
import type { ExecutionLeaseHandle } from "./execution-leases.js";
import { resourceRequirementForTask, runtimeResourcesForTask } from "./execution-plan-resources.js";
import type { InfrastructureRetryLifecycle } from "./infrastructure-retry.js";
import { recordLocalDockerProcessExit, recordLocalDockerProcessStart, releaseLocalDockerProcessRecord } from "./local-docker-provider.js";
import type { ExecutePlannedHarborOptions } from "./planned-execution.js";
import { resolvedImageMapping } from "./environment-image-planning.js";
import { verifyTrialEnvironmentImageExecution } from "./trial-environment-evidence.js";
import type { TrialEnvironmentImagesV1 } from "./trial-environment-evidence.js";

export async function beginPlannedInfrastructureRetry(input: {
  options: ExecutePlannedHarborOptions;
  item: BackendWorkItemV1;
  retry: number;
  triggers: EvalTrialRefV1[];
  backendDirectory: string;
  environmentImages?: TrialEnvironmentImagesV1;
}): Promise<InfrastructureRetryLifecycle> {
  const { options, item } = input;
  const taskId = item.task_ids[0] as string;
  let permit: Awaited<ReturnType<NonNullable<typeof options.admission>["acquire"]>> | undefined;
  let lease: ExecutionLeaseHandle | undefined;
  let runningAnnounced = false;
  try {
    permit = await options.admission?.acquire({
      evalId: options.evalId,
      workItem: item,
      maxParallelism: options.plan.max_parallelism,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (permit) options.sink.emit({
      type: "eval.physical-retry.admitted",
      execution_kind: "physical-infrastructure-retry",
      work_id: item.work_id,
      retry: input.retry,
      allocation_id: permit.allocationId,
      collision_keys: permit.collisionKeys,
      reservation: item.reservation,
    });
    lease = await createExecutionLease({
      evalDirectory: options.evalDirectory,
      evalId: options.evalId,
      workId: item.work_id,
      worker: permit ? { ...options.worker, parentAllocationId: permit.allocationId } : options.worker,
      reservation: item.reservation,
      ttlMs: DEFAULT_EXECUTION_LEASE_TTL_MS,
    });
    const epoch = lease.current().epoch;
    await lease.markRunning(epoch);
    await options.onWorkItemState?.(item.work_id, lease.leaseId, "running");
    runningAnnounced = true;
    options.sink.emit({
      type: "eval.physical-retry.started",
      execution_kind: "physical-infrastructure-retry",
      candidate_executes: true,
      work_id: item.work_id,
      lease_id: lease.leaseId,
      lease_epoch: epoch,
      retry: input.retry,
      task_id: taskId,
      attempt: item.logical_attempt,
      trigger_trials: input.triggers.map((trial) => trial.trial_id).sort(),
    });
    return retryLifecycle(input, lease, permit, runningAnnounced);
  } catch (error) {
    if (lease) await lease.release(lease.current().epoch).catch(() => undefined);
    if (runningAnnounced) await options.onWorkItemState?.(item.work_id, lease?.leaseId ?? "", "terminal").catch(() => undefined);
    permit?.release();
    throw error;
  }
}

function retryLifecycle(
  input: {
    options: ExecutePlannedHarborOptions;
    item: BackendWorkItemV1;
    retry: number;
    backendDirectory: string;
    environmentImages?: TrialEnvironmentImagesV1;
  },
  lease: ExecutionLeaseHandle,
  permit: Awaited<ReturnType<NonNullable<ExecutePlannedHarborOptions["admission"]>["acquire"]>> | undefined,
  runningAnnounced: boolean,
): InfrastructureRetryLifecycle {
  const { options, item } = input;
  const taskId = item.task_ids[0] as string;
  const epoch = lease.current().epoch;
  const runtime = runtimeResourcesForTask(options.plan, taskId, item.reservation);
  const ownership = dockerResourceOwnership(options.root, lease.current(), taskId);
  const observer = startDockerResourceObserver({
    ownership,
    workerId: options.worker.workerId,
    collisionDomainId: options.worker.collisionDomainId,
    reservation: item.reservation,
    mainLimits: runtime.mainLimits,
    sidecarLimits: runtime.sidecarLimits,
    env: options.env,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  let processRecorded = false;
  let heartbeatFailure: unknown;
  let heartbeatTail = Promise.resolve();
  const timer = setInterval(() => {
    if (heartbeatFailure !== undefined) return;
    heartbeatTail = heartbeatTail.then(async () => {
      const renewed = await lease.heartbeat(epoch);
      options.sink.emit({
        type: "lease.renewed",
        execution_kind: "physical-infrastructure-retry",
        work_id: item.work_id,
        lease_id: lease.leaseId,
        lease_epoch: renewed.epoch,
        heartbeat_at: renewed.heartbeat_at,
        expires_at: renewed.expires_at,
      });
    }).catch((error) => { heartbeatFailure ??= error; });
  }, DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS);
  timer.unref();
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => closed ??= closeRetryLifecycle({ input, lease, permit, observer, timer, heartbeatTail: () => heartbeatTail, heartbeatFailure: () => heartbeatFailure, processRecorded: () => processRecorded, runningAnnounced });
  return {
    leaseId: lease.leaseId,
    workId: item.work_id,
    ...(input.environmentImages ? { environmentImages: input.environmentImages } : {}),
    captureExecutionEvidence: async () => {
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
      return verifyTrialEnvironmentImageExecution(await observer.capture(), input.environmentImages);
    },
    backend: {
      executionResources: resourceRequirementForTask(options.plan, taskId)?.main_limits ?? options.plan.default_trial_resources,
      ...(Object.keys(runtime.sidecarLimits).length > 0 ? { dockerServiceLimits: runtime.sidecarLimits } : {}),
      dockerOwnership: ownership,
      resolvedImages: resolvedImageMapping(item.image_refs ?? []),
      ...(options.worker.provider === "local-docker" && process.platform !== "win32" ? {
        recoverableProcess: true,
        onProcessStarted: (pid: number) => recordLocalDockerProcessStart({
          root: options.root,
          workerId: options.worker.workerId,
          evalDirectory: options.evalDirectory,
          lease: lease.current(),
          backendDirectory: input.backendDirectory,
          pid,
        }).then(() => { processRecorded = true; }),
        onProcessExited: (result: { code: number | null; signal: NodeJS.Signals | null }) => recordLocalDockerProcessExit({
          root: options.root,
          leaseId: lease.leaseId,
          epoch,
          ...result,
        }).then(() => undefined),
      } : {}),
    },
    close,
  };
}

async function closeRetryLifecycle(input: {
  input: { options: ExecutePlannedHarborOptions; item: BackendWorkItemV1; retry: number };
  lease: ExecutionLeaseHandle;
  permit: Awaited<ReturnType<NonNullable<ExecutePlannedHarborOptions["admission"]>["acquire"]>> | undefined;
  observer: ReturnType<typeof startDockerResourceObserver>;
  timer: NodeJS.Timeout;
  heartbeatTail: () => Promise<void>;
  heartbeatFailure: () => unknown;
  processRecorded: () => boolean;
  runningAnnounced: boolean;
}): Promise<void> {
  const { options, item } = input.input;
  const epoch = input.lease.current().epoch;
  let failure: unknown;
  const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
    try { await operation(); } catch (error) { failure ??= error; }
  };
  clearInterval(input.timer);
  await attempt(() => input.observer.stop());
  await attempt(input.heartbeatTail);
  failure ??= input.heartbeatFailure();
  if (input.processRecorded()) await attempt(() => releaseLocalDockerProcessRecord({ root: options.root, leaseId: input.lease.leaseId, epoch }));
  await attempt(async () => {
    const released = await input.lease.release(epoch);
    options.sink.emit({
      type: "eval.physical-retry.lease-released",
      execution_kind: "physical-infrastructure-retry",
      work_id: item.work_id,
      lease_id: input.lease.leaseId,
      lease_epoch: released.epoch,
      retry: input.input.retry,
      state: released.state,
    });
  });
  if (options.dockerResourceReaper) {
    try {
      const report = await options.dockerResourceReaper({ root: options.root, leaseIds: [input.lease.leaseId], env: options.env });
      options.sink.emit({ type: "eval.physical-retry.resources-reaped", work_id: item.work_id, lease_id: input.lease.leaseId, retry: input.input.retry, scanned: report.scanned, deleted: report.deleted.length, issues: report.issues.length });
    } catch (error) {
      options.sink.emit({ type: "eval.physical-retry.reaper-failed", work_id: item.work_id, lease_id: input.lease.leaseId, retry: input.input.retry, code: (error as { code?: string }).code || "docker_reaper_failed" });
    }
  }
  if (input.runningAnnounced) await attempt(() => options.onWorkItemState?.(item.work_id, input.lease.leaseId, "terminal") ?? Promise.resolve());
  input.permit?.release();
  if (failure !== undefined) throw failure;
}
