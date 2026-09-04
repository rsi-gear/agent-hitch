import type {
  InferenceLockV1,
  InferenceRuntimeManifestV1,
  LocalInferenceSelectionV1,
  LocalModelManifestV1,
} from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import type { InferenceDoctorOptions, InferenceDoctorResultV1 } from "./doctor.js";
import { resolveLocalInferenceDevice } from "./doctor.js";
import { buildInferenceLock, loadInferenceLock, persistInferenceLock } from "./lock.js";
import { resolveLocalModel, verifyLocalModel } from "./model-store.js";
import { loadInferenceRuntime, prepareInferenceRuntime } from "./runtime-store.js";
import type { PrepareInferenceRuntimeOptions } from "./runtime-store.js";

export interface LocalInferencePreflightOptions {
  root: string;
  selection: LocalInferenceSelectionV1;
  harnessRef?: string;
  doctor?: InferenceDoctorOptions;
  runtime?: Omit<PrepareInferenceRuntimeOptions, "root" | "backend" | "offline">;
  onProgress?: (message: string) => void;
}

export interface LocalInferencePreflightResultV1 {
  model: LocalModelManifestV1;
  runtime: InferenceRuntimeManifestV1;
  lock: InferenceLockV1;
  doctor?: InferenceDoctorResultV1;
  runtime_cache_hit: boolean;
}

export async function prepareLocalInference(options: LocalInferencePreflightOptions): Promise<LocalInferencePreflightResultV1> {
  const model = await resolveLocalModel(options.root, options.selection.model);
  await verifyLocalModel(options.root, model);
  if (options.selection.inference_id) {
    const lock = await loadInferenceLock(options.root, options.selection.inference_id);
    if (lock.model_id !== model.model_id) {
      throw new HitchError("prepared inference identity refers to a different model", { code: "inference_lock_mismatch", exitCode: 2 });
    }
    assertHarnessCompatibility(options.harnessRef, lock);
    return {
      model,
      runtime: await loadInferenceRuntime(options.root, lock.runtime_id),
      lock,
      runtime_cache_hit: true,
    };
  }
  const resolved = await resolveLocalInferenceDevice(options.selection.device, options.doctor);
  if (resolved.backend === "metal") {
    throw new HitchError("Metal local inference is not available in P0", { code: "inference_device_unsupported", exitCode: 3 });
  }
  const prepared = await prepareInferenceRuntime({
    ...options.runtime,
    root: options.root,
    backend: resolved.backend,
    offline: options.selection.offline,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  const lock = buildInferenceLock(model, prepared.manifest, {
    backend: resolved.backend,
    profile: options.selection.profile,
    ...(resolved.doctor.gpu?.uuid ? { deviceConstraint: resolved.doctor.gpu.uuid } : {}),
  });
  assertHarnessCompatibility(options.harnessRef, lock);
  await persistInferenceLock(options.root, lock);
  return {
    model,
    runtime: prepared.manifest,
    lock,
    doctor: resolved.doctor,
    runtime_cache_hit: prepared.cache_hit,
  };
}

function assertHarnessCompatibility(harnessRef: string | undefined, lock: InferenceLockV1): void {
  if (!harnessRef) return;
  const harness = harnessRef.split("@", 1)[0];
  if (harness !== "codex" && harness !== "model-call") {
    throw new HitchError(`local inference is not certified for ${harness}`, { code: "inference_harness_unsupported", exitCode: 2 });
  }
  if (harness === "codex" && !lock.protocol.tool_calls) {
    throw new HitchError("this model type has no certified SGLang tool-call parser for Codex", {
      code: "inference_protocol_unsupported", exitCode: 2,
    });
  }
  if (harness === "codex" && harnessRef !== "codex@version:0.145.0") {
    throw new HitchError("local inference is certified only for codex@version:0.145.0", {
      code: "inference_harness_unsupported", exitCode: 2,
    });
  }
}
