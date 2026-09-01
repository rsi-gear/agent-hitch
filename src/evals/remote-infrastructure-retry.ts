import { setTimeout as delay } from "node:timers/promises";
import type { BackendWorkItemV1, EvalProgressV1, EvalTrialRefV1 } from "../domain/index.js";
import { HitchError, sha256JSON } from "../foundation/index.js";
import type { InfrastructureRetryRun } from "./infrastructure-retry.js";
import { retryableInfrastructureTrials } from "./infrastructure-retry.js";
import type { ExecutePlannedHarborOptions, PlannedBackendRun } from "./planned-execution.js";
import { replaceInvalidEvalProgressTrial, writeEvalProgress } from "./progress.js";

export async function runRemoteInfrastructureRetries(input: {
  options: ExecutePlannedHarborOptions;
  item: BackendWorkItemV1;
  initial: PlannedBackendRun;
  progress: EvalProgressV1;
}): Promise<{ progress: EvalProgressV1; runs: InfrastructureRetryRun[] }> {
  const executor = input.options.remoteWorkExecutor;
  if (!executor) throw new TypeError("remote work executor is unavailable");
  let progress = input.progress;
  let candidates = retryableInfrastructureTrials(input.initial.refs);
  const runs: InfrastructureRetryRun[] = [];
  for (let retry = 1; retry <= input.options.request.infrastructure_retries && candidates.length > 0; retry += 1) {
    if (input.options.signal?.aborted) break;
    const triggers = [...candidates];
    const backoffMs = input.options.request.infrastructure_retry_backoff_ms * retry;
    input.options.sink.emit({
      type: "eval.infrastructure-retry.scheduled", execution_kind: "physical-infrastructure-retry",
      candidate_executes: true, attempt: input.item.logical_attempt, retry,
      tasks: input.item.task_ids, backoff_ms: backoffMs, provider: input.item.provider,
    });
    if (backoffMs > 0) await delay(backoffMs, undefined, input.options.signal ? { signal: input.options.signal } : undefined);
    if (input.options.signal?.aborted) break;
    const work = retryWorkItem(input.item, retry);
    const refs: EvalTrialRefV1[] = [];
    const publish = async (ref: EvalTrialRefV1): Promise<void> => {
      assertSelectedTrial(ref, input.item);
      const existing = refs.find((entry) => entry.trial_id === ref.trial_id || entry.run_id === ref.run_id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(ref)) throw new Error(`remote retry trial identity changed: ${ref.trial_id}`);
        return;
      }
      refs.push(ref);
      if (ref.observation_status === "valid") {
        progress = replaceInvalidEvalProgressTrial(progress, ref);
        await writeEvalProgress(input.options.evalDirectory, progress);
      }
      input.options.sink.emit({
        type: ref.observation_status === "valid" ? "eval.infrastructure-retry.repaired" : "eval.infrastructure-retry.failed",
        attempt: input.item.logical_attempt, retry, task_id: ref.task_id, trial_id: ref.trial_id,
        run_id: ref.run_id, observation_status: ref.observation_status,
        ...(ref.invalid_reason ? { invalid_reason: ref.invalid_reason } : {}), generation: progress.generation,
      });
    };
    const completed = await executor({
      evalId: input.options.evalId, evalDirectory: input.options.evalDirectory, root: input.options.root,
      request: input.options.request, plan: input.options.plan, workItem: work,
      resolvedRevision: input.options.resolvedRevision, preparedArtifact: input.options.preparedArtifact,
      runtimeDirectory: input.options.controllerRuntime.directory, runtimeId: input.options.controllerRuntime.runtime_id,
      ...(input.initial.environmentImages ? { environmentImages: input.initial.environmentImages } : {}),
      ...(input.options.plan.model_capture ? { modelCapturePlan: input.options.plan.model_capture } : {}),
      ...(input.options.signal ? { signal: input.options.signal } : {}),
      emit: (event) => input.options.sink.emit({ ...event, execution_kind: "physical-infrastructure-retry", infrastructure_retry: retry }),
      publish,
      onLeaseState: (leaseId, state) => input.options.onWorkItemState?.(work.work_id, leaseId, state) ?? Promise.resolve(),
    });
    assertPublishedRefs(completed.refs, refs, input.item);
    candidates = retryableInfrastructureTrials(refs);
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
  return { progress, runs };
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

function retryWorkItem(item: BackendWorkItemV1, retry: number): BackendWorkItemV1 {
  const identity = sha256JSON({ work_id: item.work_id, execution_kind: "physical-infrastructure-retry", retry });
  return { ...item, work_id: `work_${identity.slice("sha256:".length, "sha256:".length + 32)}` };
}
