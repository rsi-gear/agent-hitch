import type { BackendWorkItemV1, ResourceVectorV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import { validateResourceVector } from "./resources.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/;

export function parseRemoteWorkItem(value: unknown): BackendWorkItemV1 {
  const record = exact(value, [
    "schema_version", "work_id", "eval_id", "backend", "logical_attempt", "task_ids", "slots", "opaque_membership",
    "requested_parallelism", "reservation", "provider", "image_refs", "artifact_id", "runtime_contract", "scheduling",
  ], "remote work item");
  if (record.schema_version !== "1" || typeof record.work_id !== "string" || !/^work_[a-f0-9]{32}$/.test(record.work_id)
    || typeof record.eval_id !== "string" || !/^eval_[a-f0-9]{32}$/.test(record.eval_id) || record.backend !== "harbor"
    || record.logical_attempt !== null && (!Number.isSafeInteger(record.logical_attempt) || (record.logical_attempt as number) < 1)
    || !stringArray(record.task_ids) || !stringArray(record.slots) || typeof record.opaque_membership !== "boolean"
    || !Number.isSafeInteger(record.requested_parallelism) || (record.requested_parallelism as number) < 1
    || typeof record.provider !== "string" || !record.provider || record.image_refs !== undefined && !Array.isArray(record.image_refs)
    || record.artifact_id !== undefined && (typeof record.artifact_id !== "string" || !SHA256.test(record.artifact_id))
    || (record.artifact_id === undefined) !== (record.runtime_contract === undefined)) protocolError("remote work item is invalid");
  if (record.runtime_contract !== undefined) parseRuntimeContract(record.runtime_contract);
  const scheduling = record.scheduling === undefined ? undefined : parseSchedulingHint(record.scheduling);
  return {
    ...record,
    reservation: validateResourceVector(record.reservation as ResourceVectorV1, "remote work reservation"),
    ...(scheduling ? { scheduling } : {}),
  } as unknown as BackendWorkItemV1;
}

function parseRuntimeContract(value: unknown): void {
  const runtime = exact(value, ["docker_platform", "artifact_platform", "node_version"], "remote work runtime contract");
  if ((runtime.docker_platform !== "linux/amd64" && runtime.docker_platform !== "linux/arm64")
    || (runtime.artifact_platform !== "linux-x64" && runtime.artifact_platform !== "linux-arm64")
    || (runtime.docker_platform === "linux/amd64") !== (runtime.artifact_platform === "linux-x64")
    || typeof runtime.node_version !== "string" || !/^v\d+\.\d+\.\d+$/.test(runtime.node_version)) protocolError("remote work runtime contract is invalid");
}

function parseSchedulingHint(value: unknown): BackendWorkItemV1["scheduling"] {
  const hint = exact(value, ["policy", "estimated_duration_ms", "remaining_path_ms", "estimate_source", "estimate_sample_count"], "remote work scheduling hint");
  const sources = new Set(["evolution-baseline", "history-p75", "task-budget", "default"]);
  if (hint.policy !== "critical-path-lpt-v1"
    || !Number.isSafeInteger(hint.estimated_duration_ms) || (hint.estimated_duration_ms as number) < 1
    || !Number.isSafeInteger(hint.remaining_path_ms) || (hint.remaining_path_ms as number) < (hint.estimated_duration_ms as number)
    || !sources.has(hint.estimate_source as string)
    || !Number.isSafeInteger(hint.estimate_sample_count) || (hint.estimate_sample_count as number) < 0
    || ((hint.estimate_source === "default" || hint.estimate_source === "task-budget")
      ? hint.estimate_sample_count !== 0 : (hint.estimate_sample_count as number) < 1)) protocolError("remote work scheduling hint is invalid");
  return hint as unknown as BackendWorkItemV1["scheduling"];
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0 && !/[\0\r\n]/.test(entry)) && new Set(value).size === value.length;
}

function exact(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) protocolError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) protocolError(`${label} has unknown fields`);
  return record;
}

function protocolError(message: string): never {
  throw new HitchError(message, { code: "worker_protocol_invalid", exitCode: 2 });
}
