import type { LocalInferenceSelectionV1 } from "./inference.js";
import type { TrainingExternalBindingV1 } from "./training.js";
import type { ApprovedResourceConfigurationV1 } from "./resource-profiles.js";

/** Exact content selected before submission; local cache paths are not identity. */
export interface EvalArtifactPinV1 {
  platform: "linux-x64" | "linux-arm64";
  artifact_id: string;
  artifact_integrity: string;
  entrypoint_integrity: string;
}

export interface EvalRequest {
  schema_version: string;
  backend: "harbor";
  dataset: string;
  harness_ref: string;
  model: string;
  attempts: number;
  max_concurrent: number;
  infrastructure_retries: number;
  infrastructure_retry_backoff_ms: number;
  timeout_ms: number;
  setup_timeout_ms: number;
  agent_args: string[];
  pass_env: string[];
  benchmark_id: string;
  benchmark_revision: string;
  local_inference?: LocalInferenceSelectionV1;
  endpoint_binding?: import("./endpoints.js").ExternalEndpointBindingV1;
  training_binding?: TrainingExternalBindingV1;
  /** Private resident environment and resolved host credentials, prepared by the daemon. */
  environment_binding?: string;
  artifact_pins?: EvalArtifactPinV1[];
  resource_config?: ApprovedResourceConfigurationV1;
}
