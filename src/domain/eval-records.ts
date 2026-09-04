import type { BenchmarkPhaseGroupRefV1 } from "./runs.js";

interface EvalTrialObservationV1 {
  trial_id: string;
  task_id: string;
  attempt: number;
  observation_status: "valid" | "invalid";
  reward?: number;
  verifier_result_ref?: string;
  invalid_reason?: string;
}

/** A whole trial references either one original run or the complete phase group. */
export type EvalTrialRefV1 = EvalTrialObservationV1 & (
  { run_id: string; run_group?: never; assessment?: { id: string; digest: string } }
  | { run_id?: never; run_group: BenchmarkPhaseGroupRefV1; assessment: { id: string; digest: string } }
);

export interface EvalSchedulerSummaryV1 {
  policy: "fifo-compat" | "critical-path-lpt-v1";
  makespan_ms: number;
  physical_work_ms: number;
  initial_work_ms: number;
  retry_work_ms: number;
  verifier_work_ms: number;
  max_active: number;
  effective_parallelism: number;
  slot_utilization: number;
  single_active_tail_ms: number;
  resource_blocked_ms: number;
  collision_blocked_ms: number;
  backoff_blocked_ms: number;
  verifier_skipped: number;
}

export interface EvalResultV1 {
  schema_version: "1";
  eval_id: string;
  benchmark_id: string;
  benchmark_revision: string;
  status: "succeeded" | "failed" | "cancelled";
  generation?: number;
  trials: EvalTrialRefV1[];
  scheduler_summary?: EvalSchedulerSummaryV1;
  started_at: string;
  completed_at: string;
}

export interface EvalProgressV1 {
  schema_version: "1";
  eval_id: string;
  benchmark_id: string;
  benchmark_revision: string;
  status: "running";
  generation: number;
  planned_tasks: number | null;
  planned_trials: number | null;
  trials: EvalTrialRefV1[];
  summary: {
    settled_trials: number;
    valid_trials: number;
    invalid_trials: number;
  };
  started_at: string;
  updated_at: string;
}
