import type { LocalModelManifestV1, ModelNodeBindingV2 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import { addModelManifest, verifyLocalModel } from "./model-store.js";
import { parseLocalModelManifest } from "./manifest.js";
import { loadModelNodeClient } from "./node-registry.js";
import { modelNodeSnapshot, parseModelSnapshotRef, rememberModelNodeSnapshot } from "./model-location.js";

export async function addModelFromNode(root: string, name: string, snapshot: unknown, binding: ModelNodeBindingV2, force = false): Promise<LocalModelManifestV1> {
  const snapshotRef = parseModelSnapshotRef(snapshot);
  const client = await loadModelNodeClient(root, binding);
  const model = parseLocalModelManifest(await client.call("cas.hfManifest", { snapshotRef }));
  await rememberModelNodeSnapshot(root, model, binding, snapshotRef);
  return addModelManifest({ root, manifest: model, name, force });
}

export async function verifyModelOnNode(root: string, model: LocalModelManifestV1, binding: ModelNodeBindingV2): Promise<void> {
  const snapshotRef = await modelNodeSnapshot(root, model, binding);
  if (!snapshotRef) { await verifyLocalModel(root, model); return; }
  const client = await loadModelNodeClient(root, binding);
  const observed = parseLocalModelManifest(await client.call("cas.hfManifest", { snapshotRef }));
  if (observed.model_id !== model.model_id) throw new HitchError("model-node HF contents differ from the registered model", { code: "local_model_integrity_failed", exitCode: 5 });
}
