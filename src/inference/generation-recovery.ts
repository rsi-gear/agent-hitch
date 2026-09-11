import path from "node:path";
import type { InferenceServiceRecordV1, ModelNodeBindingV2 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, hitchRootId, readJSON, sha256JSON, statePaths, withFileLock } from "../foundation/index.js";
import { parseInferenceServiceHandle, parseInferenceServiceRecord, parseModelNodeBinding } from "./manifest.js";
import { loadModelNodeClient, observeModelNode } from "./node-registry.js";

type NodeIdentity = { nodeId: string; generation: string };
export interface InferenceGenerationReleaseV2 {
  schemaVersion: 2; kind: "inference-generation-release"; serviceId: string; ownerId: string; inferenceId: string;
  previousNode: NodeIdentity; node: NodeIdentity; sourceIdentityDigest: string;
  handle: Extract<NonNullable<InferenceServiceRecordV1["service_handle"]>, { kind: "process" }> | null;
  admissionOnly: boolean; state: "stopped"; resourcesReleased: true; gpuSeconds: number; devices: string[];
  previousBootDigest: string; currentBootDigest: string;
}
type StoredRelease = { schema_version: "2"; service_digest: string; model_node: ModelNodeBindingV2;
  receipt_digest: string; receipt: InferenceGenerationReleaseV2 };
const SHA = /^sha256:[a-f0-9]{64}$/;
const directory = (root: string, id: string) => path.join(statePaths(root).inferenceServices, id);
function serviceDigest(record: InferenceServiceRecordV1) {
  // A delayed startup projection may fill in an initially unknown handle.
  // The sealed node receipt owns that handle and validates every later projection.
  return sha256JSON({ service_id: record.service_id, inference_id: record.inference_id, model_node: record.model_node,
    epoch: record.epoch, isolation_key: record.isolation_key, owner_id: record.owner_id });
}

export function validateInferenceGenerationRelease(root: string, record: InferenceServiceRecordV1, current: ModelNodeBindingV2, value: unknown): InferenceGenerationReleaseV2 {
  const source = record.model_node;
  const r = value as InferenceGenerationReleaseV2 | null;
  const keys = ["schemaVersion", "kind", "serviceId", "ownerId", "inferenceId", "previousNode", "node", "sourceIdentityDigest", "handle",
    "admissionOnly", "state", "resourcesReleased", "gpuSeconds", "devices", "previousBootDigest", "currentBootDigest"];
  if (!source || source.node_id !== current.node_id || source.generation === current.generation || record.container_id
    || !r || Object.keys(r).sort().join(",") !== keys.sort().join(",") || r.schemaVersion !== 2 || r.kind !== "inference-generation-release"
    || r.serviceId !== record.service_id || r.ownerId !== hitchRootId(root) || r.inferenceId !== record.inference_id
    || sha256JSON(r.previousNode) !== sha256JSON({ nodeId: source.node_id, generation: source.generation })
    || sha256JSON(r.node) !== sha256JSON({ nodeId: current.node_id, generation: current.generation })
    || ![r.sourceIdentityDigest, r.previousBootDigest, r.currentBootDigest].every(v => typeof v === "string" && SHA.test(v))
    || r.previousBootDigest === r.currentBootDigest || r.state !== "stopped" || r.resourcesReleased !== true
    || typeof r.admissionOnly !== "boolean" || typeof r.gpuSeconds !== "number" || !Number.isFinite(r.gpuSeconds) || r.gpuSeconds < 0
    || !Array.isArray(r.devices) || r.devices.some(v => typeof v !== "string" || !/^GPU-[a-fA-F0-9-]+$/.test(v)) || new Set(r.devices).size !== r.devices.length
    || r.admissionOnly && (r.handle !== null || r.gpuSeconds !== 0 || r.devices.length !== 0)) throw ambiguous();
  if (r.handle !== null) {
    const handle = parseInferenceServiceHandle(r.handle);
    if (handle.kind !== "process" || handle.node_id !== source.node_id || handle.generation !== source.generation
      || handle.service_id !== record.service_id) throw ambiguous();
  }
  if (record.service_handle && sha256JSON(record.service_handle) !== sha256JSON(r.handle)) throw ambiguous();
  return structuredClone(r);
}

/** A confirmed release remains valid if the original node generation is no longer reachable. */
export async function readInferenceGenerationRelease(root: string, record: InferenceServiceRecordV1): Promise<StoredRelease | null> {
  const value = await readJSON<StoredRelease | null>(path.join(directory(root, record.service_id), "generation-release.json"), null);
  if (!value) return null;
  if (Object.keys(value).sort().join(",") !== "model_node,receipt,receipt_digest,schema_version,service_digest"
    || value.schema_version !== "2" || value.service_digest !== serviceDigest(record) || value.receipt_digest !== sha256JSON(value.receipt)) throw ambiguous();
  const node = parseModelNodeBinding(value.model_node);
  validateInferenceGenerationRelease(root, record, node, value.receipt);
  return value;
}

/** Explicitly drain an old generation. No service or experiment is rebound to the new generation. */
export async function reconcileModelNodeService(root: string, serviceId: string, binding: ModelNodeBindingV2) {
  if (!/^inference_[a-f0-9]{32}$/.test(serviceId)) throw ambiguous();
  const current = parseModelNodeBinding(binding);
  return withFileLock(statePaths(root).inferenceOperationLocks, sha256JSON({ kind: "generation-recovery", serviceId }), async () => {
    const stateFile = path.join(directory(root, serviceId), "state.json");
    const record = parseInferenceServiceRecord(await readJSON(stateFile));
    if (record.service_id !== serviceId || !record.model_node || record.model_node.node_id !== current.node_id
      || record.model_node.generation === current.generation) throw ambiguous();
    let stored = await readInferenceGenerationRelease(root, record);
    if (!stored) {
      const client = await loadModelNodeClient(root, current);
      await observeModelNode(client, current);
      const receipt = validateInferenceGenerationRelease(root, record, current, await client.call("inference.recover", {
        serviceId, ownerId: hitchRootId(root), inferenceId: record.inference_id,
        previousNode: { nodeId: record.model_node.node_id, generation: record.model_node.generation }, expectedHandle: record.service_handle ?? null,
      }));
      stored = { schema_version: "2", service_digest: serviceDigest(record), model_node: current, receipt_digest: sha256JSON(receipt), receipt };
      await atomicWriteJSON(path.join(directory(root, serviceId), "generation-release.json"), stored);
    }
    const latest = parseInferenceServiceRecord(await readJSON(stateFile));
    if (serviceDigest(latest) !== serviceDigest(record)) throw ambiguous();
    validateInferenceGenerationRelease(root, latest, stored.model_node, stored.receipt);
    await atomicWriteJSON(stateFile, { ...latest, state: "stopped", lease_owner_ids: [], updated_at: new Date().toISOString() });
    return { schema_version: "2", service_id: serviceId, inference_id: record.inference_id, model_node: record.model_node,
      state: "stopped", resources_released: true, gpu_seconds: stored.receipt.gpuSeconds, generation_release: stored };
  });
}
function ambiguous(): HitchError { return new HitchError("prior model-node generation has no matching confirmed service release", { code: "inference_recovery_ambiguous", exitCode: 12 }); }
