import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ResolvedRevision } from "../artifacts/index.js";
import { runHarborBackend } from "../backends/index.js";
import type { HarborBackendResult, HarborPreparedArtifactUse, LocalGitTransportUse, RunHarborBackendOptions } from "../backends/index.js";
import type { ControllerRuntimeUseResult } from "../controller-runtime/index.js";
import type { BackendWorkItemV1, EvalProgressV1, EvalRequest, EvalTrialRefV1, ExecutionEvidenceV1, ModelCapturePlanV1, ResourceVectorV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import { EvalEventSink } from "./events.js";
import { importEvalTrialRun, importEvalTrialRuns, TrialBundlePendingError, validateEvalTrialReferences } from "./trial-import.js";
import { replaceInvalidEvalProgressTrial, writeEvalProgress } from "./progress.js";
import type { TrialEnvironmentImagesV1 } from "./trial-environment-evidence.js";
import type { EvalInteractionCaptureExporter } from "./service-types.js";
import { ensurePhysicalRetryDecision, transitionRetryDecision } from "./retry-state.js";
import { physicalRetryWorkItem } from "./physical-retry-work.js";
import { classifyTrialFailure, physicalRetryAllowed } from "./failure-classifier.js";
import { retryBackoffMs } from "./retry-backoff.js";
import { harborPhaseTimingEvents } from "./harbor-phase-timings.js";

const INFRASTRUCTURE_REASONS = new Set([
  "infrastructure_failure",
  "verifier_infrastructure_failure",
  "verifier_result_missing",
  "provider_quota_exhausted",
  "provider_auth_failed",
  "provider_configuration_invalid",
  "provider_rate_limited",
  "provider_transport_transient",
  "worker_lost_before_candidate",
  "sandbox_setup_failed",
  "execution_state_ambiguous",
]);

export interface InfrastructureRetryRun {
  attempt: number;
  retry: number;
  tasks: string[];
  triggers: EvalTrialRefV1[];
  refs: EvalTrialRefV1[];
  run: HarborBackendResult;
  leaseId?: string;
  workId?: string;
  durationMs?: number;
}

type RetryBackendOverrides = Pick<RunHarborBackendOptions,
  "executionResources" | "dockerOwnership" | "dockerServiceLimits" | "resolvedImages"
  | "prebuiltTaskImage" | "recoverableProcess" | "onProcessStarted" | "onProcessExited">;

export interface InfrastructureRetryLifecycle {
  leaseId: string;
  workId: string;
  backend: RetryBackendOverrides;
  environmentImages?: TrialEnvironmentImagesV1;
  captureExecutionEvidence?: () => Promise<ExecutionEvidenceV1>;
  close(): Promise<void>;
}

export type BeginInfrastructureRetry = (input: {
  retry: number;
  logicalAttempt: number;
  taskNames: string[];
  triggers: EvalTrialRefV1[];
  backendDirectory: string;
}) => Promise<InfrastructureRetryLifecycle>;

export interface RunInfrastructureRetriesOptions {
  evalId: string;
  evalDirectory: string;
  backendBaseDirectory?: string;
  logicalAttempt: number;
  initialRefs: readonly EvalTrialRefV1[];
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
  stopAfterResult?: (rawResult: Record<string, unknown> | null) => boolean;
  executionResources?: ResourceVectorV1;
  resolvedImages?: Record<string, string>;
  environmentImages?: TrialEnvironmentImagesV1;
  beginRetry?: BeginInfrastructureRetry;
  modelCapturePlan?: ModelCapturePlanV1;
  interactionCaptureExporter?: EvalInteractionCaptureExporter;
  replaceProgressTrial?: (ref: EvalTrialRefV1, workId: string) => Promise<void>;
  currentProgress?: () => EvalProgressV1;
  originWorkItem?: BackendWorkItemV1;
  firstRetryIndex?: number;
  onRetryWorkPlanned?: (workId: string) => Promise<void>;
  onRetryExecutionStarted?: (workId: string) => void;
  onRetryExecutionFinished?: (workId: string) => number;
  onRetryBackoff?: (durationMs: number) => void;
  onVerifierDuration?: (durationMs: number) => void;
}

export async function runInfrastructureRetries(
  options: RunInfrastructureRetriesOptions,
): Promise<{ progress: EvalProgressV1; runs: InfrastructureRetryRun[] }> {
  let progress = options.progress;
  let retryCandidates = retryableInfrastructureTrials(options.initialRefs);
  const runs: InfrastructureRetryRun[] = [];
  const firstRetryIndex = options.firstRetryIndex ?? 1;
  if (!Number.isSafeInteger(firstRetryIndex) || firstRetryIndex < 1) throw new TypeError("first infrastructure retry index is invalid");
  for (let retry = firstRetryIndex; retry <= options.request.infrastructure_retries && retryCandidates.length > 0; retry += 1) {
    if (options.signal?.aborted) break;
    const retryTriggers = [...retryCandidates];
    const taskNames = [...new Set(retryCandidates.map((ref) => ref.task_id))].sort();
    const retryWork = options.originWorkItem ? physicalRetryWorkItem(options.originWorkItem, retry, retryTriggers) : undefined;
    const backoffMs = retryBackoffMs(options.request.infrastructure_retry_backoff_ms, retry, retryWork?.work_id ?? retryTriggers.map((trial) => trial.trial_id).join("\0"));
    const notBefore = new Date(Date.now() + backoffMs).toISOString();
    const retryDecisions = options.originWorkItem
      ? await Promise.all(retryTriggers.map((trigger) => ensurePhysicalRetryDecision({
        evalDirectory: options.evalDirectory, evalId: options.evalId, item: options.originWorkItem as BackendWorkItemV1,
        retryIndex: retry, trigger, notBefore,
      })))
      : [];
    if (retryWork && retryDecisions.some((decision) => decision.retry_work_id !== retryWork.work_id)) {
      throw new Error(`persisted retry work identity conflicts with execution: ${retryWork.work_id}`);
    }
    if (retryWork) await options.onRetryWorkPlanned?.(retryWork.work_id);
    options.sink.emit({
      type: "eval.retry.decision",
      execution_kind: "physical-infrastructure-retry",
      candidate_executes: true,
      ...(retryWork ? { work_id: retryWork.work_id } : {}),
      decision_ids: retryDecisions.map((decision) => decision.decision_id),
      attempt: options.logicalAttempt,
      retry,
      tasks: taskNames,
      backoff_ms: backoffMs,
    });
    const remainingBackoffMs = Math.max(0, Date.parse(retryDecisions[0]?.not_before ?? notBefore) - Date.now());
    options.onRetryBackoff?.(remainingBackoffMs);
    if (remainingBackoffMs > 0) {
      if (options.signal) await delay(remainingBackoffMs, undefined, { signal: options.signal });
      else await delay(remainingBackoffMs);
    }
    if (options.signal?.aborted) break;
    if (retryWork) options.sink.emit({
      type: "eval.retry.ready", work_id: retryWork.work_id, decision_ids: retryDecisions.map((decision) => decision.decision_id),
      retry, tasks: taskNames, priority: options.originWorkItem?.scheduling?.remaining_path_ms ?? 0,
    });

    const backendDirectory = path.join(
      options.backendBaseDirectory || path.join(options.evalDirectory, "infrastructure-retries"),
      `retry-${String(retry).padStart(4, "0")}`,
      options.request.attempts === 1 ? "harbor" : attemptDirectoryName(options.logicalAttempt),
    );
    const harborJobDirectory = path.join(backendDirectory, "job");
    const retryRefs: EvalTrialRefV1[] = [];
    const selectedTasks = new Set(taskNames);
    let lifecycle: InfrastructureRetryLifecycle | undefined;
    const retryEnvironmentImages = (): TrialEnvironmentImagesV1 | undefined => lifecycle?.environmentImages ?? options.environmentImages;
    const executionEvidence = async (): Promise<{ executionEvidence?: ExecutionEvidenceV1 }> => lifecycle?.captureExecutionEvidence
      ? { executionEvidence: await lifecycle.captureExecutionEvidence() }
      : {};
    const publish = async (ref: EvalTrialRefV1): Promise<void> => {
      if (ref.attempt !== options.logicalAttempt || !selectedTasks.has(ref.task_id)) {
        throw new HitchError(`Harbor infrastructure retry returned an unselected trial: ${ref.task_id}#${ref.attempt}`, {
          code: "eval_infrastructure_retry_trial_mismatch",
          exitCode: 12,
        });
      }
      const existing = retryRefs.find((current) => current.trial_id === ref.trial_id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(ref)) throw new Error(`infrastructure retry trial identity changed: ${ref.trial_id}`);
        return;
      }
      retryRefs.push(ref);
      if (ref.invalid_reason === "candidate_evidence_unavailable") options.sink.emit({
        type: "eval.verifier.skipped", work_id: retryWork?.work_id, trial_id: ref.trial_id, task_id: ref.task_id,
        reason: "candidate_evidence_unavailable", candidate_executes: true, verifier_executes: false,
      });
      await validateEvalTrialReferences(options.root, options.evalId, [ref], {
        benchmarkId: options.request.benchmark_id,
        benchmarkRevision: options.request.benchmark_revision,
      });
      if (ref.observation_status === "valid") {
        if (options.replaceProgressTrial) {
          if (!lifecycle) throw new Error("planned infrastructure retry is missing its lifecycle identity");
          await options.replaceProgressTrial(ref, lifecycle.workId);
          progress = options.currentProgress?.() ?? progress;
        } else {
          progress = replaceInvalidEvalProgressTrial(progress, ref);
          await writeEvalProgress(options.evalDirectory, progress);
        }
      }
      options.sink.emit({
        type: ref.observation_status === "valid"
          ? "eval.infrastructure-retry.repaired"
          : "eval.infrastructure-retry.failed",
        attempt: options.logicalAttempt,
        retry,
        task_id: ref.task_id,
        trial_id: ref.trial_id,
        run_id: ref.run_id,
        observation_status: ref.observation_status,
        ...(ref.invalid_reason ? { invalid_reason: ref.invalid_reason } : {}),
        generation: (options.currentProgress?.() ?? progress).generation,
      });
    };
    let run: HarborBackendResult;
    let nextCandidates: EvalTrialRefV1[] = [];
    let runRecord: InfrastructureRetryRun | undefined;
    let executionStarted = false;
    try {
      lifecycle = await options.beginRetry?.({ retry, logicalAttempt: options.logicalAttempt, taskNames, triggers: retryTriggers, backendDirectory });
      if (retryWork && lifecycle?.workId !== retryWork.work_id) throw new Error(`retry lifecycle work identity conflicts with persisted decision: ${retryWork.work_id}`);
      for (const decision of retryDecisions) await transitionRetryDecision({
        evalDirectory: options.evalDirectory, evalId: options.evalId, decisionId: decision.decision_id, state: "running",
      });
      if (retryWork) options.sink.emit({ type: "eval.retry.admitted", work_id: retryWork.work_id, decision_ids: retryDecisions.map((decision) => decision.decision_id) });
      if (retryWork) {
        options.onRetryExecutionStarted?.(retryWork.work_id);
        executionStarted = true;
      }
      run = await runHarborBackend({
        evalId: options.evalId,
        evalDirectory: options.evalDirectory,
        backendDirectory,
        logicalAttempt: options.logicalAttempt,
        taskNames,
        request: { ...options.request, attempts: 1 },
        root: options.root,
        resolvedRevision: options.resolvedRevision,
        runtimeDirectory: options.controllerRuntime.directory,
        runtimeId: options.controllerRuntime.runtime_id,
        preparedArtifact: options.preparedArtifact,
        ...(options.executionResources ? { executionResources: options.executionResources } : {}),
        ...(options.resolvedImages ? { resolvedImages: options.resolvedImages } : {}),
        ...(options.interactionCaptureExporter ? { modelProxy: options.interactionCaptureExporter.route } : {}),
        ...lifecycle?.backend,
        env: options.env,
        ...(options.harborExecutable !== undefined ? { harborExecutable: options.harborExecutable } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.trialBundleGraceMs === undefined ? {} : { trialBundleGraceMs: options.trialBundleGraceMs }),
        emit: (event) => options.sink.emit({ ...event, execution_kind: "physical-infrastructure-retry", infrastructure_retry: retry, logical_attempt: options.logicalAttempt, ...(lifecycle ? { work_id: lifecycle.workId, lease_id: lifecycle.leaseId } : {}) }),
        onTrialSettled: async (trial, context): Promise<boolean> => {
          try {
            const environmentImages = retryEnvironmentImages();
            const ref = await importEvalTrialRun({
              root: options.root,
              evalId: options.evalId,
              evalDirectory: options.evalDirectory,
              harborJobDirectory,
              expectedAttempt: options.logicalAttempt,
              request: options.request,
              resolvedRevision: options.resolvedRevision,
              benchmarkId: options.request.benchmark_id,
              benchmarkRevision: options.request.benchmark_revision,
              publicationMode: "replace-invalid",
              runtimeId: options.controllerRuntime.runtime_id,
              env: options.env,
              ...(options.signal ? { signal: options.signal } : {}),
              ...(options.modelCapturePlan ? { modelCapturePlan: options.modelCapturePlan } : {}),
              ...(options.interactionCaptureExporter ? {
                interactionCaptureExporter: options.interactionCaptureExporter,
              } : {}),
              ...await executionEvidence(),
              ...(environmentImages ? { environmentImages } : {}),
              requireCompleteMarker: true,
              allowMissingBundleDiagnostic: context.bundleWaitExpired,
            }, trial, retryRefs.length, retryRefs);
            await publish(ref);
            return true;
          } catch (error) {
            if (error instanceof TrialBundlePendingError) return false;
            throw error;
          }
        },
      });
      for (const event of await harborPhaseTimingEvents(harborJobDirectory, run.rawResult)) {
        options.sink.emit(event);
        if (event.type === "eval.verifier.completed" && typeof event.duration_ms === "number") options.onVerifierDuration?.(event.duration_ms);
      }
      const environmentImages = retryEnvironmentImages();
      const terminalRefs = await importEvalTrialRuns({
        root: options.root,
        evalId: options.evalId,
        evalDirectory: options.evalDirectory,
        harborJobDirectory,
        expectedAttempt: options.logicalAttempt,
        request: options.request,
        resolvedRevision: options.resolvedRevision,
        benchmarkId: options.request.benchmark_id,
        benchmarkRevision: options.request.benchmark_revision,
        publicationMode: "replace-invalid",
        runtimeId: options.controllerRuntime.runtime_id,
        env: options.env,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.modelCapturePlan ? { modelCapturePlan: options.modelCapturePlan } : {}),
        ...(options.interactionCaptureExporter ? {
          interactionCaptureExporter: options.interactionCaptureExporter,
        } : {}),
        ...await executionEvidence(),
        ...(environmentImages ? { environmentImages } : {}),
        rawResult: run.rawResult,
      }, retryRefs);
      for (const ref of terminalRefs) await publish(ref);
      if (run.rawResult !== null) assertBackendTrialSet(run.rawResult, retryRefs);
      runRecord = { attempt: options.logicalAttempt, retry, tasks: taskNames, triggers: retryTriggers, refs: retryRefs, run, ...(lifecycle ? { leaseId: lifecycle.leaseId, workId: lifecycle.workId } : {}) };
      runs.push(runRecord);
      nextCandidates = retryableInfrastructureTrials(retryRefs);
      if (options.originWorkItem && retry < options.request.infrastructure_retries && nextCandidates.length > 0) {
        const nextWork = physicalRetryWorkItem(options.originWorkItem, retry + 1, nextCandidates);
        const nextNotBefore = new Date(Date.now() + retryBackoffMs(options.request.infrastructure_retry_backoff_ms, retry + 1, nextWork.work_id)).toISOString();
        await Promise.all(nextCandidates.map((trigger) => ensurePhysicalRetryDecision({
          evalDirectory: options.evalDirectory, evalId: options.evalId, item: options.originWorkItem as BackendWorkItemV1,
          retryIndex: retry + 1, trigger, notBefore: nextNotBefore,
        })));
        await options.onRetryWorkPlanned?.(nextWork.work_id);
      }
      const retryState = retryRefs.some((ref) => ref.observation_status === "valid")
        ? "repaired"
        : retry < options.request.infrastructure_retries && nextCandidates.length > 0 ? "invalid" : "exhausted";
      for (const decision of retryDecisions) await transitionRetryDecision({
        evalDirectory: options.evalDirectory, evalId: options.evalId, decisionId: decision.decision_id, state: retryState,
      });
    } finally {
      await lifecycle?.close();
      if (executionStarted && retryWork) {
        const durationMs = options.onRetryExecutionFinished?.(retryWork.work_id);
        if (runRecord && durationMs !== undefined) runRecord.durationMs = durationMs;
      }
    }
    options.sink.emit({
      type: "eval.infrastructure-retry.completed",
      execution_kind: "physical-infrastructure-retry",
      candidate_executes: true,
      attempt: options.logicalAttempt,
      retry,
      tasks: taskNames,
      repaired_tasks: retryRefs.filter((ref) => ref.observation_status === "valid").map((ref) => ref.task_id).sort(),
      remaining_tasks: retryableInfrastructureTrials(retryRefs).map((ref) => ref.task_id).sort(),
    });
    if (run.backend.process_exit_code !== 0 || run.rawResult === null || options.stopAfterResult?.(run.rawResult)) break;
    retryCandidates = nextCandidates;
  }
  return { progress: options.currentProgress?.() ?? progress, runs };
}

