import path from "node:path";
import type { EvalProgressV1 } from "../domain/index.js";
import { atomicWriteJSON, readJSON } from "../foundation/index.js";
import { parseEvalProgress, terminalEvalProgress, withEvalProgressLock } from "./progress.js";
import { summarizeTrialRefs } from "./result-helpers.js";

/** Serialize terminal publication with every progress writer, retaining durable trials. */
export async function persistTerminalEvalResult<T extends Record<string, unknown>>(directory: string, source: T): Promise<T> {
  return withEvalProgressLock(directory, async () => {
    const raw = await readJSON<unknown | null>(path.join(directory, "progress.json"), null);
    let progress: EvalProgressV1 | null = raw === null ? null : parseEvalProgress(raw);
    let result = source;
    if (progress) {
      progress = terminalEvalProgress(progress, source);
      result = { ...source, generation: progress.generation, trials: progress.trials, summary: summarizeTrialRefs(progress.trials) };
    }
    // If interrupted between the two writes, readEvalProgress reconciles from result.
    await atomicWriteJSON(path.join(directory, "result.json"), result);
    if (progress) await atomicWriteJSON(path.join(directory, "progress.json"), progress);
    return result;
  });
}
