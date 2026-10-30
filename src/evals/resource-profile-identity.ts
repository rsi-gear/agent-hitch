import type { ResourceProfileIdentityV1 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";
import { profileDigest, profileInteger, profileJSON, profileRecord, profileText } from "./resource-profile-validation.js";

export function parseResourceProfileIdentity(value: unknown): ResourceProfileIdentityV1 {
  const record = profileRecord(value, ["schema_version", "tasks", "task_set_digest", "harness_artifact_digest", "controller_runtime_digest",
    "runtime_contract_digest", "role_images", "platform", "backend", "input_scale", "resource_parameters"]);
  if (record.schema_version !== "1" || !Array.isArray(record.tasks) || !record.tasks.length || record.tasks.length > 100000
    || !Array.isArray(record.role_images) || !record.role_images.length || record.role_images.length > 256) throw new TypeError("resource profile membership is invalid");
  const tasks = record.tasks.map(value => { const item = profileRecord(value, ["task_id", "task_digest"]);
    return { task_id: profileText(item.task_id), task_digest: profileDigest(item.task_digest) }; }).sort((a, b) => a.task_id.localeCompare(b.task_id));
  const roles = record.role_images.map(value => { const item = profileRecord(value, ["component_id", "image_digest", "replicas"]);
    return { component_id: profileText(item.component_id), image_digest: profileDigest(item.image_digest), replicas: profileInteger(item.replicas) }; })
    .sort((a, b) => a.component_id.localeCompare(b.component_id));
  if (new Set(tasks.map(task => task.task_id)).size !== tasks.length || new Set(roles.map(role => role.component_id)).size !== roles.length
    || profileDigest(record.task_set_digest) !== sha256JSON(tasks)) throw new TypeError("resource profile task or role identity is inconsistent");
  const backend = profileRecord(record.backend, ["id", "version", "provider", "lifecycle_digest"]);
  return { schema_version: "1", tasks, task_set_digest: sha256JSON(tasks), harness_artifact_digest: profileDigest(record.harness_artifact_digest),
    controller_runtime_digest: profileDigest(record.controller_runtime_digest), runtime_contract_digest: profileDigest(record.runtime_contract_digest),
    role_images: roles, platform: profileText(record.platform), backend: { id: profileText(backend.id), version: profileText(backend.version),
      provider: profileText(backend.provider), lifecycle_digest: profileDigest(backend.lifecycle_digest) },
    input_scale: profileJSON(record.input_scale), resource_parameters: profileJSON(record.resource_parameters) };
}

export function resourceProfileIdentityDigest(value: unknown) { return sha256JSON(parseResourceProfileIdentity(value)); }
