import type { ResourceVectorV1 } from "./resources.js";
import type { Sha256 } from "./ids.js";

export type LocalInferenceBackend = "cpu" | "cuda" | "metal";
export type LocalInferenceDevice = LocalInferenceBackend | "auto";
export type LocalInferenceProfile = "baseline" | "throughput";

export interface LocalModelFileV1 {
  path: string;
  size: number;
  sha256: Sha256;
}

export interface LocalModelManifestV1 {
  schema_version: "1";
  model_id: Sha256;
  format: "hf-safetensors";
  files: LocalModelFileV1[];
  architecture: string;
  model_type: string;
  dtype: string;
  quantization: string | null;
  context_tokens: number | null;
  tokenizer_digest: Sha256;
  template_digest: Sha256 | null;
  source: {
    kind: "local-directory";
    label: string;
    license: string | null;
  };
  created_at: string;
}

export interface OciInferenceRuntimeV1 {
  kind: "oci";
  image: string;
  image_digest: Sha256;
  platform: "linux/amd64";
}

export interface PythonInferenceRuntimeV1 {
  kind: "python-env";
  environment_digest: Sha256;
  python_version: string;
  packages_digest: Sha256;
}

export interface InferenceRuntimeManifestV1 {
  schema_version: "1";
  runtime_id: Sha256;
  engine: "sglang";
  sglang_version: string;
  sglang_commit: string;
  backend: LocalInferenceBackend;
  package: OciInferenceRuntimeV1 | PythonInferenceRuntimeV1;
  compatibility_profile: string;
}

export interface SGLangCpuConfigV1 {
  backend: "cpu";
  cpu_threads: number;
  numa_policy: "single-node";
  cpu_feature_requirement: "amx";
  overlap_schedule: false;
}

export interface SGLangCudaConfigV1 {
  backend: "cuda";
  device_constraint?: string;
  mem_fraction_static: number;
  overlap_schedule: boolean;
  cuda_graph: "enabled" | "disabled";
}

export interface SGLangMetalConfigV1 {
  backend: "metal";
  mlx_quantization: "none" | "prequantized";
  overlap_schedule: boolean;
}

export type SGLangBackendConfigV1 = SGLangCpuConfigV1 | SGLangCudaConfigV1 | SGLangMetalConfigV1;

export interface InferenceLockV1 {
  schema_version: "1";
  engine: "sglang";
  model_id: Sha256;
  runtime_id: Sha256;
  inference_id: Sha256;
  profile: LocalInferenceProfile;
  execution: {
    platform: SGLangBackendConfigV1;
    load_format: "safetensors";
    dtype: string;
    quantization: string | null;
    tensor_parallel_size: 1;
    data_parallel_size: 1;
    pipeline_parallel_size: 1;
    context_tokens_per_request: number;
    max_running_requests: number;
    max_queued_requests: number;
    max_total_tokens: number;
    chunked_prefill_size: number;
    max_prefill_tokens: number;
    kv_cache_dtype: string;
    attention_backend: string;
    sampling_backend: string;
    deterministic_inference: boolean;
    prefix_cache: {
      mode: "disabled" | "radix";
      scope: "run" | "eval";
      initial_state: "empty";
    };
    hicache: false;
    speculative_decoding: false;
    cpu_offload_gb: 0;
    startup_timeout_ms: number;
    queue_timeout_ms: number;
    request_timeout_ms: number;
    idle_ttl_ms: number;
  };
  generation: {
    temperature: number;
    top_p: number;
    top_k: number;
    min_p: number;
    repetition_penalty: number;
    seed: number;
    max_output_tokens: number;
    override_policy: "reject-conflicts";
  };
  protocol: {
    api: "responses" | "chat-completions";
    streaming: boolean;
    tool_calls: boolean;
    parallel_tool_calls: boolean;
    input_modalities: ["text"];
    tool_call_parser: string | null;
    reasoning_parser: string | null;
    compatibility_profile_id: Sha256;
  };
  resources: ResourceVectorV1;
}

export interface LocalInferenceSelectionV1 {
  model: string;
  device: LocalInferenceDevice;
  profile: LocalInferenceProfile;
  offline: boolean;
  inference_id?: Sha256;
}

export interface InferenceServiceRecordV1 {
  schema_version: "1";
  service_id: string;
  inference_id: Sha256;
  isolation_key: Sha256;
  state: "starting" | "ready" | "draining" | "stopped" | "failed";
  epoch: number;
  owner_id: string;
  lease_owner_ids: string[];
  backend: LocalInferenceBackend;
  container_id?: string;
  pid?: number;
  base_url?: string;
  started_at: string;
  updated_at: string;
  error?: { code: string; message: string };
}

export interface ModelEndpointBindingV1 {
  kind: "managed-local";
  inference_id: Sha256;
  api: "responses" | "chat-completions";
  base_url: string;
  wire_model: string;
  credential_env_name: "HITCH_LOCAL_MODEL_TOKEN";
  capabilities: {
    streaming: boolean;
    tool_calls: boolean;
    parallel_tool_calls: boolean;
    input_modalities: ["text"];
  };
}

export interface AcquireManagedInferenceInputV1 {
  run_id: string;
  harness_ref: string;
  selection: LocalInferenceSelectionV1;
  cache_scope_owner: string;
  /** Eval callers use one private gateway registration while Harbor assigns the individual trial run IDs. */
  evidence_owner?: { kind: "eval"; eval_id: string; rerun_id?: string };
  signal?: AbortSignal;
  on_event?: (event: Record<string, unknown>) => void;
}

export interface ManagedInferenceLeaseV1 {
  binding: ModelEndpointBindingV1;
  credential: string;
  lock: InferenceLockV1;
  service_id: string;
  service_epoch: number;
  release(): Promise<void>;
}

export interface ManagedInferenceCoordinator {
  acquire(input: AcquireManagedInferenceInputV1): Promise<ManagedInferenceLeaseV1>;
}
