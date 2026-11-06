import type { ApprovedResourceConfigurationV1, ResourceProfileIdentityV1, TaskResourceRequirementV1 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";
import { componentId } from "./phase-resources.js";
import { parseResourceProfileIdentity, resourceProfileIdentityDigest } from "./resource-profile-identity.js";
import { profileDigest, profileInteger, profileRecord, profileText } from "./resource-profile-validation.js";

export function approveResourceConfiguration(input: {
  identity: unknown; role_limits: unknown; actor: string; reason: string; approved_at?: string;
}): ApprovedResourceConfigurationV1 {
  const identity = parseResourceProfileIdentity(input.identity);
  const approved_at = input.approved_at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(approved_at))) throw new TypeError("resource approval timestamp is invalid");
  const body = { schema_version: "1" as const, kind: "operator-approved-resource-configuration" as const,
    identity, identity_digest: resourceProfileIdentityDigest(identity), role_limits: roleLimits(input.role_limits),
    approval: { actor: profileText(input.actor), reason: profileText(input.reason, 4096), approved_at } };
  const roles = new Set(identity.role_images.map(role => role.component_id));
  if (body.role_limits.some(role => !roles.has(role.component_id))) throw new TypeError("approved resource role is absent from its identity");
  return { ...body, configuration_digest: sha256JSON(body) };
}

export function parseApprovedResourceConfiguration(value: unknown): ApprovedResourceConfigurationV1 {
  const record = profileRecord(value, ["schema_version", "kind", "identity", "identity_digest", "role_limits", "approval", "configuration_digest"]);
  if (record.schema_version !== "1" || record.kind !== "operator-approved-resource-configuration") throw new TypeError("explicit operator resource approval is required");
  const approval = profileRecord(record.approval, ["actor", "reason", "approved_at"]);
  const parsed = approveResourceConfiguration({ identity: record.identity, role_limits: record.role_limits,
    actor: profileText(approval.actor), reason: profileText(approval.reason, 4096), approved_at: profileText(approval.approved_at) });
  if (profileDigest(record.identity_digest) !== parsed.identity_digest || profileDigest(record.configuration_digest) !== parsed.configuration_digest) {
    throw new TypeError("resource approval identity or audit digest changed");
  }
  return parsed;
}

/** Explicit approval acknowledges the current role limits; it never overrides
 * a declaration, changes a frozen budget, or treats an observed peak as a cap. */
export function matchApprovedResourceConfiguration(approval: unknown, identity: ResourceProfileIdentityV1 | undefined,
  requirements: TaskResourceRequirementV1): { matched: boolean; reasons: string[] } {
  if (approval === undefined) return { matched: false, reasons: ["operator_approval_absent"] };
  const parsed = parseApprovedResourceConfiguration(approval);
  const reasons: string[] = [];
  if (!identity) reasons.push("profile_identity_unavailable");
  else if (parsed.identity_digest !== resourceProfileIdentityDigest(identity)) reasons.push("profile_identity_changed");
  for (const component of requirements.components) {
    const id = componentId(component), limit = parsed.role_limits.find(role => role.component_id === id);
    const declared = requirements.declared_limits?.find(entry => entry.component === id)?.fields ?? component.fields;
    const perReplica = { cpu_millis: component.resources.cpu_millis / component.replicas, memory_bytes: component.resources.memory_bytes / component.replicas };
    // Component fields are per-container declarations; resources are replica totals.
    for (const key of ["cpu_millis", "memory_bytes"] as const) {
      const current = component.fields[key].value;
      if (limit && (limit[key] !== current || current !== perReplica[key])) reasons.push(`approved_limit_changed:${id}:${key}`);
      if (declared[key].estimated && !limit) reasons.push(`missing_approved_limit:${id}:${key}`);
    }
  }
  return { matched: reasons.length === 0, reasons };
}

function roleLimits(value: unknown): ApprovedResourceConfigurationV1["role_limits"] {
  if (!Array.isArray(value) || !value.length || value.length > 256) throw new TypeError("approved role limits are invalid");
  const roles = value.map(value => { const role = profileRecord(value, ["component_id", "cpu_millis", "memory_bytes"]);
    return { component_id: profileText(role.component_id), cpu_millis: profileInteger(role.cpu_millis), memory_bytes: profileInteger(role.memory_bytes) }; })
    .sort((a, b) => a.component_id.localeCompare(b.component_id));
  if (new Set(roles.map(role => role.component_id)).size !== roles.length) throw new TypeError("approved resource roles must be unique");
  return roles;
}
