import path from "node:path";
import type { ResolvedRevision } from "../artifacts/index.js";
import { readHarborRawResult } from "../backends/index.js";
import type { EvalId, EvalRequest, ExecutionLeaseV1 } from "../domain/index.js";
import { HitchError, readJSON } from "../foundation/index.js";
import { DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS, heartbeatExecutionLease, markExecutionLeaseLost, readExecutionLeases, reissueExecutionLease, releaseExecutionLease } from "./execution-leases.js";
import { LocalDockerExecutionProvider, readLocalDockerProcessRecordByLease, waitForLocalDockerProcessTerminal } from "./local-docker-provider.js";
import { loadEvalResumeState } from "./resume-state.js";
import { mergeEvalProgressTrial, writeEvalProgress } from "./progress.js";
import { replaceInvalidEvalProgressTrial } from "./progress.js";
import { assertBackendTrialSet } from "./result-helpers.js";
import { importEvalTrialRuns, validateEvalTrialReferences } from "./trial-import.js";
import { startEvalModelCaptureRuntime } from "./model-capture-runtime.js";
import type { EvalModelCaptureRuntime } from "./model-capture-runtime.js";
import { readModelProxyRuntimeState } from "./model-proxy-runtime-state.js";
import { ensurePhysicalRetryDecision, readEvalRetryState, resolveRetryWork, transitionRetryDecision } from "./retry-state.js";
import { classifyTrialFailure, physicalRetryAllowed } from "./failure-classifier.js";
import { physicalRetryWorkItem } from "./physical-retry-work.js";
import { retryBackoffMs } from "./retry-backoff.js";

export interface EvalLeaseRecoveryResult {
  status: "resumable" | "ambiguous";
  recovered_lease_ids: string[];
  code?: string;
  message?: string;
}

export async function recoverLocalDockerEvalLeases(input: {
  root: string;
  evalId: EvalId;
  evalDirectory: string;
  leases: ExecutionLeaseV1[];
  env?: NodeJS.ProcessEnv;
  cancelRequested?: boolean;
  emit?: (event: Record<string, unknown>) => void;
}): Promise<EvalLeaseRecoveryResult> {
  const emit = input.emit ?? (() => {});
  const recovered: string[] = [];
  let failure: { code: string; message: string } | undefined;
  let captureRuntime: EvalModelCaptureRuntime | undefined;
  try {
    captureRuntime = await restoreModelCaptureForRecovery(input);
    for (const lease of input.leases) {
      if (!activeLease(lease)) continue;
      try {
        await recoverLease(input, lease, emit, captureRuntime);
        recovered.push(lease.lease_id);
      } catch (error) {
        const typed = error instanceof HitchError;
        failure ??= {
          code: typed ? error.code : "execution_state_ambiguous",
          message: (error as Error)?.message || String(error),
        };
        const current = (await readExecutionLeases(input.evalDirectory)).find((entry) => entry.lease_id === lease.lease_id);
        if (current && activeLease(current)) await markExecutionLeaseLost({
          evalDirectory: input.evalDirectory,
          leaseId: current.lease_id,
          expectedEpoch: current.epoch,
        });
        emit({ type: "eval.lease.recovery-failed", lease_id: lease.lease_id, code: failure.code });
        emit({ type: "eval.work.lost", work_id: lease.work_id, lease_id: lease.lease_id, code: failure.code });
      }
    }
  } catch (error) {
    failure = { code: "execution_state_ambiguous", message: (error as Error)?.message || String(error) };
    for (const lease of input.leases.filter(activeLease)) {
      const current = (await readExecutionLeases(input.evalDirectory)).find((entry) => entry.lease_id === lease.lease_id);
      if (current && activeLease(current)) await markExecutionLeaseLost({ evalDirectory: input.evalDirectory, leaseId: current.lease_id, expectedEpoch: current.epoch });
      emit({ type: "eval.lease.recovery-failed", lease_id: lease.lease_id, code: failure.code });
      emit({ type: "eval.work.lost", work_id: lease.work_id, lease_id: lease.lease_id, code: failure.code });
    }
  } finally {
    await captureRuntime?.close().catch(() => undefined);
  }
  return failure
    ? { status: "ambiguous", recovered_lease_ids: recovered, ...failure }
    : { status: "resumable", recovered_lease_ids: recovered };
}

