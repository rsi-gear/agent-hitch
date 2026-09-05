import type { HarborBackendResult, LocalGitTransportUse } from "../backends/index.js";
import type { EvalId, EvalProgressV1, EvalRequest, EvalSchedulerSummaryV1 } from "../domain/index.js";
import { SCHEMA_VERSION } from "../foundation/index.js";
import { preparedArtifactPlanFields, type PreparedEvalArtifactAssignment } from "./eval-artifact-planning.js";
import { infrastructureFailureTrials, type InfrastructureRetryRun } from "./infrastructure-retry.js";
import { invalidTrialSlots } from "./rerun-slots.js";
import { localSourceBackendFailure, summarizeTrialRefs, transportSummary } from "./result-helpers.js";
import type { EvalResult } from "./service-types.js";

interface CompletedBackendRun {
  attempt: number;
  run: HarborBackendResult;
  workId?: string;
  tasks?: string[];
  leaseId?: string;
}

export function buildCompletedEvalResult(input: {
  evalId: EvalId;
  request: EvalRequest;
  plannedTaskExecution: boolean;
  plannedTrials: number | null;
  executionWorkItems: number;
  localTaskIds: string[] | null;
  backendRuns: CompletedBackendRun[];
  infrastructureRetryRuns: InfrastructureRetryRun[];
  candidate: unknown;
  progress: EvalProgressV1;
  schedulerSummary?: EvalSchedulerSummaryV1;
  preparedAssignments: readonly PreparedEvalArtifactAssignment[];
  localTransport?: LocalGitTransportUse;
  startedAt: Date;
  cancelled: boolean;
}): EvalResult {
  const trialRefs = input.progress.trials;
  const localSourceFailure = input.localTransport
    ? input.backendRuns.some(({ run }) => localSourceBackendFailure(run.rawResult))
      || input.infrastructureRetryRuns.some(({ run }) => localSourceBackendFailure(run.rawResult))
    : false;
  const expectedBackendRuns = input.plannedTaskExecution ? input.executionWorkItems : input.request.attempts;
  const backendsSucceeded = input.backendRuns.every(({ run }) => run.backend.process_exit_code === 0 && run.rawResult !== null)
    && (input.plannedTaskExecution ? trialRefs.length === input.plannedTrials : input.backendRuns.length === expectedBackendRuns);
  const invalidTrials = input.localTaskIds === null
    ? trialRefs.filter((trial) => trial.observation_status !== "valid").map((trial) => ({ task_id: trial.task_id, attempt: trial.attempt }))
    : invalidTrialSlots(input.localTaskIds, input.request.attempts, input.progress);
  const infrastructureFailures = infrastructureFailureTrials(trialRefs);
  const infrastructureFailureSlots = infrastructureFailures.map((trial) => ({ task_id: trial.task_id, attempt: trial.attempt }));
  const verifierRetriesExhausted = input.request.infrastructure_retries > 0
    && infrastructureFailures.some((trial) => trial.invalid_reason === "verifier_infrastructure_failure");
  const infrastructureErrorCode = verifierRetriesExhausted
    || (input.request.infrastructure_retries > 0 && input.infrastructureRetryRuns.length > 0)
    ? "eval_infrastructure_retries_exhausted"
    : "eval_has_infrastructure_failures";
  const succeeded = !input.cancelled && !localSourceFailure && backendsSucceeded && invalidTrials.length === 0;
  const singleBackend = input.backendRuns.length === 1 ? input.backendRuns[0]!.run : undefined;
  return {
    schema_version: SCHEMA_VERSION,
    eval_id: input.evalId,
    status: input.cancelled ? "cancelled" : succeeded ? "succeeded" : "failed",
    exit_code: input.cancelled ? 9 : succeeded ? 0 : 13,
    ...(singleBackend ? { backend: singleBackend.backend, backend_summary: singleBackend.summary } : {}),
    ...(input.plannedTaskExecution ? {
      backend_work_items: input.backendRuns.map(({ attempt, workId, tasks, leaseId, run }) => ({
        work_id: workId, lease_id: leaseId, attempt, tasks, backend: run.backend, backend_summary: run.summary,
      })),
    } : input.request.attempts > 1 ? {
      backend_runs: input.backendRuns.map(({ attempt, run }) => ({ attempt, backend: run.backend, backend_summary: run.summary })),
    } : {}),
    infrastructure_retry_policy: {
      max_retries: input.request.infrastructure_retries,
      backoff_ms: input.request.infrastructure_retry_backoff_ms,
      verifier_execution: "same_trial_verifier_only",
      candidate_rerun_on_verifier_failure: false,
    },
    ...(input.infrastructureRetryRuns.length > 0 ? {
      infrastructure_retry_runs: input.infrastructureRetryRuns.map(({ attempt, retry, tasks, triggers, refs, run, leaseId, workId }) => ({
        execution_kind: "physical-infrastructure-retry", ...(leaseId ? { lease_id: leaseId } : {}),
        ...(workId ? { work_id: workId } : {}), attempt, retry, tasks, trigger_trials: triggers,
        trials: refs, backend: run.backend, backend_summary: run.summary,
      })),
    } : {}),
    candidate: input.candidate,
    dataset: input.request.dataset,
    benchmark_id: input.request.benchmark_id,
    benchmark_revision: input.request.benchmark_revision,
    generation: input.progress.generation,
    trials: trialRefs,
    summary: summarizeTrialRefs(trialRefs),
    ...(input.schedulerSummary ? { scheduler_summary: input.schedulerSummary } : {}),
    ...preparedArtifactPlanFields(input.preparedAssignments),
    ...(input.localTransport ? { local_source_transport: transportSummary(input.localTransport) } : {}),
    ...(succeeded ? {} : {
      error: {
        code: input.cancelled ? "cancelled" : localSourceFailure ? "local_source_materialize_failed"
          : !backendsSucceeded ? "harbor_failed" : infrastructureFailures.length > 0
            ? infrastructureErrorCode : "eval_has_invalid_tasks",
        message: input.cancelled ? "eval was cancelled"
          : localSourceFailure ? "Harbor rejected the transported local Git source before candidate execution"
            : !backendsSucceeded ? `Harbor work items completed ${input.backendRuns.length}/${expectedBackendRuns}`
              : infrastructureFailures.length > 0
                ? `${infrastructureErrorCode === "eval_infrastructure_retries_exhausted" ? "infrastructure retries exhausted" : "verifier infrastructure failure"}: ${infrastructureFailureSlots.map(trial => `${trial.task_id}#${trial.attempt}`).join(", ")}`
                : `eval has invalid or missing trials: ${invalidTrials.map(trial => `${trial.task_id}#${trial.attempt}`).join(", ")}`,
      },
    }),
    started_at: input.startedAt.toISOString(),
    completed_at: new Date().toISOString(),
  };
}
