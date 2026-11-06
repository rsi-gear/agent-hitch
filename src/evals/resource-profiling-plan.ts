import type { BackendWorkItemV1, EvalResourceProfilingV1, ResourceVectorV1, TaskResourceRequirementV1, WorkResourceProfilingV1 } from "../domain/index.js";
import { resourceProfilingPolicy, sha256JSON } from "../foundation/index.js";
import { reservationForTasks } from "./execution-plan-resources.js";

export function taskHasUnknownResourceSize(task: TaskResourceRequirementV1 | undefined): boolean {
  if (!task?.components.length) return true;
  return task.components.filter(component => component.role !== "provider-sidecar").some(component => {
    const declared = task.declared_limits?.find(entry => entry.component === `${component.role}:${component.name}`)?.fields ?? component.fields;
    return declared.cpu_millis.estimated || declared.memory_bytes.estimated;
  });
}

export function parseEvalResourceProfiling(value: unknown, tasks: readonly string[] | null): EvalResourceProfilingV1 | undefined {
  if (value === undefined) return undefined;
  const record = object(value);
  if (Object.keys(record).some(key => !["schema_version", "unknown_max_parallelism", "requested_parallelism", "scope", "approvals", "identity_manifest_digest"].includes(key))
    || record.schema_version !== "1" || !positive(record.requested_parallelism) || !positive(record.unknown_max_parallelism)
    || !["worker", "process"].includes(String(record.scope)) || !Array.isArray(record.approvals)) throw new TypeError("execution resource profiling policy is invalid");
  resourceProfilingPolicy({ unknown_max_parallelism: record.unknown_max_parallelism }, {});
  const seen = new Set<string>();
  for (const entry of record.approvals) {
    const approval = object(entry);
    if (Object.keys(approval).sort().join(",") !== "approval_digest,identity_digest,task_id" || typeof approval.task_id !== "string"
      || !tasks?.includes(approval.task_id) || seen.has(approval.task_id) || !digest(approval.approval_digest) || !digest(approval.identity_digest)) throw new TypeError("resource profiling approval identity is invalid");
    seen.add(approval.task_id);
  }
  if (record.identity_manifest_digest !== undefined && !digest(record.identity_manifest_digest)) throw new TypeError("resource profile identity manifest digest is invalid");
  return structuredClone(record) as unknown as EvalResourceProfilingV1;
}

export function parseWorkResourceProfiling(value: unknown): WorkResourceProfilingV1 | undefined {
  if (value === undefined) return undefined;
  const record = object(value);
  if (Object.keys(record).sort().join(",") !== "approval_digests,reason,schema_version,unknown,unknown_max_parallelism,unknown_slots"
    || record.schema_version !== "1" || typeof record.unknown !== "boolean" || !Number.isSafeInteger(record.unknown_slots)
    || (record.unknown_slots as number) < 0 || (record.unknown ? (record.unknown_slots as number) < 1 : record.unknown_slots !== 0)
    || !["missing-resource-size", "explicit-resource-limits", "approved-resource-config", "unknown-task-membership"].includes(String(record.reason))
    || !Array.isArray(record.approval_digests) || record.approval_digests.some(value => !digest(value))
    || new Set(record.approval_digests).size !== record.approval_digests.length) throw new TypeError("work resource profiling is invalid");
  const policy = resourceProfilingPolicy({ unknown_max_parallelism: record.unknown_max_parallelism }, {});
  if ((record.unknown_slots as number) > policy.unknown_max_parallelism) throw new TypeError("work exceeds its frozen unknown resource trial limit");
  return structuredClone(record) as unknown as WorkResourceProfilingV1;
}

export function workResourceProfiling(work: BackendWorkItemV1, requirements: readonly TaskResourceRequirementV1[] | undefined, policy: EvalResourceProfilingV1): WorkResourceProfilingV1 {
  const approvals = policy.approvals.filter(approval => work.task_ids.includes(approval.task_id));
  const unknownTasks = work.task_ids.filter(task => taskHasUnknownResourceSize(requirements?.find(requirement => requirement.task_id === task))
    && !approvals.some(approval => approval.task_id === task));
  const unknown = work.opaque_membership || unknownTasks.length > 0;
  return { schema_version: "1", unknown, unknown_max_parallelism: policy.unknown_max_parallelism,
    unknown_slots: unknown ? Math.min(work.requested_parallelism, work.opaque_membership ? work.requested_parallelism : unknownTasks.length) : 0,
    reason: work.opaque_membership ? "unknown-task-membership" : unknown ? "missing-resource-size" : approvals.length ? "approved-resource-config" : "explicit-resource-limits",
    approval_digests: [...new Set(approvals.map(approval => approval.approval_digest))].sort() };
}

export function applyResourceProfiling(work: BackendWorkItemV1, requirements: readonly TaskResourceRequirementV1[] | undefined, defaults: ResourceVectorV1, policy: EvalResourceProfilingV1 | undefined): BackendWorkItemV1 {
  if (!policy) return work;
  const unknown = workResourceProfiling(work, requirements, policy).unknown;
  const parallelism = unknown ? Math.min(work.requested_parallelism, policy.unknown_max_parallelism) : work.requested_parallelism;
  const next = { ...work, requested_parallelism: parallelism,
    reservation: work.opaque_membership ? Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, value * parallelism])) as unknown as ResourceVectorV1
      : reservationForTasks(work.task_ids, parallelism, defaults, requirements) };
  const profiling = workResourceProfiling(next, requirements, policy);
  return { ...next, resource_profiling: profiling, work_id: profiledWorkId(work.work_id, profiling) };
}

export function validatePlanResourceProfiling(work: BackendWorkItemV1, requirements: readonly TaskResourceRequirementV1[] | undefined, policy: EvalResourceProfilingV1 | undefined): void {
  const actual = parseWorkResourceProfiling(work.resource_profiling);
  const expected = policy ? workResourceProfiling(work, requirements, policy) : undefined;
  if (sha256JSON(actual ?? null) !== sha256JSON(expected ?? null)) throw new TypeError("work resource profiling differs from frozen task evidence");
}

export function profiledWorkId(base: string, profiling?: WorkResourceProfilingV1): string {
  return profiling ? `work_${sha256JSON({ base_work_id: base, resource_profiling: profiling }).slice(7, 39)}` : base;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("resource profiling must be an object");
  return value as Record<string, unknown>;
}
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) > 0; }
function digest(value: unknown): boolean { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
