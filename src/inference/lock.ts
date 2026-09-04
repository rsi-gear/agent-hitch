import { availableParallelism } from "node:os";
import path from "node:path";
import type {
  InferenceLockV1,
  InferenceRuntimeManifestV1,
  LocalInferenceBackend,
  LocalInferenceProfile,
  LocalModelManifestV1,
  Sha256,
} from "../domain/index.js";
import { HitchError, atomicWriteJSON, readJSON, sha256JSON, statePaths } from "../foundation/index.js";
import { inferenceLockIdentity } from "./manifest.js";

export interface BuildInferenceLockOptions {
  backend: Exclude<LocalInferenceBackend, "metal">;
  profile: LocalInferenceProfile;
  deviceConstraint?: string;
  cpuThreads?: number;
}

export function buildInferenceLock(
  model: LocalModelManifestV1,
  runtime: InferenceRuntimeManifestV1,
  options: BuildInferenceLockOptions,
): InferenceLockV1 {
  if (runtime.backend !== options.backend || runtime.package.kind !== "oci") {
    throw new TypeError("runtime backend does not match the lock request");
  }
  if (model.dtype === "unknown") {
    throw new HitchError("model config must declare torch_dtype", { code: "inference_model_unsupported", exitCode: 2 });
  }
  const throughput = options.profile === "throughput";
  const context = Math.min(8_192, model.context_tokens ?? 8_192);
  const maxRunning = throughput ? options.backend === "cuda" ? 8 : 2 : 1;
  const weights = model.files.filter((file) => file.path.endsWith(".safetensors")).reduce((total, file) => total + file.size, 0);
  const memoryBytes = Math.max(2 * 1024 ** 3, Math.ceil(weights * 1.25 + 1024 ** 3));
  const parser = toolParserFor(model.model_type);
  const cpuThreads = Math.max(1, Math.min(options.cpuThreads ?? availableParallelism(), 8));
  const platform = options.backend === "cpu"
    ? {
      backend: "cpu" as const,
      cpu_threads: cpuThreads,
      numa_policy: "single-node" as const,
      cpu_feature_requirement: "amx" as const,
      overlap_schedule: false as const,
    }
    : {
      backend: "cuda" as const,
      ...(options.deviceConstraint ? { device_constraint: options.deviceConstraint } : {}),
      mem_fraction_static: 0.8,
      overlap_schedule: throughput,
      cuda_graph: throughput ? "enabled" as const : "disabled" as const,
    };
  const withoutIdentity: Omit<InferenceLockV1, "inference_id"> = {
    schema_version: "1",
    engine: "sglang",
    model_id: model.model_id,
    runtime_id: runtime.runtime_id,
    profile: options.profile,
    execution: {
      platform,
      load_format: "safetensors",
      dtype: model.dtype,
      quantization: model.quantization,
      tensor_parallel_size: 1,
      data_parallel_size: 1,
      pipeline_parallel_size: 1,
      context_tokens_per_request: context,
      max_running_requests: maxRunning,
      max_queued_requests: maxRunning,
      max_total_tokens: context * (maxRunning + 1),
      chunked_prefill_size: throughput ? Math.min(4_096, context) : -1,
      max_prefill_tokens: context,
      kv_cache_dtype: model.dtype,
      attention_backend: options.backend === "cpu" ? "intel_amx" : "flashinfer",
      sampling_backend: options.backend === "cpu" ? "pytorch" : "flashinfer",
      deterministic_inference: false,
      prefix_cache: {
        mode: throughput ? "radix" : "disabled",
        scope: "eval",
        initial_state: "empty",
      },
      hicache: false,
      speculative_decoding: false,
      cpu_offload_gb: 0,
      startup_timeout_ms: 600_000,
      queue_timeout_ms: 60_000,
      request_timeout_ms: 600_000,
      idle_ttl_ms: 60_000,
    },
    generation: {
      temperature: 0,
      top_p: 1,
      top_k: 0,
      min_p: 0,
      repetition_penalty: 1,
      seed: 0,
      max_output_tokens: Math.min(2_048, Math.max(1, Math.floor(context / 4))),
      override_policy: "reject-conflicts",
    },
    protocol: {
      api: "responses",
      streaming: true,
      tool_calls: parser !== null,
      parallel_tool_calls: false,
      input_modalities: ["text"],
      tool_call_parser: parser,
      reasoning_parser: null,
      compatibility_profile_id: sha256JSON({
        engine: "sglang",
        runtime_id: runtime.runtime_id,
        model_type: model.model_type,
        template_digest: model.template_digest,
        api: "responses",
        tool_call_parser: parser,
      }),
    },
    resources: {
      cpu_millis: options.backend === "cpu" ? cpuThreads * 1_000 : 2_000,
      memory_bytes: memoryBytes,
      container_slots: 1,
      build_slots: 0,
      ...(options.backend === "cuda" ? { gpu_count: 1 } : {}),
      ephemeral_disk_bytes: 4 * 1024 ** 3,
    },
  };
  return { ...withoutIdentity, inference_id: inferenceLockIdentity(withoutIdentity) };
}

