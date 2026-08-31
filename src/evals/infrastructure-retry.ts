import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ResolvedRevision } from "../artifacts/index.js";
import { runHarborBackend } from "../backends/index.js";
import type { HarborBackendResult, HarborPreparedArtifactUse, LocalGitTransportUse } from "../backends/index.js";
import type { ControllerRuntimeUseResult } from "../controller-runtime/index.js";
import type { EvalProgressV1, EvalRequest, EvalTrialRefV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import { EvalEventSink } from "./events.js";
import { importEvalTrialRun, importEvalTrialRuns, TrialBundlePendingError, validateEvalTrialReferences } from "./trial-import.js";
import { replaceInvalidEvalProgressTrial, writeEvalProgress } from "./progress.js";

const INFRASTRUCTURE_REASONS = new Set([
  "infrastructure_failure",
  "verifier_infrastructure_failure",
  "verifier_result_missing",
]);

// Verifier failures are retried inside the original live Harbor trial by the
// custom verifier wrapper. Starting another Harbor trial would execute the
// candidate agent again, so only non-verifier trial infrastructure failures
// are eligible for this outer retry path.
const RETRYABLE_TRIAL_INFRASTRUCTURE_REASONS = new Set([
  "infrastructure_failure",
]);

export interface InfrastructureRetryRun {
  attempt: number;
  retry: number;
  tasks: string[];
  triggers: EvalTrialRefV1[];
  refs: EvalTrialRefV1[];
  run: HarborBackendResult;
}

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
}

export async function runInfrastructureRetries(
  options: RunInfrastructureRetriesOptions,
): Promise<{ progress: EvalProgressV1; runs: InfrastructureRetryRun[] }> {
  let progress = options.progress;
  let retryCandidates = retryableInfrastructureTrials(options.initialRefs);
  const runs: InfrastructureRetryRun[] = [];
  for (let retry = 1; retry <= options.request.infrastructure_retries && retryCandidates.length > 0; retry += 1) {
    if (options.signal?.aborted) break;
    const retryTriggers = [...retryCandidates];
    const taskNames = [...new Set(retryCandidates.map((ref) => ref.task_id))].sort();
    const backoffMs = options.request.infrastructure_retry_backoff_ms * retry;
    options.sink.emit({
      type: "eval.infrastructure-retry.scheduled",
      attempt: options.logicalAttempt,
      retry,
      tasks: taskNames,
      backoff_ms: backoffMs,
    });
    if (backoffMs > 0) {
      if (options.signal) await delay(backoffMs, undefined, { signal: options.signal });
      else await delay(backoffMs);
    }
    if (options.signal?.aborted) break;

    const backendDirectory = path.join(
      options.backendBaseDirectory || path.join(options.evalDirectory, "infrastructure-retries"),
      `retry-${String(retry).padStart(4, "0")}`,
      options.request.attempts === 1 ? "harbor" : attemptDirectoryName(options.logicalAttempt),
    );
    const harborJobDirectory = path.join(backendDirectory, "job");
    const retryRefs: EvalTrialRefV1[] = [];
    const selectedTasks = new Set(taskNames);
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
      await validateEvalTrialReferences(options.root, options.evalId, [ref], {
        benchmarkId: options.request.benchmark_id,
        benchmarkRevision: options.request.benchmark_revision,
      });
      if (ref.observation_status === "valid") {
        progress = replaceInvalidEvalProgressTrial(progress, ref);
        await writeEvalProgress(options.evalDirectory, progress);
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
        generation: progress.generation,
      });
    };
    const run = await runHarborBackend({
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
      ...(options.localTransport ? { localTransport: options.localTransport } : {}),
      env: options.env,
      ...(options.harborExecutable !== undefined ? { harborExecutable: options.harborExecutable } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.trialBundleGraceMs === undefined ? {} : { trialBundleGraceMs: options.trialBundleGraceMs }),
      emit: (event) => options.sink.emit({ ...event, infrastructure_retry: retry, logical_attempt: options.logicalAttempt }),
      onTrialSettled: async (trial, context): Promise<boolean> => {
        try {
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
            runtimeId: options.controllerRuntime.runtime_id,
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
      runtimeId: options.controllerRuntime.runtime_id,
      rawResult: run.rawResult,
    }, retryRefs);
    for (const ref of terminalRefs) await publish(ref);
    if (run.rawResult !== null) assertBackendTrialSet(run.rawResult, retryRefs);
    runs.push({ attempt: options.logicalAttempt, retry, tasks: taskNames, triggers: retryTriggers, refs: retryRefs, run });
    options.sink.emit({
      type: "eval.infrastructure-retry.completed",
      attempt: options.logicalAttempt,
      retry,
      tasks: taskNames,
      repaired_tasks: retryRefs.filter((ref) => ref.observation_status === "valid").map((ref) => ref.task_id).sort(),
      remaining_tasks: retryableInfrastructureTrials(retryRefs).map((ref) => ref.task_id).sort(),
    });
    if (run.backend.process_exit_code !== 0 || run.rawResult === null || options.stopAfterResult?.(run.rawResult)) break;
    retryCandidates = retryableInfrastructureTrials(retryRefs);
  }
  return { progress, runs };
}

export function retryableInfrastructureTrials(trials: readonly EvalTrialRefV1[]): EvalTrialRefV1[] {
  return trials.filter((trial) => trial.observation_status === "invalid"
    && trial.invalid_reason !== undefined
    && RETRYABLE_TRIAL_INFRASTRUCTURE_REASONS.has(trial.invalid_reason));
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
