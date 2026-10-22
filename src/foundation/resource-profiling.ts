import type { ResourceProfilingPolicyV1 } from "../domain/index.js";

export function resourceProfilingPolicy(value?: unknown, env: NodeJS.ProcessEnv = process.env): ResourceProfilingPolicyV1 {
  const record = value === undefined ? undefined : value as Record<string, unknown>;
  if (record !== undefined && (!record || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).some(key => key !== "unknown_max_parallelism"))) throw new TypeError("resource_profiling policy is invalid");
  const raw = record && "unknown_max_parallelism" in record ? record.unknown_max_parallelism : env.HITCH_RESOURCE_PROFILING_UNKNOWN_MAX_PARALLELISM ?? 1;
  const limit = typeof raw === "string" && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : raw;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 10_000) throw new TypeError("resource_profiling.unknown_max_parallelism must be between 1 and 10000");
  return { unknown_max_parallelism: limit as number };
}
