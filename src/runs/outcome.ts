import type { RunId, TrajectoryFidelity } from "../domain/index.js";
import { SCHEMA_VERSION } from "../foundation/index.js";
import { parseHarnessReference } from "../revisions/index.js";

export function failureResult(
  runId: RunId,
  startedAt: Date,
  code: string,
  message: string,
  exitCode: number,
  processExit: { code?: number | null; signal?: NodeJS.Signals | null } = {},
): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    status: code === "cancelled" ? "cancelled" : code === "timed_out" ? "timed_out" : "failed",
    exit_code: exitCode,
    process_exit_code: processExit.code ?? null,
    signal: processExit.signal ?? null,
    error: { code, message },
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
  };
}

export function adapterFidelity(harnessRef: string): TrajectoryFidelity {
  const reference = parseHarnessReference(harnessRef);
  // DeepSeek normally replaces this fallback with the native session imported
  // after exit. Older builds that do not persist sessions still get an honest
  // minimal stdout projection instead of fabricated structured events.
  return reference.harness_id === "deepseek" ? "minimal" : "normalized";
}

export function providerModelId(event: Record<string, unknown>): string | undefined {
  const direct = [event.model, event.model_id, event.modelId, event.model_snapshot, event.snapshot];
  for (const value of direct) if (typeof value === "string" && value.trim()) return value.trim();
  for (const container of [event.message, event.response, event.session]) {
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    const record = container as Record<string, unknown>;
    for (const value of [record.model, record.model_id, record.modelId, record.model_snapshot]) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

export function mergeRedactions(
  ...groups: Array<Array<{ rule_id: string; count: number }> | undefined>
): Array<{ rule_id: string; count: number }> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const item of group || []) counts.set(item.rule_id, (counts.get(item.rule_id) || 0) + item.count);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rule_id, count]) => ({ rule_id, count }));
}