export async function persistInferenceLock(root: string, lock: InferenceLockV1): Promise<void> {
  const directory = path.join(statePaths(root).inferenceLocks, lock.inference_id.slice("sha256:".length));
  await atomicWriteJSON(path.join(directory, "lock.json"), lock);
}

export async function loadInferenceLock(root: string, inferenceId: Sha256): Promise<InferenceLockV1> {
  let value: unknown;
  try {
    value = await readJSON(path.join(statePaths(root).inferenceLocks, inferenceId.slice("sha256:".length), "lock.json"));
  } catch (error) {
    throw new HitchError(`inference lock is unavailable: ${inferenceId}`, { code: "inference_lock_mismatch", exitCode: 2, cause: error });
  }
  const lock = validateInferenceLockShape(value);
  if (lock.inference_id !== inferenceId) {
    throw new HitchError("inference lock path and identity do not match", { code: "inference_lock_mismatch", exitCode: 5 });
  }
  return lock;
}

export function validateInferenceLockShape(value: unknown): InferenceLockV1 {
  const record = exact(value, ["schema_version", "engine", "model_id", "runtime_id", "inference_id", "profile", "execution", "generation", "protocol", "resources"], "inference lock");
  if (record.schema_version !== "1" || record.engine !== "sglang"
    || !digest(record.model_id) || !digest(record.runtime_id) || !digest(record.inference_id)
    || (record.profile !== "baseline" && record.profile !== "throughput")) throw lockError("inference lock identity is invalid");
  const execution = parseExecution(record.execution);
  const generation = parseGeneration(record.generation);
  const protocol = parseProtocol(record.protocol);
  const resources = parseResources(record.resources, execution.platform.backend);
  const lock: InferenceLockV1 = {
    schema_version: "1", engine: "sglang", model_id: record.model_id, runtime_id: record.runtime_id,
    inference_id: record.inference_id, profile: record.profile, execution, generation, protocol, resources,
  };
  validateProfile(lock);
  const { inference_id: _inferenceId, ...identity } = lock;
  if (inferenceLockIdentity(identity) !== lock.inference_id) throw lockError("inference lock identity mismatch");
  return lock;
}

