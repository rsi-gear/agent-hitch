import type {
  InferenceLockV1,
  InferenceRuntimeManifestV1,
  LocalInferenceSelectionV1,
  LocalModelManifestV1,
} from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import type { InferenceDoctorOptions, InferenceDoctorResultV1 } from "./doctor.js";
import { resolveLocalInferenceDevice } from "./doctor.js";
import { reservedInferenceDevices } from "./device-reservation.js";
import { buildInferenceLock, loadInferenceLock, persistInferenceLock } from "./lock.js";
import { resolveLocalModel, verifyLocalModel } from "./model-store.js";
import { loadInferenceRuntime, prepareInferenceRuntime } from "./runtime-store.js";
import type { PrepareInferenceRuntimeOptions } from "./runtime-store.js";
import { loadModelNodeClient, observeModelNode, runtimeFromModelNode } from "./node-registry.js";
import { parseModelNodeBinding } from "./manifest.js";
import { sha256JSON } from "../foundation/index.js";
import type { ModelNodeObservationV2 } from "./node-registry.js";

export interface LocalInferencePreflightOptions {
  root: string;
  selection: LocalInferenceSelectionV1;
  harnessRef?: string;
  doctor?: InferenceDoctorOptions;
  runtime?: Omit<PrepareInferenceRuntimeOptions, "root" | "backend" | "offline">;
  reusableLocks?: readonly InferenceLockV1[];
  onProgress?: (message: string) => void;
}

export interface LocalInferencePreflightResultV1 {
  model: LocalModelManifestV1;
  runtime: InferenceRuntimeManifestV1;
  lock: InferenceLockV1;
  doctor?: InferenceDoctorResultV1;
  runtime_cache_hit: boolean;
  node_observation?: ModelNodeObservationV2;
}

