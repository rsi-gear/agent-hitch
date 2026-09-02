import path from "node:path";
import type { EnvironmentBuildRecordV1, EnvironmentImageManifestV1, Sha256 } from "../domain/index.js";
import { readJSON, statePaths } from "../foundation/index.js";
import { parseEnvironmentBuildRecord, parseEnvironmentImageManifest } from "./manifest.js";
import { environmentBuildRecordPath, environmentImageManifestPath } from "./service.js";

export interface EnvironmentBuildInspection {
  record: EnvironmentBuildRecordV1;
  manifest: EnvironmentImageManifestV1 | null;
}

export async function inspectEnvironmentBuild(root: string, buildId: string): Promise<EnvironmentBuildInspection | null> {
  if (!/^build_[a-f0-9]{32}$/.test(buildId)) throw new TypeError("environment build id is invalid");
  const index = await readJSON<Record<string, unknown> | null>(path.join(statePaths(root).buildIndexes, `${buildId}.json`), null);
  if (!index) return null;
  if (Object.keys(index).some((key) => !new Set(["schema_version", "build_id", "cache_key"]).has(key))
    || index.schema_version !== "1" || index.build_id !== buildId || typeof index.cache_key !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(index.cache_key)
    || buildId !== `build_${index.cache_key.slice("sha256:".length, "sha256:".length + 32)}`) throw new TypeError("environment build index is invalid");
  const recordValue = await readJSON<unknown | null>(environmentBuildRecordPath(root, index.cache_key as Sha256), null);
  if (!recordValue) throw new TypeError("environment build record is missing");
  const record = parseEnvironmentBuildRecord(recordValue);
  if (record.build_id !== buildId || record.cache_key !== index.cache_key) throw new TypeError("environment build record does not match its index");
  if (!record.image_id) return { record, manifest: null };
  const manifestValue = await readJSON<unknown | null>(environmentImageManifestPath(root, record.image_id), null);
  if (!manifestValue) throw new TypeError("environment image manifest is missing");
  const manifest = parseEnvironmentImageManifest(manifestValue);
  if (manifest.image_id !== record.image_id || manifest.build.cache_key !== record.cache_key) throw new TypeError("environment image manifest does not match its build");
  return { record, manifest };
}