async function recoverLease(
  input: { root: string; evalId: EvalId; evalDirectory: string; cancelRequested?: boolean; env?: NodeJS.ProcessEnv },
  lease: ExecutionLeaseV1,
  emit: (event: Record<string, unknown>) => void,
  captureRuntime?: EvalModelCaptureRuntime,
): Promise<void> {
  if (Date.parse(lease.expires_at) <= Date.now()) emit({ type: "lease.expired", work_id: lease.work_id, lease_id: lease.lease_id, lease_epoch: lease.epoch, worker_id: lease.worker_id });
  if (lease.provider !== "local-docker") throw ambiguous(`unsupported recovery provider: ${lease.provider}`);
  const provider = new LocalDockerExecutionProvider({
    root: input.root,
    workerId: lease.worker_id,
    status: () => { throw new Error("recovery does not inspect provider capacity"); },
  });
  const record = await readLocalDockerProcessRecordByLease({ root: input.root, evalId: input.evalId, leaseId: lease.lease_id }).catch(() => {
    throw ambiguous(`local provider has no durable process identity for ${lease.lease_id}`);
  });
  if (record.lease_epoch === lease.epoch - 1) await provider.adoptLeaseEpoch(lease.lease_id, record.lease_epoch, lease.epoch);
  else if (record.lease_epoch !== lease.epoch) throw ambiguous(`local provider epoch does not match ${lease.lease_id}`);
  const probe = await provider.recover(lease);
  emit({ type: "eval.lease.recovery-probed", lease_id: lease.lease_id, lease_epoch: lease.epoch, state: probe.state });
  if (probe.state === "released") {
    await releaseExecutionLease({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch });
    emit({ type: "lease.recovered", work_id: lease.work_id, lease_id: lease.lease_id, lease_epoch: lease.epoch, state: "already-released" });
    return;
  }
  if (probe.state !== "running" && probe.state !== "terminal-uncollected") {
    throw ambiguous(`local provider classified ${lease.lease_id} as ${probe.state}`);
  }
  const reissued = await reissueExecutionLease({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch });
  await provider.adoptLeaseEpoch(lease.lease_id, lease.epoch, reissued.epoch);
  emit({ type: "eval.lease.reissued", lease_id: lease.lease_id, previous_epoch: lease.epoch, lease_epoch: reissued.epoch });
  let heartbeatFailure: unknown;
  let heartbeatTail = Promise.resolve();
  const timer = setInterval(() => {
    heartbeatTail = heartbeatTail.then(async () => {
      await heartbeatExecutionLease({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: reissued.epoch });
    }).catch((error) => { heartbeatFailure ??= error; });
  }, DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS);
  timer.unref();
  try {
    if (input.cancelRequested && probe.state === "running") await provider.cancel(lease.lease_id, reissued.epoch);
    const terminal = await waitForLocalDockerProcessTerminal({ root: input.root, leaseId: lease.lease_id, epoch: reissued.epoch });
    await heartbeatTail;
    if (heartbeatFailure !== undefined) throw heartbeatFailure;
    try { await collectRecoveredWork(input, reissued, terminal.backend_directory, emit, captureRuntime); } catch (error) {
      if (!input.cancelRequested || (error as { code?: string }).code !== "recovery_collection_missing") throw error;
    }
    if (!input.cancelRequested && terminal.process_exit_code !== null && terminal.process_exit_code !== 0) {
      throw new HitchError(`recovered Harbor process exited with code ${terminal.process_exit_code}`, { code: "harbor_failed", exitCode: 13 });
    }
    await provider.release(lease.lease_id, reissued.epoch);
    await releaseExecutionLease({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: reissued.epoch });
    emit({ type: "lease.released", work_id: lease.work_id, lease_id: lease.lease_id, lease_epoch: reissued.epoch, worker_id: lease.worker_id });
    emit({ type: "eval.lease.recovered", lease_id: lease.lease_id, lease_epoch: reissued.epoch, state: "released" });
    emit({ type: "lease.recovered", lease_id: lease.lease_id, lease_epoch: reissued.epoch, state: "released" });
  } finally {
    clearInterval(timer);
    await heartbeatTail;
  }
}