function parseExecution(value: unknown): InferenceLockV1["execution"] {
  const record = exact(value, [
    "platform", "load_format", "dtype", "quantization", "tensor_parallel_size", "data_parallel_size", "pipeline_parallel_size",
    "context_tokens_per_request", "max_running_requests", "max_queued_requests", "max_total_tokens", "chunked_prefill_size",
    "max_prefill_tokens", "kv_cache_dtype", "attention_backend", "sampling_backend", "deterministic_inference", "prefix_cache",
    "hicache", "speculative_decoding", "cpu_offload_gb", "startup_timeout_ms", "queue_timeout_ms", "request_timeout_ms", "idle_ttl_ms",
  ], "inference execution");
  if (record.load_format !== "safetensors" || record.tensor_parallel_size !== 1 || record.data_parallel_size !== 1
    || record.pipeline_parallel_size !== 1 || typeof record.dtype !== "string" || !record.dtype
    || record.quantization !== null && (typeof record.quantization !== "string" || !record.quantization)
    || typeof record.deterministic_inference !== "boolean" || record.hicache !== false
    || record.speculative_decoding !== false || record.cpu_offload_gb !== 0) throw lockError("inference execution configuration is invalid");
  const prefix = exact(record.prefix_cache, ["mode", "scope", "initial_state"], "inference prefix cache");
  if ((prefix.mode !== "disabled" && prefix.mode !== "radix") || (prefix.scope !== "run" && prefix.scope !== "eval") || prefix.initial_state !== "empty") {
    throw lockError("inference prefix cache configuration is invalid");
  }
  const positiveFields = [
    "context_tokens_per_request", "max_running_requests", "max_total_tokens", "max_prefill_tokens",
    "startup_timeout_ms", "queue_timeout_ms", "request_timeout_ms",
  ] as const;
  for (const field of positiveFields) positiveInteger(record[field], `inference execution ${field}`);
  nonNegativeInteger(record.max_queued_requests, "inference execution max_queued_requests");
  nonNegativeInteger(record.idle_ttl_ms, "inference execution idle_ttl_ms");
  if (!Number.isSafeInteger(record.chunked_prefill_size) || (record.chunked_prefill_size as number) < -1) throw lockError("inference chunked prefill size is invalid");
  if ((record.max_total_tokens as number) < (record.context_tokens_per_request as number)
    || (record.max_prefill_tokens as number) > (record.context_tokens_per_request as number)) {
    throw lockError("inference token budgets are inconsistent");
  }
  const platform = parsePlatform(record.platform);
  return {
    platform,
    load_format: "safetensors",
    dtype: record.dtype,
    quantization: record.quantization as string | null,
    tensor_parallel_size: 1, data_parallel_size: 1, pipeline_parallel_size: 1,
    context_tokens_per_request: record.context_tokens_per_request as number,
    max_running_requests: record.max_running_requests as number,
    max_queued_requests: record.max_queued_requests as number,
    max_total_tokens: record.max_total_tokens as number,
    chunked_prefill_size: record.chunked_prefill_size as number,
    max_prefill_tokens: record.max_prefill_tokens as number,
    kv_cache_dtype: nonEmptyString(record.kv_cache_dtype, "inference KV cache dtype"),
    attention_backend: nonEmptyString(record.attention_backend, "inference attention backend"),
    sampling_backend: nonEmptyString(record.sampling_backend, "inference sampling backend"),
    deterministic_inference: record.deterministic_inference,
    prefix_cache: { mode: prefix.mode, scope: prefix.scope, initial_state: "empty" },
    hicache: false, speculative_decoding: false, cpu_offload_gb: 0,
    startup_timeout_ms: record.startup_timeout_ms as number,
    queue_timeout_ms: record.queue_timeout_ms as number,
    request_timeout_ms: record.request_timeout_ms as number,
    idle_ttl_ms: record.idle_ttl_ms as number,
  };
}

function parsePlatform(value: unknown): InferenceLockV1["execution"]["platform"] {
  const base = exactRecord(value, "inference platform");
  if (base.backend === "cpu") {
    const record = exact(base, ["backend", "cpu_threads", "numa_policy", "cpu_feature_requirement", "overlap_schedule"], "CPU inference platform");
    if (record.numa_policy !== "single-node" || record.cpu_feature_requirement !== "amx" || record.overlap_schedule !== false) throw lockError("CPU inference platform is invalid");
    return { backend: "cpu", cpu_threads: positiveInteger(record.cpu_threads, "CPU inference threads"), numa_policy: "single-node", cpu_feature_requirement: "amx", overlap_schedule: false };
  }
  if (base.backend === "cuda") {
    const record = exact(base, ["backend", "device_constraint", "mem_fraction_static", "overlap_schedule", "cuda_graph"], "CUDA inference platform");
    if (record.device_constraint !== undefined && (typeof record.device_constraint !== "string" || !record.device_constraint)
      || typeof record.mem_fraction_static !== "number" || !Number.isFinite(record.mem_fraction_static)
      || record.mem_fraction_static <= 0 || record.mem_fraction_static > 1 || typeof record.overlap_schedule !== "boolean"
      || record.cuda_graph !== "enabled" && record.cuda_graph !== "disabled") throw lockError("CUDA inference platform is invalid");
    return { backend: "cuda", ...(record.device_constraint ? { device_constraint: record.device_constraint as string } : {}), mem_fraction_static: record.mem_fraction_static, overlap_schedule: record.overlap_schedule, cuda_graph: record.cuda_graph };
  }
  if (base.backend === "metal") {
    const record = exact(base, ["backend", "mlx_quantization", "overlap_schedule"], "Metal inference platform");
    if (record.mlx_quantization !== "none" && record.mlx_quantization !== "prequantized" || typeof record.overlap_schedule !== "boolean") throw lockError("Metal inference platform is invalid");
    return { backend: "metal", mlx_quantization: record.mlx_quantization, overlap_schedule: record.overlap_schedule };
  }
  throw lockError("inference platform backend is invalid");
}

