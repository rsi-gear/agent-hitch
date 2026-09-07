import type { InferenceLockV1, InferenceRuntimeManifestV1, InferenceRuntimeObservationV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";

/** /server_info contains credentials. Persist only this explicit projection. */
export function validateRuntimeObservation(
  value: unknown, imageId: string, gpuUuid: string | null, lock: InferenceLockV1, runtime: InferenceRuntimeManifestV1,
): InferenceRuntimeObservationV1 {
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
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw mismatch("container image ID is missing");
  return {
    schema_version: "1", observed_at: new Date().toISOString(), version: String(info.version),
    device: lock.execution.platform.backend as "cpu" | "cuda", dtype: String(info.dtype),
    kv_cache_dtype: String(info.kv_cache_dtype), attention_backend: String(info.attention_backend),
    sampling_backend: String(info.sampling_backend), context_length: info.context_length as number,
    max_total_num_tokens: tokens as number, max_running_requests: info.max_running_requests as number,
    container_image_id: imageId, gpu_uuid: gpuUuid,
    probe: { api: "responses", max_output_tokens: 8, streaming: true },
  };
}
function normalizeDtype(value: unknown): unknown {
  return ({ bf16: "bfloat16", half: "float16", fp16: "float16", float: "float32" } as Record<string, string>)[String(value)] ?? value;
}
function mismatch(message: string): HitchError {
  return new HitchError(`SGLang runtime observation mismatch: ${message}`, { code: "inference_runtime_mismatch", exitCode: 12 });
}
