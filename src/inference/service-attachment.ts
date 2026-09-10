import path from "node:path";
import type { InferenceRuntimeObservationV2, InferenceServiceRecordV1 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, readJSON, sha256JSON, statePaths } from "../foundation/index.js";
import { validateInferenceLockShape } from "./lock.js";
import { parseInferenceRuntimeManifest, parseInferenceServiceRecord, parseLocalModelManifest } from "./manifest.js";
import type { SGLangAttachInput, SGLangLaunchInput } from "./sglang.js";

type Inputs = Pick<SGLangLaunchInput, "lock" | "model" | "runtime">;
interface Attachment {
  schema_version: "2";
  service_digest: string;
  inputs: Inputs;
  observation: InferenceRuntimeObservationV2;
}
function serviceIdentity(record: InferenceServiceRecordV1) {
  return { service_id: record.service_id, inference_id: record.inference_id, isolation_key: record.isolation_key,
    epoch: record.epoch, owner_id: record.owner_id, model_node: record.model_node, service_handle: record.service_handle };
}
function validate(record: InferenceServiceRecordV1, attachment: Attachment): void {
  parseInferenceServiceRecord(record);
  if (Object.keys(attachment).sort().join(",") !== "inputs,observation,schema_version,service_digest" || attachment.schema_version !== "2"
    || attachment.service_digest !== sha256JSON(serviceIdentity(record)) || !record.model_node || record.service_handle?.kind !== "process"
    || !attachment.inputs || Object.keys(attachment.inputs).sort().join(",") !== "lock,model,runtime"
    || !attachment.observation || attachment.observation.schema_version !== "2") throw ambiguous();
  const { lock, model, runtime } = attachment.inputs;
  validateInferenceLockShape(lock); parseLocalModelManifest(model); parseInferenceRuntimeManifest(runtime);
  if (record.inference_id !== lock.inference_id || lock.model_id !== model.model_id || lock.runtime_id !== runtime.runtime_id
    || sha256JSON(record.model_node) !== sha256JSON(lock.model_node)) throw ambiguous();
}
const file = (root: string, id: string) => path.join(statePaths(root).inferenceServices, id, "attachment.json");

/** Seal after startup's protocol probe and cache drain, before publishing ready. */
export async function writeServiceAttachment(root: string, record: InferenceServiceRecordV1, inputs: Inputs, observation: InferenceRuntimeObservationV2): Promise<void> {
  const attachment: Attachment = { schema_version: "2", service_digest: sha256JSON(serviceIdentity(record)), inputs: structuredClone(inputs), observation: structuredClone(observation) };
  validate(record, attachment);
  const value = { digest: sha256JSON(attachment), attachment };
  const previous = await readJSON<unknown | null>(file(root, record.service_id), null);
  if (previous && sha256JSON(previous) !== sha256JSON(value)) throw ambiguous();
  if (!previous) await atomicWriteJSON(file(root, record.service_id), value);
}

export async function readServiceAttachment(root: string, record: InferenceServiceRecordV1): Promise<SGLangAttachInput> {
  parseInferenceServiceRecord(record);
  const value = await readJSON<{ digest: string; attachment: Attachment } | null>(file(root, record.service_id), null);
  if (!value || Object.keys(value).sort().join(",") !== "attachment,digest" || !value.attachment
    || value.digest !== sha256JSON(value.attachment)) throw ambiguous();
  validate(record, value.attachment);
  return { root, record, ...value.attachment.inputs, observation: value.attachment.observation };
}
function ambiguous() { return new HitchError("original model-node startup evidence is unavailable or changed", { code: "inference_recovery_ambiguous", exitCode: 12 }); }