export function retryableInfrastructureTrials(trials: readonly EvalTrialRefV1[]): EvalTrialRefV1[] {
  return trials.filter((trial) => physicalRetryAllowed(classifyTrialFailure(trial)));
}

export function infrastructureFailureTrials(trials: readonly EvalTrialRefV1[]): EvalTrialRefV1[] {
  return trials.filter((trial) => trial.observation_status === "invalid"
    && trial.invalid_reason !== undefined
    && INFRASTRUCTURE_REASONS.has(trial.invalid_reason));
}

function assertBackendTrialSet(rawResult: Record<string, unknown>, refs: readonly EvalTrialRefV1[]): void {
  const trials = Array.isArray(rawResult.trial_results) ? rawResult.trial_results as Record<string, unknown>[] : [];
  const backendIds = new Set(trials.map((trial) => typeof trial.trial_name === "string" ? trial.trial_name : null).filter((value): value is string => value !== null));
  const refIds = new Set(refs.map((ref) => ref.trial_id));
  if (backendIds.size !== trials.length || backendIds.size !== refIds.size || [...backendIds].some((id) => !refIds.has(id))) {
    throw new Error("Harbor infrastructure retry trial set does not match published eval progress");
  }
}

function attemptDirectoryName(attempt: number): string {
  return `attempt-${String(attempt).padStart(4, "0")}`;
}
