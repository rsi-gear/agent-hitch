import type { RunContextV1 } from "../domain/index.js";
import { validateRunContext } from "../domain/index.js";
import type { ValidatedRunRequest } from "./request.js";

/** Candidate terminal state precedes a managed benchmark's host assessment. */
export function completedRunManifest(
  manifest: Record<string, unknown>, result: Record<string, unknown>,
  request: Pick<ValidatedRunRequest, "context" | "defer_benchmark_observation">,
): Record<string, unknown> {
  const status = result.status;
  const observation = request.context.kind === "benchmark_task" && !request.defer_benchmark_observation
    ? {
        status: "invalid",
        invalid_reason: status === "succeeded" ? "verifier_result_missing"
          : status === "cancelled" ? "cancelled" : "infrastructure_failure",
      }
    : undefined;
  return {
    ...manifest, status, result_ref: "result.json",
    ...(observation ? { observation } : {}),
    completed_at: result.completed_at,
    sealed: !request.defer_benchmark_observation,
  };
}

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
