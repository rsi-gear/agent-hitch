import type { Sha256 } from "./ids.js";

export interface ResourceProfileIdentityV1 {
  schema_version: "1";
  tasks: Array<{ task_id: string; task_digest: Sha256 }>;
  task_set_digest: Sha256;
  harness_artifact_digest: Sha256;
  controller_runtime_digest: Sha256;
  runtime_contract_digest: Sha256;
  role_images: Array<{ component_id: string; image_digest: Sha256; replicas: number }>;
  platform: string;
  backend: { id: string; version: string; provider: string; lifecycle_digest: Sha256 };
  input_scale: Record<string, unknown>;
  resource_parameters: Record<string, unknown>;
}

export interface ApprovedResourceConfigurationV1 {
  schema_version: "1";
  kind: "operator-approved-resource-configuration";
  identity: ResourceProfileIdentityV1;
  identity_digest: Sha256;
  role_limits: Array<{ component_id: string; cpu_millis: number; memory_bytes: number }>;
  approval: { actor: string; reason: string; approved_at: string };
  configuration_digest: Sha256;
}
