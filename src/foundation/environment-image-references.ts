import path from "node:path";
import type { EnvironmentImageUseV1, Sha256 } from "../domain/index.js";
import { atomicWriteJSON, readJSON } from "./fs.js";
import { statePaths } from "./config.js";
import { withFileLock } from "./locks.js";

const REFERENCE_FILE = "environment-image-refs.json";

export interface EvalEnvironmentImageReferencesV1 {
  schema_version: "1";
  eval_id: string;
  state: "planning" | "planned";
  image_ids: Sha256[];
  updated_at: string;
}

export function withEnvironmentImageReferenceLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  return withFileLock(statePaths(root).environmentImageReferenceLocks, "global", operation, {
    timeoutCode: "environment_image_references_locked",
    timeoutExitCode: 12,
  });
}

export async function beginEvalEnvironmentImagePlanning(
  evalDirectory: string,
  evalId: string,
): Promise<EvalEnvironmentImageReferencesV1> {
  return writeReferences(evalDirectory, evalId, "planning", []);
}

export async function writeEvalEnvironmentImageReferences(
  evalDirectory: string,
  evalId: string,
  images: readonly EnvironmentImageUseV1[],
): Promise<EvalEnvironmentImageReferencesV1> {
  if (!/^eval_[a-f0-9]{32}$/.test(evalId)) throw new TypeError("environment image reference eval identity is invalid");
  const imageIds = [...new Set(images.map((image) => image.image_id))].sort(compare);
  if (imageIds.some((imageId) => !/^sha256:[a-f0-9]{64}$/.test(imageId))) throw new TypeError("environment image references are invalid");
  return writeReferences(evalDirectory, evalId, "planned", imageIds);
}

async function writeReferences(
  evalDirectory: string,
  evalId: string,
  state: EvalEnvironmentImageReferencesV1["state"],
  imageIds: Sha256[],
): Promise<EvalEnvironmentImageReferencesV1> {
  if (!/^eval_[a-f0-9]{32}$/.test(evalId)) throw new TypeError("environment image reference eval identity is invalid");
  const record: EvalEnvironmentImageReferencesV1 = {
    schema_version: "1",
    eval_id: evalId,
    state,
    image_ids: imageIds,
    updated_at: new Date().toISOString(),
  };
  await atomicWriteJSON(path.join(evalDirectory, REFERENCE_FILE), record);
  return record;
}

export async function readEvalEnvironmentImageReferences(
  evalDirectory: string,
  expectedEvalId: string,
): Promise<EvalEnvironmentImageReferencesV1 | null> {
  const value = await readJSON<unknown | null>(path.join(evalDirectory, REFERENCE_FILE), null);
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("environment image references must be an object");
  const record = value as Record<string, unknown>;
  const imageIds = record.image_ids;
  if (Object.keys(record).some((key) => !["schema_version", "eval_id", "state", "image_ids", "updated_at"].includes(key))
    || record.schema_version !== "1" || record.eval_id !== expectedEvalId
    || record.state !== "planning" && record.state !== "planned"
    || !Array.isArray(imageIds) || imageIds.some((entry) => typeof entry !== "string" || !/^sha256:[a-f0-9]{64}$/.test(entry))
    || new Set(imageIds).size !== imageIds.length
    || !imageIds.every((entry, index) => index === 0 || compare(imageIds[index - 1] as string, entry as string) < 0)
    || typeof record.updated_at !== "string" || !Number.isFinite(Date.parse(record.updated_at))
    || record.state === "planning" && imageIds.length !== 0) {
    throw new TypeError("environment image references are invalid");
  }
  return record as unknown as EvalEnvironmentImageReferencesV1;
}

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