function parseGeneration(value: unknown): InferenceLockV1["generation"] {
  const record = exact(value, ["temperature", "top_p", "top_k", "min_p", "repetition_penalty", "seed", "max_output_tokens", "override_policy"], "inference generation");
  const finite = (field: string): number => {
    const number = record[field];
    if (typeof number !== "number" || !Number.isFinite(number)) throw lockError(`inference generation ${field} is invalid`);
    return number;
  };
  const temperature = finite("temperature"), topP = finite("top_p"), minP = finite("min_p"), penalty = finite("repetition_penalty");
  if (temperature < 0 || topP < 0 || topP > 1 || minP < 0 || minP > 1 || penalty <= 0
    || !Number.isSafeInteger(record.top_k) || (record.top_k as number) < 0 || !Number.isSafeInteger(record.seed)
    || record.override_policy !== "reject-conflicts") throw lockError("inference generation configuration is invalid");
  return { temperature, top_p: topP, top_k: record.top_k as number, min_p: minP, repetition_penalty: penalty,
    seed: record.seed as number, max_output_tokens: positiveInteger(record.max_output_tokens, "inference max output tokens"), override_policy: "reject-conflicts" };
}

function parseProtocol(value: unknown): InferenceLockV1["protocol"] {
  const record = exact(value, ["api", "streaming", "tool_calls", "parallel_tool_calls", "input_modalities", "tool_call_parser", "reasoning_parser", "compatibility_profile_id"], "inference protocol");
  if (record.api !== "responses" && record.api !== "chat-completions" || typeof record.streaming !== "boolean"
    || typeof record.tool_calls !== "boolean" || typeof record.parallel_tool_calls !== "boolean"
    || !Array.isArray(record.input_modalities) || record.input_modalities.length !== 1 || record.input_modalities[0] !== "text"
    || record.tool_call_parser !== null && (typeof record.tool_call_parser !== "string" || !record.tool_call_parser)
    || record.reasoning_parser !== null && (typeof record.reasoning_parser !== "string" || !record.reasoning_parser)
    || !digest(record.compatibility_profile_id) || record.parallel_tool_calls && !record.tool_calls) throw lockError("inference protocol configuration is invalid");
  return { api: record.api, streaming: record.streaming, tool_calls: record.tool_calls, parallel_tool_calls: record.parallel_tool_calls,
    input_modalities: ["text"], tool_call_parser: record.tool_call_parser as string | null,
    reasoning_parser: record.reasoning_parser as string | null, compatibility_profile_id: record.compatibility_profile_id };
}

function parseResources(value: unknown, backend: "cpu" | "cuda" | "metal"): InferenceLockV1["resources"] {
  const record = exact(value, ["cpu_millis", "memory_bytes", "container_slots", "build_slots", "gpu_count", "ephemeral_disk_bytes"], "inference resources");
  const resources = {
    cpu_millis: positiveInteger(record.cpu_millis, "inference CPU reservation"),
    memory_bytes: positiveInteger(record.memory_bytes, "inference memory reservation"),
    container_slots: positiveInteger(record.container_slots, "inference container reservation"),
    build_slots: nonNegativeInteger(record.build_slots, "inference build reservation"),
    ...(record.gpu_count === undefined ? {} : { gpu_count: nonNegativeInteger(record.gpu_count, "inference GPU reservation") }),
    ...(record.ephemeral_disk_bytes === undefined ? {} : { ephemeral_disk_bytes: nonNegativeInteger(record.ephemeral_disk_bytes, "inference disk reservation") }),
  };
  if (resources.build_slots !== 0 || backend === "cuda" && resources.gpu_count !== 1
    || backend !== "cuda" && (resources.gpu_count ?? 0) !== 0) throw lockError("inference resource/backend combination is invalid");
  return resources;
}

function validateProfile(lock: InferenceLockV1): void {
  const throughput = lock.profile === "throughput";
  const expectedRunning = throughput ? lock.execution.platform.backend === "cuda" ? 8 : 2 : 1;
  if (lock.execution.max_running_requests !== expectedRunning || lock.execution.max_queued_requests !== expectedRunning
    || throughput !== (lock.execution.prefix_cache.mode === "radix") || lock.execution.prefix_cache.scope !== "eval") {
    throw lockError("inference lock does not match its profile");
  }
}

function exact(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  const record = exactRecord(value, label);
  const allowed = new Set(fields);
  const unknown = Object.keys(record).find((field) => !allowed.has(field));
  if (unknown) throw lockError(`${label} has unknown field: ${unknown}`);
  return record;
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw lockError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw lockError(`${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw lockError(`${label} must be a positive safe integer`);
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw lockError(`${label} must be a non-negative safe integer`);
  return value as number;
}

function toolParserFor(modelType: string): string | null {
  if (/^qwen(?:2|3)/.test(modelType)) return "qwen25";
  if (/^llama/.test(modelType)) return "llama3";
  return null;
}

function digest(value: unknown): value is Sha256 {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function lockError(message: string): HitchError {
  return new HitchError(message, { code: "inference_lock_mismatch", exitCode: 5 });
}
