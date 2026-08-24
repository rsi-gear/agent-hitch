import type { RunContextV1 } from "../domain/index.js";
import { validateRunContext } from "../domain/index.js";

export function sealTerminalManifest(
  manifest: Record<string, unknown>,
  status: "succeeded" | "failed" | "cancelled" | "timed_out",
  completedAt: string,
): Record<string, unknown> {
  const context = (() => {
    try { return validateRunContext(manifest.context ?? { kind: "ad_hoc" }); } catch { return { kind: "ad_hoc" } as RunContextV1; }
  })();
  return {
    ...manifest,
    status,
    result_ref: "result.json",
    ...(context.kind === "benchmark_task" && manifest.observation === undefined
      ? { observation: { status: "invalid", invalid_reason: status === "cancelled" ? "cancelled" : "infrastructure_failure" } }
      : {}),
    completed_at: completedAt,
    sealed: true,
  };
}
