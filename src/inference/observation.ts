import type { InferenceLockV1, InferenceRuntimeManifestV1, InferenceRuntimeObservationV1, InferenceRuntimeObservationV2, PythonRuntimeObservationV2 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";

/** /server_info contains credentials. Persist only this explicit projection. */
export function validateRuntimeObservation(
  value: unknown, imageId: string, gpuUuid: string | null, lock: InferenceLockV1, runtime: InferenceRuntimeManifestV1,
): InferenceRuntimeObservationV1 {
  const { info, tokens } = validateEngineInfo(value, gpuUuid, lock, runtime);
  if (runtime.package.kind !== "oci" || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw mismatch("container image ID is missing or runtime is not OCI");
  return {
    schema_version: "1", ...observationFields(info, tokens, gpuUuid, lock), container_image_id: imageId,
  };
}

/** Process observations record the node environment; no fictitious inner OCI image. */
export function validateProcessRuntimeObservation(
  value: unknown, observed: PythonRuntimeObservationV2, gpuUuid: string | null, lock: InferenceLockV1,
  runtime: InferenceRuntimeManifestV1, expectedNode: { node_id: string; generation: string },
): InferenceRuntimeObservationV2 {
  if (runtime.schema_version !== "2" || runtime.package.kind !== "python-env" || observed.kind !== "python-env"
    || observed.node_id !== expectedNode.node_id || observed.generation !== expectedNode.generation
    || observed.environment_digest !== runtime.package.environment_digest || observed.python_version !== runtime.package.python_version
    || observed.packages_digest !== runtime.package.packages_digest
    || (observed.outer_image_digest !== null && !/^sha256:[a-f0-9]{64}$/.test(observed.outer_image_digest))) throw mismatch("model-node Python environment or generation changed");
  const { info, tokens } = validateEngineInfo(value, gpuUuid, lock, runtime);
  return { schema_version: "2", ...observationFields(info, tokens, gpuUuid, lock), runtime: {
    kind: "python-env", node_id: observed.node_id, generation: observed.generation,
    environment_digest: observed.environment_digest, python_version: observed.python_version,
    packages_digest: observed.packages_digest, outer_image_digest: observed.outer_image_digest,
  } };
}

function validateEngineInfo(value: unknown, gpuUuid: string | null, lock: InferenceLockV1, runtime: InferenceRuntimeManifestV1): { info: Record<string, unknown>; tokens: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw mismatch("invalid /server_info response");
  const info = value as Record<string, unknown>;
  const expected: Record<string, unknown> = {
    version: runtime.sglang_version, device: lock.execution.platform.backend,
    dtype: lock.execution.dtype, kv_cache_dtype: lock.execution.kv_cache_dtype,
    attention_backend: lock.execution.attention_backend, sampling_backend: lock.execution.sampling_backend,
    context_length: lock.execution.context_tokens_per_request, max_running_requests: lock.execution.max_running_requests,
    tp_size: 1, dp_size: 1, pp_size: 1,
    disable_radix_cache: lock.execution.prefix_cache.mode === "disabled",
    disable_overlap_schedule: !lock.execution.platform.overlap_schedule,
  };
  for (const [field, wanted] of Object.entries(expected)) {
    const actual = info[field];
    if (field === "dtype" || field === "kv_cache_dtype") {
      if (normalizeDtype(actual) === normalizeDtype(wanted)) continue;
    }
    if (actual !== wanted) throw mismatch(`${field}: expected ${String(wanted)}, engine reported ${String(actual)}`);
  }
  const tokens = info.max_total_num_tokens;
  if (!Number.isSafeInteger(tokens) || (tokens as number) < lock.execution.max_total_tokens) {
    throw mismatch(`engine token pool ${String(tokens)} is smaller than locked budget ${lock.execution.max_total_tokens}`);
  }
  if (lock.execution.platform.backend === "cuda") {
    if (info.mem_fraction_static !== lock.execution.platform.mem_fraction_static) throw mismatch("CUDA memory fraction changed");
    if (!gpuUuid || gpuUuid !== lock.execution.platform.device_constraint) throw mismatch("container GPU UUID differs from the lock");
  } else if (gpuUuid !== null) throw mismatch("CPU service unexpectedly exposes a GPU");
  return { info, tokens: tokens as number };
}

function observationFields(info: Record<string, unknown>, tokens: number, gpuUuid: string | null, lock: InferenceLockV1): Omit<InferenceRuntimeObservationV1, "schema_version" | "container_image_id"> {
  return {
    observed_at: new Date().toISOString(), version: String(info.version),
    device: lock.execution.platform.backend as "cpu" | "cuda", dtype: String(info.dtype),
    kv_cache_dtype: String(info.kv_cache_dtype), attention_backend: String(info.attention_backend),
    sampling_backend: String(info.sampling_backend), context_length: info.context_length as number,
    max_total_num_tokens: tokens as number, max_running_requests: info.max_running_requests as number,
    gpu_uuid: gpuUuid,
    probe: { api: lock.protocol.api, max_output_tokens: 8, streaming: true },
  };
}
function normalizeDtype(value: unknown): unknown {
  return ({ bf16: "bfloat16", half: "float16", fp16: "float16", float: "float32" } as Record<string, string>)[String(value)] ?? value;
}
function mismatch(message: string): HitchError {
  return new HitchError(`SGLang runtime observation mismatch: ${message}`, { code: "inference_runtime_mismatch", exitCode: 12 });
}
