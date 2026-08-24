export interface EvalTrialRefV1 {
  trial_id: string;
  run_id: string;
  task_id: string;
  attempt: number;
  observation_status: "valid" | "invalid";
  reward?: number;
  verifier_result_ref?: string;
  invalid_reason?: string;
}

export interface EvalResultV1 {
  schema_version: "1";
  eval_id: string;
  benchmark_id: string;
  benchmark_revision: string;
  status: "succeeded" | "failed" | "cancelled";
  trials: EvalTrialRefV1[];
  started_at: string;
  completed_at: string;
}
