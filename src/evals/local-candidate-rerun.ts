import { agentEnvironmentRoleForTask, frozenDockerObservation } from "./frozen-docker-observation.js";
import path from "node:path";
import { processWorkItemAdmission } from "./process-resource-profiling.js";
import type { RunHarborBackendOptions } from "../backends/index.js";
import type { EvalExecutionPlanV1 } from "../domain/index.js";
import { HitchError, atomicWriteJSON } from "../foundation/index.js";
import { dockerResourceOwnership } from "./docker-ownership.js";
import { confirmPhaseResourceCleanup } from "./phase-resource-cleanup.js";
import { bindPhaseDockerBackend, preparePhaseDockerExecution } from "./phase-docker-backend.js";
import { startDockerResourceObserver } from "./docker-resource-observer.js";
import { resolvedImageMapping } from "./environment-image-planning.js";
import { createExecutionLease, DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS, DEFAULT_EXECUTION_LEASE_TTL_MS } from "./execution-leases.js";
import { runtimeResourcesForTask } from "./execution-plan-resources.js";
import { recordLocalDockerProcessExit, recordLocalDockerProcessStart, releaseLocalDockerProcessRecord } from "./local-docker-provider.js";
import { phaseResourceContractForTask } from "./phase-resource-runtime.js";
import { assertPhysicalWork, candidateRestartWorkItem } from "./physical-work-plan.js";
import type { RerunEvalOptions } from "./rerun-types.js";
import type { EvalTrialSlot } from "./rerun-slots.js";
import { validateEvalId } from "./request.js";
import { loadTrialEnvironmentImages, prebuiltTaskImage, prebuiltServiceImages, prebuiltVerifierImage, persistTrialEnvironmentImageExecution } from "./trial-environment-evidence.js";

export function localCandidateRestartWork(plan: EvalExecutionPlanV1, slot: EvalTrialSlot, rerunId: string) {
  const planned = plan.slots.find(entry => entry.task_id === slot.task_id && entry.attempt === slot.attempt);
  const source = planned && plan.work_items.find(item => item.slots.includes(planned.slot_id));
  if (plan.provider !== "local-docker" || !(plan.resource_contract_version === "2" || plan.resource_profiling) || !source
    || source.task_ids.length !== 1 || source.slots.length !== 1 || source.logical_attempt !== slot.attempt) {
    throw new HitchError("phase candidate restart requires one frozen local task slot", { code: "eval_rerun_unavailable", exitCode: 2 });
  }
  const physical = { schema_version: "2" as const, kind: "candidate-restart" as const, source_work_id: source.work_id, rerun_id: rerunId };
  const work = candidateRestartWorkItem(source, rerunId);
  assertPhysicalWork(plan, work, physical);
  const phaseResourceContract = phaseResourceContractForTask(plan, work, slot.task_id);
  return { work, physical, phaseResourceContract };
}

/** A restart is a new physical execution of the immutable source work. Hold its
 * shared allocation until the owned Docker resources have been proved gone. */
