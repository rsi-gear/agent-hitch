export interface EvalTrialRefV1 {
  trial_id: string;
  run_id: string;
  task_id: string;
  attempt: number;
  observation_status: "valid" | "invalid";
  reward?: number;
  verifier_result_ref?: string;
  invalid_reason?: string;
  /** Separate immutable verifier evidence; run_id still names the original candidate. */
  assessment?: { id: string; digest: string };
}

export interface EvalResultV1 {
  schema_version: "1";
  eval_id: string;
  benchmark_id: string;
  benchmark_revision: string;
  status: "succeeded" | "failed" | "cancelled";
  generation?: number;
  trials: EvalTrialRefV1[];
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
