import { agentEnvironmentRoleForTask, frozenDockerObservation } from "./frozen-docker-observation.js";
import path from "node:path";
import { phaseResourceContractForTask } from "./phase-resource-runtime.js";
import { bindPhaseDockerBackend, preparePhaseDockerExecution } from "./phase-docker-backend.js";
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
import { prebuiltTaskImage, prebuiltVerifierImage, prebuiltServiceImages, persistTrialEnvironmentImageExecution } from "./trial-environment-evidence.js";
import { writeTrialExecutionEvidence } from "./trial-execution-evidence.js";
import type { TrialEnvironmentImagesV1 } from "./trial-environment-evidence.js";
import { physicalRetryWorkItem } from "./physical-retry-work.js";
import { confirmPhaseResourceCleanup, phaseCleanupUnconfirmed, requiresConfirmedResourceCleanup } from "./phase-resource-cleanup.js";

export async function beginPlannedInfrastructureRetry(input: {
  options: ExecutePlannedHarborOptions;
  item: BackendWorkItemV1;
  retry: number;
  triggers: EvalTrialRefV1[];
  backendDirectory: string;
  environmentImages?: TrialEnvironmentImagesV1;
}): Promise<InfrastructureRetryLifecycle> {
  const { options } = input;
  const item = physicalRetryWorkItem(input.item, input.retry, input.triggers);
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
    if (requiresConfirmedResourceCleanup(item)) await preparePhaseDockerExecution({ root: options.root, lease: lease.current() });
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
    return retryLifecycle({ ...input, item }, lease, permit, runningAnnounced);
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
  const prebuiltImage = prebuiltTaskImage(input.environmentImages);
  const taskId = item.task_ids[0] as string;
  const epoch = lease.current().epoch;
  const runtime = runtimeResourcesForTask(options.plan, taskId, item.reservation);
  const phaseResourceContract = phaseResourceContractForTask(options.plan, item, taskId);
  const agentEnvironmentRole = agentEnvironmentRoleForTask(options.plan, taskId);
  const ownership = dockerResourceOwnership(options.root, lease.current(), taskId);
  const observer = startDockerResourceObserver({
    ...frozenDockerObservation(options.plan, taskId, ownership, { trialParent: path.join(input.backendDirectory, "job") }),
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
      return persistTrialEnvironmentImageExecution(input.backendDirectory, await observer.capture(), input.environmentImages);
    },
    backend: {
      executionResources: resourceRequirementForTask(options.plan, taskId)?.main_limits ?? options.plan.default_trial_resources,
      ...(Object.keys(runtime.sidecarLimits).length > 0 ? { dockerServiceLimits: runtime.sidecarLimits } : {}),
      ...(phaseResourceContract ? { phaseResourceContract } : {}), ...(agentEnvironmentRole ? { agentEnvironmentRole } : {}),
      dockerOwnership: ownership,
      ...(requiresConfirmedResourceCleanup(item) ? { onProcessStarting: (env: NodeJS.ProcessEnv) => bindPhaseDockerBackend({ root: options.root, lease: lease.current(), env }) } : {}),
      resolvedImages: resolvedImageMapping(item.image_refs ?? []),
      ...(prebuiltImage ? { prebuiltTaskImage: prebuiltImage } : {}),
      prebuiltServiceImages: prebuiltServiceImages(input.environmentImages),
      verifierImages: { resolvedImages: resolvedImageMapping(item.image_refs ?? [], "verifier"), prebuiltImage: prebuiltVerifierImage(input.environmentImages) },
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
  input: { options: ExecutePlannedHarborOptions; item: BackendWorkItemV1; retry: number; backendDirectory: string };
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
  const confirmedRequired = requiresConfirmedResourceCleanup(item);
  let releaseConfirmed = !confirmedRequired;
  let cleanupBlocked = false;
  let failure: unknown;
  const attempt = async (operation: () => Promise<unknown>, cleanupCritical = false): Promise<void> => {
    try { await operation(); } catch (error) { failure ??= error; if (cleanupCritical) cleanupBlocked = true; }
  };
  clearInterval(input.timer);
  await attempt(async () => writeTrialExecutionEvidence(input.input.backendDirectory, await input.observer.stop(), { evalId: options.evalId, taskId: item.task_ids[0] as string }));
  await attempt(input.heartbeatTail);
  failure ??= input.heartbeatFailure();
  if (input.processRecorded()) await attempt(() => releaseLocalDockerProcessRecord({ root: options.root, leaseId: input.lease.leaseId, epoch }), true);
  if (!confirmedRequired || !cleanupBlocked) await attempt(async () => {
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
  }, true);
  if (options.dockerResourceReaper || confirmedRequired) {
    try {
      if (confirmedRequired && cleanupBlocked) throw phaseCleanupUnconfirmed(failure);
      const report = confirmedRequired
        ? await confirmPhaseResourceCleanup({ root: options.root, lease: input.lease.current(), env: options.env,
          trialParents: [path.join(input.input.backendDirectory, "job")],
          ...(options.dockerResourceReaper ? { reaper: options.dockerResourceReaper } : {}) })
        : await options.dockerResourceReaper!({ root: options.root, leaseIds: [input.lease.leaseId], env: options.env });
      releaseConfirmed = true;
      options.sink.emit({ type: "eval.physical-retry.resources-reaped", work_id: item.work_id, lease_id: input.lease.leaseId, retry: input.input.retry, scanned: report.scanned, deleted: report.deleted.length, issues: report.issues.length });
    } catch (error) {
      options.sink.emit({ type: "eval.physical-retry.reaper-failed", work_id: item.work_id, lease_id: input.lease.leaseId, retry: input.input.retry, code: (error as { code?: string }).code || "docker_reaper_failed" });
      if (confirmedRequired) failure = phaseCleanupUnconfirmed(error);
    }
  }
  if (input.runningAnnounced && releaseConfirmed) await attempt(() => options.onWorkItemState?.(item.work_id, input.lease.leaseId, "terminal") ?? Promise.resolve());
  if (releaseConfirmed) input.permit?.release();
  if (failure !== undefined) throw failure;
}