export async function prepareLocalInference(options: LocalInferencePreflightOptions): Promise<LocalInferencePreflightResultV1> {
  const model = await resolveLocalModel(options.root, options.selection.model);
  if (options.selection.model_node) {
    const { verifyModelOnNode } = await import("./remote-model-store.js");
    await verifyModelOnNode(options.root, model, options.selection.model_node);
    return prepareModelNodeInference(options, model);
  }
  await verifyLocalModel(options.root, model);
  const reusable = options.reusableLocks?.find((lock) => lock.model_id === model.model_id
    && !lock.model_node
    && lock.protocol.api === (options.harnessRef?.startsWith("training-tool@") ? "chat-completions" : "responses")
    && lock.profile === options.selection.profile
    && (options.selection.device === "auto" || options.selection.device === lock.execution.platform.backend));
  const inferenceId = options.selection.inference_id ?? reusable?.inference_id;
  if (inferenceId) {
    const lock = await loadInferenceLock(options.root, inferenceId);
    if (lock.model_node) throw new HitchError("a v2 inference lock requires its explicit model-node selection", { code: "inference_lock_mismatch", exitCode: 2 });
    if (lock.model_id !== model.model_id) {
      throw new HitchError("prepared inference identity refers to a different model", { code: "inference_lock_mismatch", exitCode: 2 });
    }
    const resolved = await resolveLocalInferenceDevice(lock.execution.platform.backend, {
      ...options.doctor,
      ...(lock.execution.platform.backend === "cuda" && lock.execution.platform.device_constraint
        ? { deviceConstraint: lock.execution.platform.device_constraint } : {}),
    });
    assertHarnessCompatibility(options.harnessRef, lock);
    return {
      doctor: resolved.doctor,
      model,
      runtime: await loadInferenceRuntime(options.root, lock.runtime_id),
      lock,
      runtime_cache_hit: true,
    };
  }
  const weights = model.files.filter((file) => file.path.endsWith(".safetensors")).reduce((sum, file) => sum + file.size, 0);
  const resolved = await resolveLocalInferenceDevice(options.selection.device, {
    ...options.doctor, requiredMemoryMiB: Math.ceil((weights * 1.25 + 1024 ** 3) / 1024 ** 2),
    excludedDeviceUuids: [...await reservedInferenceDevices(), ...(options.doctor?.excludedDeviceUuids ?? [])],
  });
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
    ...(options.harnessRef?.startsWith("training-tool@") ? { api: "chat-completions" as const } : {}),
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

async function prepareModelNodeInference(options: LocalInferencePreflightOptions, model: LocalModelManifestV1): Promise<LocalInferencePreflightResultV1> {
  const binding = parseModelNodeBinding(options.selection.model_node);
  if (!["auto", "cuda"].includes(options.selection.device)) throw new HitchError("model-node inference requires CUDA", { code: "inference_device_unsupported", exitCode: 3 });
  const observation = await observeModelNode(await loadModelNodeClient(options.root, binding), binding);
  const runtime = runtimeFromModelNode(observation);
  const persistedRuntime = await loadInferenceRuntime(options.root, runtime.runtime_id);
  if (sha256JSON(persistedRuntime) !== sha256JSON(runtime)) throw new HitchError("registered model-node runtime changed", { code: "inference_runtime_mismatch", exitCode: 12 });
  const reusable = options.reusableLocks?.find(lock => lock.model_id === model.model_id && lock.profile === options.selection.profile
    && sha256JSON(lock.model_node ?? null) === sha256JSON(binding)
    && lock.protocol.api === (options.harnessRef?.startsWith("training-tool@") ? "chat-completions" : "responses"));
  const inferenceId = options.selection.inference_id ?? reusable?.inference_id;
  const device = options.doctor?.deviceConstraint;
  let lock: InferenceLockV1;
  if (inferenceId) {
    lock = await loadInferenceLock(options.root, inferenceId);
    if (sha256JSON(lock.model_node ?? null) !== sha256JSON(binding) || lock.model_id !== model.model_id || lock.runtime_id !== runtime.runtime_id) {
      throw new HitchError("inference lock differs from the frozen model node, runtime or model", { code: "inference_lock_mismatch", exitCode: 2 });
    }
    if (device && (lock.execution.platform.backend !== "cuda" || lock.execution.platform.device_constraint !== device)) throw new HitchError("inference device changed", { code: "inference_lock_mismatch", exitCode: 2 });
  } else {
    if (!device) throw new HitchError("plan model-node inference with an explicit --gpu before submitting it", { code: "inference_device_unavailable", exitCode: 3 });
    lock = buildInferenceLock(model, runtime, { backend: "cuda", profile: options.selection.profile, modelNode: binding, deviceConstraint: device,
      ...(options.harnessRef?.startsWith("training-tool@") ? { api: "chat-completions" as const } : {}) });
  }
  if (lock.execution.platform.backend !== "cuda" || !observation.gpuUuids.includes(lock.execution.platform.device_constraint ?? "")) {
    throw new HitchError("locked physical GPU is absent on the model node", { code: "inference_device_unavailable", exitCode: 3 });
  }
  assertHarnessCompatibility(options.harnessRef, lock);
  await persistInferenceLock(options.root, lock);
  return { model, runtime, lock, runtime_cache_hit: true, node_observation: observation };
}

function assertHarnessCompatibility(harnessRef: string | undefined, lock: InferenceLockV1): void {
  if (!harnessRef) return;
  const harness = harnessRef.split("@", 1)[0];
  if (harness !== "codex" && harness !== "model-call" && harness !== "training-tool") {
    throw new HitchError(`local inference is not supported in the preview for ${harness}`, { code: "inference_harness_unsupported", exitCode: 2 });
  }
  if (harness === "training-tool" && lock.protocol.api !== "chat-completions") throw new HitchError("training-tool requires an explicit Chat Completions inference lock", { code: "inference_protocol_unsupported", exitCode: 2 });
  if ((harness === "codex" || harness === "training-tool") && !lock.protocol.tool_calls) {
    throw new HitchError("this model type has no configured SGLang tool-call parser for Codex", {
      code: "inference_protocol_unsupported", exitCode: 2,
    });
  }
  if (harness === "codex" && harnessRef !== "codex@version:0.145.0") {
    throw new HitchError("local inference supports only codex@version:0.145.0", {
      code: "inference_harness_unsupported", exitCode: 2,
    });
  }
}
