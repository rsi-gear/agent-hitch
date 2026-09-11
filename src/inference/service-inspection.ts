import type { InferenceServiceRecordV1 } from "../domain/index.js";
import { HitchError, hitchRootId, sha256JSON } from "../foundation/index.js";
import { loadModelNodeClient } from "./node-registry.js";
import { readServiceRecords } from "./supervisor.js";
import { parseInferenceServiceHandle } from "./manifest.js";
import { readInferenceGenerationRelease } from "./generation-recovery.js";

/** Read the node ledger, including terminal services. Never publish access credentials. */
export async function inspectModelNodeService(root: string, serviceId: string) {
  const record = (await readServiceRecords(root)).find(item => item.service_id === serviceId);
  if (!record?.model_node) throw new HitchError("model-node service not found", { code: "inference_route_unavailable", exitCode: 2 });
  const recovered = await readInferenceGenerationRelease(root, record);
  if (recovered) return { schema_version: "2", service_id: serviceId, inference_id: record.inference_id, model_node: record.model_node,
    state: "stopped", resources_released: true, gpu_seconds: recovered.receipt.gpuSeconds, generation_release: recovered };
  const client = await loadModelNodeClient(root, record.model_node);
  const value = await client.inspect({ serviceId, ownerId: hitchRootId(root), inferenceId: record.inference_id }) as {
    schemaVersion?: unknown; state?: unknown; inferenceId?: unknown; resourcesReleased?: unknown; gpuSeconds?: unknown; handle?: unknown;
  };
  if (!value || value.schemaVersion !== 2 || value.inferenceId !== record.inference_id
    || !["admitting", "starting", "ready", "stopping", "stopped", "failed"].includes(String(value.state))
    || typeof value.resourcesReleased !== "boolean" || typeof value.gpuSeconds !== "number" || !Number.isFinite(value.gpuSeconds) || value.gpuSeconds < 0
    || value.resourcesReleased && !["stopped", "failed"].includes(String(value.state))) throw new TypeError("invalid model-node usage/ownership observation");
  validateHandle(record, value.handle);
  return { schema_version: "2", service_id: serviceId, inference_id: record.inference_id, model_node: record.model_node,
    state: value.state, resources_released: value.resourcesReleased, gpu_seconds: value.gpuSeconds };
}

function validateHandle(record: InferenceServiceRecordV1, value: unknown): void {
  if (!value) {
    if (record.service_handle) throw new TypeError("model-node service lost its process identity");
    return;
  }
  const handle = parseInferenceServiceHandle(value);
  if (handle.kind !== "process" || handle.node_id !== record.model_node!.node_id || handle.generation !== record.model_node!.generation
    || handle.service_id !== record.service_id || record.service_handle && sha256JSON(handle) !== sha256JSON(record.service_handle)) {
    throw new TypeError("model-node process identity changed during usage inspection");
  }
}
