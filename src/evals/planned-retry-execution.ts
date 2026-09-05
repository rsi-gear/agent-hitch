import path from "node:path";
import type { BackendWorkItemV1, EvalTrialRefV1 } from "../domain/index.js";
import { runInfrastructureRetries } from "./infrastructure-retry.js";
import type { InfrastructureRetryRun } from "./infrastructure-retry.js";
import { runRemoteInfrastructureRetries } from "./remote-infrastructure-retry.js";
import { beginPlannedInfrastructureRetry } from "./planned-retry-lifecycle.js";
import { localSourceBackendFailure } from "./result-helpers.js";
import { resourceRequirementForTask } from "./execution-plan-resources.js";
import { resolvedImageMapping } from "./environment-image-planning.js";
import { preparedArtifactForWorkItem } from "./work-item-artifacts.js";
import type { TrialEnvironmentImagesV1 } from "./trial-environment-evidence.js";
import { workSchedulingPriority, type PrioritySemaphore } from "./planned-execution-support.js";
import type { PlannedBackendRun } from "./planned-execution-support.js";
import type { ExecutePlannedHarborOptions } from "./planned-execution.js";
import type { ProgressPublisher } from "./planned-progress-publisher.js";
import type { EvalSchedulerMetrics } from "./scheduler-metrics.js";
import { ensurePhysicalRetryDecision, ensureTerminalRetryDecision, readEvalRetryState } from "./retry-state.js";
import type { RetryDecisionV1 } from "./retry-state.js";
import { classifyTrialFailure, physicalRetryAllowed } from "./failure-classifier.js";
import { physicalRetryWorkItem } from "./physical-retry-work.js";
import { retryBackoffMs } from "./retry-backoff.js";

export interface PendingRetryWork {
  item: BackendWorkItemV1;
  decision: RetryDecisionV1;
  trigger: EvalTrialRefV1;
}

export async function runPlannedInfrastructureRetries(
  options: ExecutePlannedHarborOptions,
  publisher: ProgressPublisher,
  semaphore: PrioritySemaphore | undefined,
  metrics: EvalSchedulerMetrics,
  workItem: BackendWorkItemV1,
  completed: PlannedBackendRun,
): Promise<InfrastructureRetryRun[]> {
  if (options.signal?.aborted || completed.run.backend.process_exit_code !== 0 || completed.run.rawResult === null) return [];
  if (options.localTransport && localSourceBackendFailure(completed.run.rawResult)) return [];
  for (const trigger of completed.refs.filter((ref) => ref.observation_status === "invalid")) {
    const classification = classifyTrialFailure(trigger);
    if (physicalRetryAllowed(classification) && options.request.infrastructure_retries > 0) continue;
    const decision = await ensureTerminalRetryDecision({
      evalDirectory: options.evalDirectory, evalId: options.evalId, item: workItem, retryIndex: 1, trigger,
      exhausted: physicalRetryAllowed(classification),
    });
    if (decision) options.sink.emit({
      type: "eval.retry.skipped", work_id: workItem.work_id, decision_id: decision.decision_id,
      task_id: trigger.task_id, attempt: trigger.attempt, disposition: decision.disposition,
      classification: decision.classification, state: decision.state,
    });
    if (decision && providerCircuitFailure(decision.classification.code)) options.sink.emit({
      type: "eval.provider-circuit.opened",
      scope: "trial-retry",
      mode: "retry-only",
      provider: workItem.provider,
      model: options.request.model || null,
      work_id: workItem.work_id,
      decision_id: decision.decision_id,
      stable_code: decision.classification.code,
      automatic_probe: false,
    });
  }
  return runPlannedInfrastructureRetriesFromSource(options, publisher, semaphore, metrics, workItem, completed, 1);
}

function providerCircuitFailure(code: string): boolean {
  return code === "provider_quota_exhausted"
    || code === "provider_auth_failed"
    || code === "provider_configuration_invalid";
}

interface RetrySource {
  attempt: number;
  workId: string;
  tasks: string[];
  refs: EvalTrialRefV1[];
  environmentImages?: TrialEnvironmentImagesV1;
}