export async function beginLocalCandidateRestart(input: {
  options: RerunEvalOptions; plan: EvalExecutionPlanV1; slot: EvalTrialSlot;
  evalDirectory: string; rerunDirectory: string; rerunId: string;
}) {
  const { options, plan, slot } = input;
  const { work, physical, phaseResourceContract } = localCandidateRestartWork(plan, slot, input.rerunId);
  const resources = runtimeResourcesForTask(plan, slot.task_id, work.reservation);
  const agentEnvironmentRole = agentEnvironmentRoleForTask(plan, slot.task_id);
  const images = await loadTrialEnvironmentImages({ taskId: slot.task_id, uses: work.image_refs ?? [],
    ...(options.environmentImageManifestLoader ? { loader: options.environmentImageManifestLoader } : {}) });
  const prebuiltImage = prebuiltTaskImage(images);
  const worker = options.executionWorker ?? { workerId: `worker_process_${process.pid}`, provider: "local-docker", collisionDomainId: `local-process:${process.pid}` };
  if (worker.provider !== "local-docker") throw new TypeError("local candidate restart worker provider changed");
  const admission = options.workItemAdmission ?? (plan.resource_profiling ? processWorkItemAdmission(1) : undefined);
  const permit = await admission?.acquire({ evalId: validateEvalId(plan.eval_id), workItem: work,
    maxParallelism: options.maxConcurrentOverride ?? plan.max_parallelism, ...(options.signal ? { signal: options.signal } : {}) });
  const lease = await createExecutionLease({ evalDirectory: input.evalDirectory, evalId: plan.eval_id, workId: work.work_id,
    worker: { ...worker, ...(permit ? { parentAllocationId: permit.allocationId } : {}) }, reservation: work.reservation,
    ttlMs: DEFAULT_EXECUTION_LEASE_TTL_MS }).catch(error => { permit?.release(); throw error; });
  const epoch = lease.current().epoch;
  const backendDirectory = path.join(input.rerunDirectory, "harbor", "work-items", work.work_id, `epoch-${String(epoch).padStart(6, "0")}`);
  const ownership = dockerResourceOwnership(options.root, lease.current(), slot.task_id);
  const env = options.env ?? process.env;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let heartbeatFailure: unknown;
  let heartbeatTail = Promise.resolve();
  const heartbeat = setInterval(() => {
    heartbeatTail = heartbeatTail.then(() => lease.heartbeat(epoch)).then(() => undefined).catch(error => { heartbeatFailure ??= error; controller.abort(); });
  }, DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS);
  heartbeat.unref();
  const observer = startDockerResourceObserver({ ...frozenDockerObservation(plan, slot.task_id, ownership, { trialParent: path.join(backendDirectory, "job") }), ownership, workerId: worker.workerId, collisionDomainId: worker.collisionDomainId,
    reservation: work.reservation, mainLimits: resources.mainLimits, sidecarLimits: resources.sidecarLimits, env, signal });
  let processRecorded = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    clearInterval(heartbeat);
    let evidenceFailure: unknown;
    try { await persistTrialEnvironmentImageExecution(backendDirectory, await observer.stop(), images); }
    catch (error) { evidenceFailure = error; }
    await heartbeatTail;
    if (processRecorded) await releaseLocalDockerProcessRecord({ root: options.root, leaseId: lease.leaseId, epoch });
    await lease.release(epoch);
    const cleanup = await confirmPhaseResourceCleanup({ root: options.root, env, lease: lease.current(),
      trialParents: [path.join(backendDirectory, "job")], ...(options.dockerResourceReaper ? { reaper: options.dockerResourceReaper } : {}) });
    await atomicWriteJSON(path.join(backendDirectory, "cleanup.json"), cleanup);
    permit?.release();
    if (heartbeatFailure !== undefined) throw heartbeatFailure;
    if (evidenceFailure !== undefined) throw evidenceFailure;
  })();
  try {
    await preparePhaseDockerExecution({ root: options.root, lease: lease.current() });
    await atomicWriteJSON(path.join(backendDirectory, "work.json"), work);
    await atomicWriteJSON(path.join(backendDirectory, "physical-execution.json"), physical);
    await lease.markRunning(epoch);
  } catch (error) { await close(); throw error; }
  const backend: Partial<RunHarborBackendOptions> = {
    onProcessStarting: env => bindPhaseDockerBackend({ root: options.root, lease: lease.current(), env }),
    executionResources: resources.mainLimits, dockerOwnership: ownership, dockerServiceLimits: resources.sidecarLimits,
    ...(phaseResourceContract ? { phaseResourceContract } : {}), ...(agentEnvironmentRole ? { agentEnvironmentRole } : {}), resolvedImages: resolvedImageMapping(work.image_refs ?? []),
    ...(prebuiltImage ? { prebuiltTaskImage: prebuiltImage } : {}), signal,
    prebuiltServiceImages: prebuiltServiceImages(images),
    verifierImages: { resolvedImages: resolvedImageMapping(work.image_refs ?? [], "verifier"), prebuiltImage: prebuiltVerifierImage(images) },
    ...(process.platform === "win32" ? {} : {
      recoverableProcess: true,
      onProcessStarted: (pid: number) => recordLocalDockerProcessStart({ root: options.root, workerId: worker.workerId,
        evalDirectory: input.evalDirectory, lease: lease.current(), backendDirectory, pid }).then(() => { processRecorded = true; }),
      onProcessExited: (result: { code: number | null; signal: NodeJS.Signals | null }) => recordLocalDockerProcessExit({
        root: options.root, leaseId: lease.leaseId, epoch, ...result }).then(() => undefined),
    }),
  };
  return { backendDirectory, backend, images, close,
    captureExecutionEvidence: async () => persistTrialEnvironmentImageExecution(backendDirectory, await observer.capture(), images) };
}
