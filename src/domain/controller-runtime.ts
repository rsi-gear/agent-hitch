import type { Sha256 } from "./ids.js";

export interface ControllerRuntimeFile {
  path: string;
  size: number;
  executable: boolean;
  sha256: Sha256;
}

/**
 * Declared entrypoints of a controller runtime bundle. The entrypoint path is
 * relative to the upload root (`/opt/hitch`) and MUST be one of the declared
 * payload files; the Harbor bridge reads this manifest instead of hardcoding
 * the TypeScript build layout (spec §4.3, §8.5).
 */
export interface ControllerRuntimeEntrypoints {
  cli: {
    path: string;
    launcher: "node";
  };
}

export interface ControllerRuntimeManifest {
  schema_version: "2";
  runtime_id: Sha256;
  node_range: ">=22";
  entrypoints: ControllerRuntimeEntrypoints;
  files: ControllerRuntimeFile[];
  created_at: string;
}
