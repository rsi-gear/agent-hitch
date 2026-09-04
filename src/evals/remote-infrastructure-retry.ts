import { setTimeout as delay } from "node:timers/promises";
import type { BackendWorkItemV1, EvalProgressV1, EvalTrialRefV1 } from "../domain/index.js";
import { preparedArtifactForWorkItem } from "./work-item-artifacts.js";
import { HitchError } from "../foundation/index.js";
import type { InfrastructureRetryRun } from "./infrastructure-retry.js";
import { retryableInfrastructureTrials } from "./infrastructure-retry.js";
import type { ExecutePlannedHarborOptions, PlannedBackendRun } from "./planned-execution.js";
import { replaceInvalidEvalProgressTrial, writeEvalProgress } from "./progress.js";
import { physicalRetryWorkItem } from "./physical-retry-work.js";
import { ensurePhysicalRetryDecision, transitionRetryDecision } from "./retry-state.js";
import { retryBackoffMs } from "./retry-backoff.js";
import type { EvalSchedulerMetrics } from "./scheduler-metrics.js";

export async function runRemoteInfrastructureRetries(input: {
  options: ExecutePlannedHarborOptions;
  item: BackendWorkItemV1;
  initial: Pick<PlannedBackendRun, "refs" | "environmentImages"> | PlannedBackendRun;
  progress: EvalProgressV1;
  replaceProgressTrial?: (ref: EvalTrialRefV1, workId: string) => Promise<void>;
  currentProgress?: () => EvalProgressV1;
  firstRetryIndex?: number;
  metrics?: EvalSchedulerMetrics;
}): Promise<{ progress: EvalProgressV1; runs: InfrastructureRetryRun[] }> {
  const executor = input.options.remoteWorkExecutor;
  if (!executor) throw new TypeError("remote work executor is unavailable");
  let progress = input.progress;
  let candidates = retryableInfrastructureTrials(input.initial.refs);
  const runs: InfrastructureRetryRun[] = [];
  const firstRetryIndex = input.firstRetryIndex ?? 1;
  if (!Number.isSafeInteger(firstRetryIndex) || firstRetryIndex < 1) throw new TypeError("first infrastructure retry index is invalid");
  for (let retry = firstRetryIndex; retry <= input.options.request.infrastructure_retries && candidates.length > 0; retry += 1) {
    if (input.options.signal?.aborted) break;
    const triggers = [...candidates];
    const work = physicalRetryWorkItem(input.item, retry, triggers);
    const backoffMs = retryBackoffMs(input.options.request.infrastructure_retry_backoff_ms, retry, work.work_id);
    const notBefore = new Date(Date.now() + backoffMs).toISOString();
    const decisions = await Promise.all(triggers.map((trigger) => ensurePhysicalRetryDecision({
      evalDirectory: input.options.evalDirectory, evalId: input.options.evalId, item: input.item,
      retryIndex: retry, trigger, notBefore,
    })));
    if (decisions.some((decision) => decision.retry_work_id !== work.work_id)) throw new Error(`persisted retry work identity conflicts with execution: ${work.work_id}`);
    await input.options.onWorkItemQueued?.(work.work_id);
    input.options.sink.emit({
      type: "eval.retry.decision", execution_kind: "physical-infrastructure-retry", work_id: work.work_id,
      decision_ids: decisions.map((decision) => decision.decision_id),
      candidate_executes: true, attempt: input.item.logical_attempt, retry,
      tasks: input.item.task_ids, backoff_ms: backoffMs, provider: input.item.provider,
    });
    const remainingBackoffMs = Math.max(0, Date.parse(decisions[0]?.not_before ?? notBefore) - Date.now());
    input.metrics?.addBlocked("backoff", remainingBackoffMs);
    if (remainingBackoffMs > 0) await delay(remainingBackoffMs, undefined, input.options.signal ? { signal: input.options.signal } : undefined);
    if (input.options.signal?.aborted) break;
    input.options.sink.emit({
      type: "eval.retry.ready", work_id: work.work_id, decision_ids: decisions.map((decision) => decision.decision_id),
      retry, tasks: input.item.task_ids, priority: input.item.scheduling?.remaining_path_ms ?? 0,
    });
    const refs: EvalTrialRefV1[] = [];
    let decisionsSettled = false;
    const settleDecisions = async (): Promise<void> => {
      if (decisionsSettled || refs.length === 0) return;
      candidates = retryableInfrastructureTrials(refs);
      if (retry < input.options.request.infrastructure_retries && candidates.length > 0) {
        const nextWork = physicalRetryWorkItem(input.item, retry + 1, candidates);
        const nextNotBefore = new Date(Date.now() + retryBackoffMs(input.options.request.infrastructure_retry_backoff_ms, retry + 1, nextWork.work_id)).toISOString();
        await Promise.all(candidates.map((trigger) => ensurePhysicalRetryDecision({
          evalDirectory: input.options.evalDirectory, evalId: input.options.evalId, item: input.item,
          retryIndex: retry + 1, trigger, notBefore: nextNotBefore,
        })));
        await input.options.onWorkItemQueued?.(nextWork.work_id);
      }
      const retryState = refs.some((ref) => ref.observation_status === "valid")
        ? "repaired"
        : retry < input.options.request.infrastructure_retries && candidates.length > 0 ? "invalid" : "exhausted";
      for (const decision of decisions) await transitionRetryDecision({
        evalDirectory: input.options.evalDirectory, evalId: input.options.evalId, decisionId: decision.decision_id, state: retryState,
      });
      decisionsSettled = true;
    };
    const publish = async (ref: EvalTrialRefV1): Promise<void> => {
      assertSelectedTrial(ref, input.item);
      const existing = refs.find((entry) => entry.trial_id === ref.trial_id || (entry.run_group ? entry.run_group.run_group_id === ref.run_group?.run_group_id : entry.run_id === ref.run_id));
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(ref)) throw new Error(`remote retry trial identity changed: ${ref.trial_id}`);
        return;
      }
      refs.push(ref);
      if (ref.invalid_reason === "candidate_evidence_unavailable") input.options.sink.emit({
        type: "eval.verifier.skipped", work_id: work.work_id, trial_id: ref.trial_id, task_id: ref.task_id,
        reason: "candidate_evidence_unavailable", candidate_executes: true, verifier_executes: false,
      });
      if (ref.observation_status === "valid") {
        if (input.replaceProgressTrial) {
          await input.replaceProgressTrial(ref, work.work_id);
          progress = input.currentProgress?.() ?? progress;
        } else {
          progress = replaceInvalidEvalProgressTrial(progress, ref);
          await writeEvalProgress(input.options.evalDirectory, progress);
        }
      }
      input.options.sink.emit({
        type: ref.observation_status === "valid" ? "eval.infrastructure-retry.repaired" : "eval.infrastructure-retry.failed",
        attempt: input.item.logical_attempt, retry, task_id: ref.task_id, trial_id: ref.trial_id,
        run_id: ref.run_id, observation_status: ref.observation_status,
        ...(ref.invalid_reason ? { invalid_reason: ref.invalid_reason } : {}), generation: (input.currentProgress?.() ?? progress).generation,
      });
    };
    const completed = await executor({
      evalId: input.options.evalId, evalDirectory: input.options.evalDirectory, root: input.options.root,
      request: input.options.request, plan: input.options.plan, workItem: work,
      resolvedRevision: input.options.resolvedRevision, preparedArtifact: preparedArtifactForWorkItem(input.options, work),
      runtimeDirectory: input.options.controllerRuntime.directory, runtimeId: input.options.controllerRuntime.runtime_id,
      ...(input.initial.environmentImages ? { environmentImages: input.initial.environmentImages } : {}),
      ...(input.options.plan.model_capture ? { modelCapturePlan: input.options.plan.model_capture } : {}),
      publicationMode: "replace-invalid",
      ...(input.options.signal ? { signal: input.options.signal } : {}),
      emit: (event) => input.options.sink.emit({ ...event, execution_kind: "physical-infrastructure-retry", infrastructure_retry: retry }),
      publish,
      onLeaseState: async (leaseId, state) => {
        if (state === "running") {
          input.metrics?.startWork(work.work_id, "retry");
          for (const decision of decisions) await transitionRetryDecision({
            evalDirectory: input.options.evalDirectory, evalId: input.options.evalId, decisionId: decision.decision_id, state: "running",
          });
          input.options.sink.emit({ type: "eval.retry.admitted", work_id: work.work_id, decision_ids: decisions.map((decision) => decision.decision_id) });
        }
        if (state === "terminal") {
          await settleDecisions();
          input.metrics?.finishWork(work.work_id);
        }
        await input.options.onWorkItemState?.(work.work_id, leaseId, state);
      },
    });
    assertPublishedRefs(completed.refs, refs, input.item);
    await settleDecisions();
    input.metrics?.finishWork(work.work_id);
    runs.push({
      attempt: input.item.logical_attempt as number, retry, tasks: [...input.item.task_ids], triggers,
      refs, run: completed.run, leaseId: completed.leaseId, workId: work.work_id,
    });
    input.options.sink.emit({
      type: "eval.infrastructure-retry.completed", execution_kind: "physical-infrastructure-retry",
      candidate_executes: true, attempt: input.item.logical_attempt, retry, tasks: input.item.task_ids,
      repaired_tasks: refs.filter((ref) => ref.observation_status === "valid").map((ref) => ref.task_id).sort(),
      remaining_tasks: candidates.map((ref) => ref.task_id).sort(), provider: input.item.provider,
    });
    if (completed.run.backend.process_exit_code !== 0 || completed.run.rawResult === null) break;
  }
  return { progress: input.currentProgress?.() ?? progress, runs };
}

function assertSelectedTrial(ref: EvalTrialRefV1, item: BackendWorkItemV1): void {
  if (ref.attempt !== item.logical_attempt || !item.task_ids.includes(ref.task_id)) {
    throw new HitchError(`remote infrastructure retry returned an unselected trial: ${ref.task_id}#${ref.attempt}`, {
      code: "eval_infrastructure_retry_trial_mismatch", exitCode: 12,
    });
  }
}

function assertPublishedRefs(returned: readonly EvalTrialRefV1[], published: readonly EvalTrialRefV1[], item: BackendWorkItemV1): void {
  for (const ref of returned) assertSelectedTrial(ref, item);
  if (returned.length !== published.length || returned.some((ref) => !published.some((entry) => JSON.stringify(entry) === JSON.stringify(ref)))) {
    throw new HitchError("remote infrastructure retry returned refs that were not durably published", {
      code: "eval_infrastructure_retry_result_mismatch", exitCode: 12,
    });
  }
}
