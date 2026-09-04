import type { BenchmarkManifestV1, BenchmarkTaskV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";

export function mapBenchmarkMetrics(raw: unknown, manifest: BenchmarkManifestV1, task: BenchmarkTaskV1): { primary: number; metrics: Record<string, number> } {
  const metrics: Record<string, number> = {};
  for (const [name, spec] of Object.entries(manifest.metrics)) {
    const field = task.grading.metric_map[name]!;
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>)[field] : undefined;
    if (value === undefined) throw new HitchError(`missing required grader metric: ${field}`, { code: "metric_missing", exitCode: 12 });
    if (typeof value !== "number" || !Number.isFinite(value) || value < spec.range[0] || value > spec.range[1] || (spec.type === "binary" && value !== 0 && value !== 1)) {
      throw new HitchError(`invalid grader metric: ${field}`, { code: "metric_invalid", exitCode: 12 });
    }
    metrics[name] = value;
  }
  return { primary: metrics[manifest.primary_metric]!, metrics };
}
