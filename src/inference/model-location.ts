import path from "node:path";
import type { LocalModelManifestV1, ModelNodeBindingV2, Sha256 } from "../domain/index.js";
import { atomicWriteJSON, readJSON, sha256JSON, statePaths } from "../foundation/index.js";
import { parseModelNodeBinding } from "./manifest.js";

export interface ModelSnapshotRef { uri: string; digest: Sha256; mediaType: "application/json" }
export function parseModelSnapshotRef(value: unknown): ModelSnapshotRef {
  const ref = value as ModelSnapshotRef | null;
  if (!ref || Object.keys(ref).sort().join(",") !== "digest,mediaType,uri" || !/^sha256:[a-f0-9]{64}$/.test(ref.digest)
    || ref.uri !== `cas:${ref.digest}` || ref.mediaType !== "application/json") throw new TypeError("model node requires a portable HF snapshot reference");
  return ref;
}
function locationPath(root: string, model: LocalModelManifestV1, binding: ModelNodeBindingV2): string {
  return path.join(statePaths(root).models, model.model_id.slice(7), "node-locations", sha256JSON(binding).slice(7) + ".json");
}
export async function rememberModelNodeSnapshot(root: string, model: LocalModelManifestV1, binding: ModelNodeBindingV2, snapshotRef: ModelSnapshotRef): Promise<void> {
  parseModelNodeBinding(binding); parseModelSnapshotRef(snapshotRef);
  await atomicWriteJSON(locationPath(root, model, binding), { schema_version: "1", model_id: model.model_id, binding, snapshotRef });
}
export async function modelNodeSnapshot(root: string, model: LocalModelManifestV1, binding: ModelNodeBindingV2): Promise<ModelSnapshotRef | null> {
  parseModelNodeBinding(binding);
  let value: { schema_version: string; model_id: Sha256; binding: ModelNodeBindingV2; snapshotRef: unknown };
  try { value = await readJSON(locationPath(root, model, binding)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (value.schema_version !== "1" || value.model_id !== model.model_id || sha256JSON(value.binding) !== sha256JSON(binding)) throw new TypeError("stored model-node location changed identity");
  return parseModelSnapshotRef(value.snapshotRef);
}