export async function runPlannedInfrastructureRetriesFromSource(
  options: ExecutePlannedHarborOptions,
  publisher: ProgressPublisher,
  semaphore: PrioritySemaphore | undefined,
  metrics: EvalSchedulerMetrics,
  workItem: BackendWorkItemV1,
  source: RetrySource,
  firstRetryIndex: number,
): Promise<InfrastructureRetryRun[]> {
  const progress = publisher.current();
  if (options.remoteWorkExecutor) {
    return (await runRemoteInfrastructureRetries({
      options, item: workItem, initial: source, progress, firstRetryIndex, metrics,
      replaceProgressTrial: (ref, retryWorkId) => publisher.replaceInvalid(ref, retryWorkId),
      currentProgress: () => publisher.current(),
    })).runs;
  }
  const retries = await runInfrastructureRetries({
    evalId: options.evalId,
    evalDirectory: options.evalDirectory,
    backendBaseDirectory: path.join(options.evalDirectory, "harbor", "work-items", source.workId, "infrastructure-retries"),
    logicalAttempt: source.attempt,
    initialRefs: source.refs,
    progress,
    request: options.request,
    root: options.root,
    resolvedRevision: options.resolvedRevision,
    controllerRuntime: options.controllerRuntime,
    preparedArtifact: preparedArtifactForWorkItem(options, workItem),
    executionResources: resourceRequirementForTask(options.plan, source.tasks[0] as string)?.main_limits ?? options.plan.default_trial_resources,
    resolvedImages: resolvedImageMapping(workItem.image_refs ?? []),
    ...(source.environmentImages ? { environmentImages: source.environmentImages } : {}),
    beginRetry: async ({ retry, triggers, backendDirectory }) => {
      const directRelease = await semaphore?.acquire(options.signal, workSchedulingPriority(workItem));
      try {
        const lifecycle = await beginPlannedInfrastructureRetry({
          options, item: workItem, retry, triggers, backendDirectory,
          ...(source.environmentImages ? { environmentImages: source.environmentImages } : {}),
        });
        return {
          ...lifecycle,
          close: async () => { try { await lifecycle.close(); } finally { directRelease?.(); } },
        };
      } catch (error) {
        directRelease?.();
        throw error;
      }
    },
    replaceProgressTrial: (ref, retryWorkId) => publisher.replaceInvalid(ref, retryWorkId),
    currentProgress: () => publisher.current(),
    originWorkItem: workItem,
    firstRetryIndex,
    onRetryExecutionStarted: (workId) => metrics.startWork(workId, "retry"),
    onRetryExecutionFinished: (workId) => metrics.finishWork(workId),
    onRetryBackoff: (durationMs) => metrics.addBlocked("backoff", durationMs),
    onVerifierDuration: (durationMs) => metrics.addVerifier(durationMs),
    ...(options.onWorkItemQueued ? { onRetryWorkPlanned: options.onWorkItemQueued } : {}),
    ...(options.localTransport ? { localTransport: options.localTransport } : {}),
    ...(options.plan.model_capture ? { modelCapturePlan: options.plan.model_capture } : {}),
    ...(options.interactionCaptureExporter ? { interactionCaptureExporter: options.interactionCaptureExporter } : {}),
    env: options.env,
    ...(options.harborExecutable !== undefined ? { harborExecutable: options.harborExecutable } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.trialBundleGraceMs === undefined ? {} : { trialBundleGraceMs: options.trialBundleGraceMs }),
    sink: options.sink,
    ...(options.localTransport ? { stopAfterResult: localSourceBackendFailure } : {}),
  });
  return retries.runs;
}

export async function reconcilePersistedInitialRetryDecisions(options: ExecutePlannedHarborOptions): Promise<void> {
  let state = await readEvalRetryState(options.evalDirectory, options.evalId);
  for (const trigger of options.progress.trials.filter((trial) => trial.observation_status === "invalid")) {
    if (state?.decisions.some((decision) => decision.trigger_trial_id === trigger.trial_id)) continue;
    const item = options.plan.work_items.find((entry) => entry.logical_attempt === trigger.attempt && entry.task_ids.includes(trigger.task_id));
    if (!item) throw new TypeError(`persisted invalid trial is absent from execution plan: ${trigger.task_id}#${trigger.attempt}`);
    const classification = classifyTrialFailure(trigger);
    if (physicalRetryAllowed(classification) && options.request.infrastructure_retries > 0) {
      const retryWork = physicalRetryWorkItem(item, 1, [trigger]);
      await ensurePhysicalRetryDecision({
        evalDirectory: options.evalDirectory, evalId: options.evalId, item, retryIndex: 1, trigger,
        notBefore: new Date(Date.now() + retryBackoffMs(options.request.infrastructure_retry_backoff_ms, 1, retryWork.work_id)).toISOString(),
      });
    } else {
      await ensureTerminalRetryDecision({
        evalDirectory: options.evalDirectory, evalId: options.evalId, item, retryIndex: 1, trigger,
        exhausted: physicalRetryAllowed(classification),
      });
    }
    state = await readEvalRetryState(options.evalDirectory, options.evalId);
  }
}

export async function pendingRetryWork(options: ExecutePlannedHarborOptions): Promise<Map<string, PendingRetryWork[]>> {
  const state = await readEvalRetryState(options.evalDirectory, options.evalId);
  const pending = new Map<string, PendingRetryWork[]>();
  if (!state) return pending;
  const seen = new Set<string>();
  for (const decision of state.decisions.filter((entry) => entry.disposition === "physical-retry" && entry.state === "planned")) {
    if (!decision.retry_work_id || seen.has(decision.retry_work_id)) continue;
    seen.add(decision.retry_work_id);
    const item = options.plan.work_items.find((entry) => entry.slots.includes(decision.slot_id));
    if (!item || item.logical_attempt === null || item.task_ids.length !== 1) throw new TypeError(`retry decision slot is absent from execution plan: ${decision.slot_id}`);
    const persistedTrigger = options.progress.trials.find((trial) => trial.trial_id === decision.trigger_trial_id);
    const trigger = persistedTrigger ?? (decision.trigger_run_id ? {
      trial_id: decision.trigger_trial_id, run_id: decision.trigger_run_id, task_id: item.task_ids[0] as string,
      attempt: item.logical_attempt, observation_status: "invalid" as const, invalid_reason: decision.classification.code,
    } : undefined);
    if (!trigger) throw new TypeError(`retry decision trigger cannot be recovered: ${decision.decision_id}`);
    const taskId = item.task_ids[0] as string;
    const entries = pending.get(taskId) ?? [];
    entries.push({ item, decision, trigger });
    pending.set(taskId, entries);
  }
  for (const entries of pending.values()) entries.sort((left, right) => left.decision.retry_index - right.decision.retry_index);
  return pending;
}