async function collectRecoveredWork(
  input: { root: string; evalId: EvalId; evalDirectory: string; env?: NodeJS.ProcessEnv },
  lease: ExecutionLeaseV1,
  backendDirectory: string,
  emit: (event: Record<string, unknown>) => void,
  captureRuntime?: EvalModelCaptureRuntime,
): Promise<void> {
  const state = await loadEvalResumeState(input.evalDirectory);
  const retryState = await readEvalRetryState(input.evalDirectory, input.evalId);
  const dynamic = resolveRetryWork(state.executionPlan, retryState, lease.work_id);
  const work = state.executionPlan.work_items.find((item) => item.work_id === lease.work_id) ?? dynamic?.item;
  if (!work || work.logical_attempt === null || work.task_ids.length !== 1) throw ambiguous("recovered lease does not match one planned task slot");
  const existing = state.progress.trials.find((trial) => trial.task_id === work.task_ids[0] && trial.attempt === work.logical_attempt);
  if (dynamic && existing?.observation_status === "valid") {
    for (const decision of dynamic.decisions) await settleRecoveredRetryDecision(input.evalDirectory, input.evalId, decision.decision_id, decision.state, "repaired");
    emit({ type: "eval.retry.recovered", work_id: work.work_id, lease_id: lease.lease_id, state: "repaired", collection: "already-published" });
    return;
  }
  const jobDirectory = path.join(input.evalDirectory, backendDirectory, "job");
  const rawResult = await readHarborRawResult(jobDirectory);
  if (!rawResult) throw new HitchError("recovered Harbor work item has no aggregate result", { code: "recovery_collection_missing", exitCode: 12 });
  const resolvedRevision = await readJSON<ResolvedRevision>(path.join(input.evalDirectory, "resolution.json"));
  const request = await readJSON<EvalRequest>(path.join(input.evalDirectory, "request.json"));
  const runtime = state.plan.controller_runtime as Record<string, unknown> | undefined;
  const runtimeId = typeof runtime?.runtime_id === "string" ? runtime.runtime_id : undefined;
  const refs = await importEvalTrialRuns({
    root: input.root,
    evalId: input.evalId,
    evalDirectory: input.evalDirectory,
    harborJobDirectory: jobDirectory,
    expectedAttempt: work.logical_attempt,
    request,
    resolvedRevision,
    benchmarkId: state.progress.benchmark_id,
    benchmarkRevision: state.progress.benchmark_revision,
    ...(runtimeId ? { runtimeId } : {}),
    env: input.env ?? process.env,
    ...(state.executionPlan.model_capture ? { modelCapturePlan: captureRuntime?.plan ?? state.executionPlan.model_capture } : {}),
    ...(captureRuntime?.exporter ? { interactionCaptureExporter: captureRuntime.exporter } : {}),
    ...(dynamic ? { publicationMode: "replace-invalid" as const } : {}),
    rawResult,
  }, dynamic ? [] : state.progress.trials);
  const workRefs = refs.filter((ref) => ref.task_id === work.task_ids[0] && ref.attempt === work.logical_attempt);
  assertBackendTrialSet(rawResult, workRefs);
  await validateEvalTrialReferences(input.root, input.evalId, workRefs, {
    benchmarkId: state.progress.benchmark_id,
    benchmarkRevision: state.progress.benchmark_revision,
  });
  let progress = state.progress;
  for (const ref of workRefs) {
    if (dynamic) {
      if (ref.observation_status === "valid") progress = replaceInvalidEvalProgressTrial(progress, ref);
    } else progress = mergeEvalProgressTrial(progress, ref);
  }
  if (progress.generation !== state.progress.generation) await writeEvalProgress(input.evalDirectory, progress);
  if (dynamic) {
    const repaired = workRefs.some((ref) => ref.observation_status === "valid");
    const retryable = workRefs.filter((ref) => physicalRetryAllowed(classifyTrialFailure(ref)));
    const retryIndex = dynamic.decisions[0]?.retry_index ?? 0;
    if (!repaired && retryable.length > 0 && retryIndex < state.executionPlan.retry_policy.infrastructure_retries) {
      const origin = state.executionPlan.work_items.find((item) => item.slots.includes(dynamic.decisions[0]!.slot_id));
      if (!origin) throw ambiguous("recovered retry origin is absent from execution plan");
      const nextWork = physicalRetryWorkItem(origin, retryIndex + 1, retryable);
      for (const trigger of retryable) await ensurePhysicalRetryDecision({
        evalDirectory: input.evalDirectory, evalId: input.evalId, item: origin, retryIndex: retryIndex + 1, trigger,
        notBefore: new Date(Date.now() + retryBackoffMs(state.executionPlan.retry_policy.infrastructure_retry_backoff_ms, retryIndex + 1, nextWork.work_id)).toISOString(),
      });
    }
    const target = repaired ? "repaired" : retryIndex >= state.executionPlan.retry_policy.infrastructure_retries ? "exhausted" : "invalid";
    for (const decision of dynamic.decisions) await settleRecoveredRetryDecision(input.evalDirectory, input.evalId, decision.decision_id, decision.state, target);
  }
  emit({ type: "eval.work-item.recovered", work_id: work.work_id, lease_id: lease.lease_id, trials: workRefs.length });
}

