import type { BackendWorkItemV1, SchedulingHintV1 } from "../domain/index.js";

export function parseSchedulingHint(value: unknown, label: string): BackendWorkItemV1["scheduling"] {
  if (!isRecord(value)) throw new TypeError(`${label} scheduling hint is invalid`);
  assertOnlyKeys(value, ["policy", "estimated_duration_ms", "remaining_path_ms", "estimate_source", "estimate_sample_count"], `${label} scheduling hint`);
  const sources = new Set(["evolution-baseline", "history-p75", "task-budget", "default"]);
  if (value.policy !== "critical-path-lpt-v1"
    || !Number.isSafeInteger(value.estimated_duration_ms) || (value.estimated_duration_ms as number) < 1
    || !Number.isSafeInteger(value.remaining_path_ms) || (value.remaining_path_ms as number) < (value.estimated_duration_ms as number)
    || !sources.has(value.estimate_source as string)
    || !Number.isSafeInteger(value.estimate_sample_count) || (value.estimate_sample_count as number) < 0) {
    throw new TypeError(`${label} scheduling hint is invalid`);
  }
  if (value.estimate_source === "default" || value.estimate_source === "task-budget") {
    if (value.estimate_sample_count !== 0) throw new TypeError(`${label} scheduling hint sample count is invalid`);
  } else if ((value.estimate_sample_count as number) < 1) throw new TypeError(`${label} scheduling hint sample count is invalid`);
  return value as unknown as BackendWorkItemV1["scheduling"];
}

export function parseTaskScheduling(value: Readonly<Record<string, SchedulingHintV1>> | undefined, tasks: readonly string[]): Readonly<Record<string, SchedulingHintV1>> | undefined {
  if (value === undefined) return undefined;
  const keys = Object.keys(value).sort(compareBytes);
  if (keys.length !== tasks.length || keys.some((task, index) => task !== tasks[index])) {
    throw new TypeError("task scheduling hints must cover every planned task exactly once");
  }
  return Object.fromEntries(keys.map((task) => [task, parseSchedulingHint(value[task], `task ${task}`) as SchedulingHintV1]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function compareBytes(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}
function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(record).find(key => !allowed.includes(key));
  if (unexpected) throw new TypeError(`${label} has unknown field: ${unexpected}`);
}
