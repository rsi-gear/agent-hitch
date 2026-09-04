import type { ManagedInferenceLeaseV1, ModelIdentityV1, RunId, TrajectoryFidelity } from "../domain/index.js";
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

export function applyEffectiveModelIdentity(input: {
  manifest: Record<string, unknown>;
  requested: ModelIdentityV1;
  result: Record<string, unknown>;
  inferenceLease?: ManagedInferenceLeaseV1;
  observed?: string;
}): Record<string, unknown> {
  const current = (input.manifest.model || input.requested) as ModelIdentityV1;
  if (input.inferenceLease) {
    const lease = input.inferenceLease;
    input.result.effective_model = lease.lock.model_id;
    return { ...input.manifest, model: {
      ...current, provider: "local", effective_id: lease.lock.model_id, identity_resolved: true,
      inference_id: lease.lock.inference_id,
    } };
  }
  if (!input.observed) return input.manifest;
  input.result.effective_model = input.observed;
  return { ...input.manifest, model: {
    ...current,
    effective_id: input.observed,
    identity_resolved: current.identity_resolved === true || /^sha256:[a-f0-9]{64}$/.test(input.observed),
  } };
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