async function settleRecoveredRetryDecision(
  evalDirectory: string,
  evalId: string,
  decisionId: string,
  current: "planned" | "running" | "repaired" | "invalid" | "skipped" | "exhausted",
  target: "repaired" | "invalid" | "exhausted",
): Promise<void> {
  if (current === target) return;
  if (current === "planned") {
    await transitionRetryDecision({ evalDirectory, evalId, decisionId, state: "running" });
    current = "running";
  }
  if (current === "running") await transitionRetryDecision({ evalDirectory, evalId, decisionId, state: target });
}

async function restoreModelCaptureForRecovery(input: {
  evalId: EvalId;
  evalDirectory: string;
  leases: ExecutionLeaseV1[];
  env?: NodeJS.ProcessEnv;
}): Promise<EvalModelCaptureRuntime | undefined> {
  if (!input.leases.some(activeLease)) return undefined;
  const state = await loadEvalResumeState(input.evalDirectory);
  const plan = state.executionPlan.model_capture;
  if (!plan || plan.effective_mode !== "proxy" && plan.effective_mode !== "hybrid") return undefined;
  const request = await readJSON<EvalRequest>(path.join(input.evalDirectory, "request.json"));
  if (request.local_inference) {
    // Daemon restart deliberately fences the old engine credential and SGLang
    // process. An already-running Harbor candidate cannot be rebound safely.
    throw ambiguous("managed local inference was fenced by daemon restart");
  }
  if (!await readModelProxyRuntimeState(input.evalDirectory, input.evalId, plan)) {
    throw ambiguous("recoverable model proxy has no persisted endpoint identity");
  }
  const runtime = await startEvalModelCaptureRuntime({ plan, evalId: input.evalId, evalDirectory: input.evalDirectory, env: input.env ?? process.env });
  if (!runtime.route || !runtime.exporter) {
    await runtime.close().catch(() => undefined);
    throw ambiguous("recoverable model proxy endpoint could not be restored");
  }
  return runtime;
}

function activeLease(lease: ExecutionLeaseV1): boolean {
  return lease.state === "offered" || lease.state === "accepted" || lease.state === "running" || lease.state === "releasing";
}

function ambiguous(message: string): HitchError {
  return new HitchError(message, { code: "execution_state_ambiguous", exitCode: 12 });
}
