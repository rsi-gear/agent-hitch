import { readdir } from "node:fs/promises";
import path from "node:path";
import { invalidInput, readJSON } from "../../foundation/index.js";

/** Keep explicit candidate caps from replacing the compiled export allowance.
 * Legacy/unmanaged tasks retain their existing thirty-second outer grace. */
export async function harborAgentTimeoutOverride(dataset: Record<string, unknown>, timeoutMs: number): Promise<number | null> {
  if (timeoutMs <= 0) return null;
  const legacy = Math.ceil(timeoutMs / 1000) + 30;
  if (typeof dataset.path !== "string") return legacy;
  const tasks = Array.isArray(dataset.task_names) ? dataset.task_names as string[]
    : (await readdir(dataset.path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const limits: number[] = [];
  for (const name of tasks) {
    if (!name || name === "." || name === ".." || /[\\/]/.test(name)) throw invalidInput("invalid Harbor budget task name");
    const descriptor = await readJSON<Record<string, unknown> | null>(path.join(dataset.path, name, ".hitch-benchmark.json"), null);
    if (descriptor?.agent_finalization_timeout_ms === undefined) { limits.push(legacy); continue; }
    const budget = descriptor.agent_timeout_sec, grace = descriptor.agent_finalization_timeout_ms;
    if (descriptor.schema_version !== "1" || typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0
      || typeof grace !== "number" || !Number.isSafeInteger(grace) || grace <= 0) throw invalidInput("invalid compiled Harbor agent budget");
    limits.push(Math.ceil((Math.min(timeoutMs, budget * 1000) + grace) / 1000));
  }
  return limits.length ? Math.max(...limits) : legacy;
}
