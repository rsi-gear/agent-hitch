import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const MAX_TIMING_BYTES = 16 * 1024;
const TRIAL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;

export async function harborPhaseTimingEvents(jobDirectory: string, rawResult: Record<string, unknown> | null): Promise<Record<string, unknown>[]> {
  const trials = Array.isArray(rawResult?.trial_results) ? rawResult.trial_results : [];
  const events: Record<string, unknown>[] = [];
  for (const value of trials) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const trial = value as Record<string, unknown>;
    if (typeof trial.trial_name !== "string" || !TRIAL_NAME.test(trial.trial_name) || trial.trial_name === "." || trial.trial_name === "..") continue;
    const identity = { trial_id: trial.trial_name, ...(typeof trial.task_name === "string" ? { task_id: trial.task_name } : {}) };
    for (const source of [
      { directory: "agent", phases: new Set(["setup", "agent"]) },
      { directory: "verifier", phases: new Set(["verifier"]) },
    ]) {
      const file = path.join(jobDirectory, trial.trial_name, source.directory, "hitch-phase-timings.json");
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_TIMING_BYTES) throw new TypeError("unsafe timing evidence");
        const record = parseTiming(JSON.parse(await readFile(file, "utf8")), source.phases);
        for (const [phase, timing] of Object.entries(record)) events.push({ type: `eval.${phase}.completed`, ...identity, duration_ms: timing.duration_ms });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        events.push({ type: "eval.phase-timing.invalid", ...identity, phase_source: source.directory, code: "phase_timing_invalid" });
      }
    }
  }
  return events;
}

function parseTiming(value: unknown, allowed: Set<string>): Record<string, { duration_ms: number }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("timing evidence must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "schema_version" && key !== "phases") || record.schema_version !== "1"
    || !record.phases || typeof record.phases !== "object" || Array.isArray(record.phases)) throw new TypeError("timing evidence envelope is invalid");
  const phases = record.phases as Record<string, unknown>;
  if (Object.keys(phases).some((phase) => !allowed.has(phase))) throw new TypeError("timing evidence phase is invalid");
  const result: Record<string, { duration_ms: number }> = {};
  for (const [phase, value] of Object.entries(phases)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("phase timing is invalid");
    const timing = value as Record<string, unknown>;
    if (Object.keys(timing).some((key) => key !== "duration_ms" && key !== "completed_at")
      || !Number.isSafeInteger(timing.duration_ms) || (timing.duration_ms as number) < 0 || (timing.duration_ms as number) > 7 * 24 * 60 * 60 * 1_000
      || typeof timing.completed_at !== "string" || !Number.isFinite(Date.parse(timing.completed_at))) throw new TypeError("phase timing fields are invalid");
    result[phase] = { duration_ms: timing.duration_ms as number };
  }
  return result;
}
