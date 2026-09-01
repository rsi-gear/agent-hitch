const SAFE_EVENT_FIELDS = new Set([
  "type", "eval_id", "rerun_id", "run_id", "worker_id", "work_id", "lease_id", "build_id",
  "rerun_type", "duration_ms", "code", "observation_status", "residual_resources",
  "requested_parallelism", "admitted_parallelism", "phase", "status",
]);

export function boundedMessage(value: unknown, limit = 4_096): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit - 15)}…[truncated]`;
}

export function boundedControlEvent(event: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (!SAFE_EVENT_FIELDS.has(key)) continue;
    if (typeof value === "string") result[key] = boundedMessage(value, 512);
    else if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") result[key] = value;
  }
  return result;
}
