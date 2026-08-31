import type { Sha256 } from "./ids.js";

export interface EnvironmentImageManifestV1 {
  schema_version: "1";
  image_id: Sha256;
  source: {
    kind: "registry" | "build-context" | "compose-build";
    benchmark_id: string;
    benchmark_revision: string;
    task_id?: string;
    context_digest?: Sha256;
    dockerfile_digest?: Sha256;
  };
  platform: string;
  build: {
    builder: "buildkit";
    buildkit_version?: string;
    builder_id?: string;
    frontend?: string;
    target?: string;
    build_args_sha256?: Sha256;
    secret_names: string[];
    cache_key: Sha256;
  };
  output: {
    reference: string;
    manifest_digest: Sha256;
    config_digest?: Sha256;
  };
  base_images: Array<{ reference: string; digest: Sha256 }>;
  created_at: string;
}

export interface EnvironmentImageUseV1 {
  task_ids: string[];
  image_id: Sha256;
  reference: string;
  manifest_digest: Sha256;
  platform: string;
  resolution: "registry" | "prebuilt" | "backend-build";
  cache_hit: boolean;
}

export interface EnvironmentBuildRecordV1 {
  schema_version: "1";
  build_id: string;
  cache_key: Sha256;
  state: "running" | "succeeded" | "failed";
  owner_id: string;
  builder_id: string;
  started_at: string;
  completed_at?: string;
  image_id?: Sha256;
  error?: { code: string; message: string };
}
