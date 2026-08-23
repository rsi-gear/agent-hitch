export interface EvalRequest {
  schema_version: string;
  backend: "harbor";
  dataset: string;
  harness_ref: string;
  model: string;
  attempts: number;
  max_concurrent: number;
  timeout_ms: number;
  setup_timeout_ms: number;
  agent_args: string[];
  pass_env: string[];
  benchmark_id: string;
  benchmark_revision: string;
}
