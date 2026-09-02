import type { EnvironmentImageUseV1, Sha256, TrialRuntimeContractV1 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";

export interface EvalArtifactAssignmentInputV1 {
  taskIds: readonly string[];
  artifactId: string;
  runtimeContract: TrialRuntimeContractV1;
}

export interface ParsedArtifactAssignment {
  taskIds: string[];
  artifactId?: Sha256;
  runtimeContract?: TrialRuntimeContractV1;
}

export type WorkItemArtifactPin = { artifact_id?: Sha256; runtime_contract?: TrialRuntimeContractV1 };

export function parseArtifactAssignments(
  value: readonly EvalArtifactAssignmentInputV1[] | undefined,
  tasks: readonly string[] | null,
  fallbackArtifactId: string,
): ParsedArtifactAssignment[] {
  if (value === undefined) return [];
  if (value.length === 0) throw new TypeError("execution plan artifact assignments are empty");
  const allowed = new Set(tasks ?? []);
  const assignments = value.map((entry, index): ParsedArtifactAssignment => {
    if (!isSha256(entry.artifactId)) throw new TypeError(`execution plan artifact assignment ${index} id is invalid`);
    const taskIds = [...entry.taskIds].sort(compareBytes);
    if (new Set(taskIds).size !== taskIds.length || taskIds.some((task) => typeof task !== "string" || !allowed.has(task))) {
      if (!(tasks === null && taskIds.length === 0)) throw new TypeError(`execution plan artifact assignment ${index} tasks are invalid`);
    }
    return { taskIds, artifactId: entry.artifactId, runtimeContract: parseRuntimeContract(entry.runtimeContract, `execution plan artifact assignment ${index}`) };
  });
  if (tasks === null) {
    if (assignments.length !== 1 || assignments[0]?.taskIds.length !== 0) throw new TypeError("opaque execution plan requires one default artifact assignment");
  } else {
    const assigned = assignments.flatMap((entry) => entry.taskIds);
    if (assigned.length !== tasks.length || new Set(assigned).size !== tasks.length || assigned.some((task) => !allowed.has(task))) {
      throw new TypeError("execution plan artifact assignments must cover every task exactly once");
    }
  }
  if (!isSha256(fallbackArtifactId)) throw new TypeError("execution plan fallback artifact id is invalid");
  return assignments.sort((left, right) => compareBytes(left.taskIds.join("\0"), right.taskIds.join("\0")));
}

export function parseRuntimeContract(value: unknown, label: string): TrialRuntimeContractV1 {
  if (!isRecord(value)) throw new TypeError(`${label} runtime contract is invalid`);
  assertOnlyKeys(value, ["docker_platform", "artifact_platform", "node_version"], `${label} runtime contract`);
  if ((value.docker_platform !== "linux/amd64" && value.docker_platform !== "linux/arm64")
    || (value.artifact_platform !== "linux-x64" && value.artifact_platform !== "linux-arm64")
    || (value.docker_platform === "linux/amd64") !== (value.artifact_platform === "linux-x64")
    || typeof value.node_version !== "string" || !/^v\d+\.\d+\.\d+$/.test(value.node_version)) {
    throw new TypeError(`${label} runtime contract is invalid`);
  }
  return value as unknown as TrialRuntimeContractV1;
}

export function artifactPinFields(assignment?: ParsedArtifactAssignment): WorkItemArtifactPin {
  return assignment?.artifactId && assignment.runtimeContract
    ? { artifact_id: assignment.artifactId, runtime_contract: assignment.runtimeContract }
    : {};
}

export function workItemId(
  evalId: string,
  logicalAttempt: number,
  slots: string[],
  imageRefs: readonly EnvironmentImageUseV1[] = [],
  artifactPin: WorkItemArtifactPin = {},
): string {
  const imageIdentity = imageRefs.map(({ cache_hit: _cacheHit, ...entry }) => entry);
  const identity = { eval_id: evalId, backend: "harbor", logical_attempt: logicalAttempt, slots, ...(imageIdentity.length > 0 ? { image_refs: imageIdentity } : {}), ...artifactPin };
  return `work_${sha256JSON(identity).slice("sha256:".length, "sha256:".length + 32)}`;
}

export function opaqueWorkId(evalId: string, artifactPin: WorkItemArtifactPin = {}): string {
  return `work_${sha256JSON({ eval_id: evalId, backend: "harbor", membership: "opaque", ...artifactPin }).slice("sha256:".length, "sha256:".length + 32)}`;
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareBytes(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unexpected) throw new TypeError(`${label} has unknown field: ${unexpected}`);
}
