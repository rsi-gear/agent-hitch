import path from "node:path";
import type { EvalControlV1, EvalId } from "../domain/index.js";
import { atomicWriteJSON, readJSON, withFileLock } from "../foundation/index.js";
import { EvalEventSink } from "../evals/index.js";
import { parseEvalControl } from "./eval-records.js";

export async function updateEvalControl(directory: string, update: (control: EvalControlV1) => EvalControlV1): Promise<EvalControlV1> {
  return withFileLock(path.join(directory, ".locks"), "control", async () => {
    const current = parseEvalControl(await readJSON(path.join(directory, "control.json")));
    const next = parseEvalControl({
      ...update(current), schema_version: "1", eval_id: current.eval_id, generation: current.generation + 1,
      created_at: current.created_at, updated_at: new Date().toISOString(),
    });
    await atomicWriteJSON(path.join(directory, "control.json"), next);
    return next;
  }, { timeoutCode: "eval_control_locked", timeoutExitCode: 12 });
}

export async function emitPersistedEvalEvent(
  directory: string,
  evalId: EvalId,
  onEvent: (event: Record<string, unknown>) => void,
  event: Record<string, unknown>,
): Promise<void> {
  const sink = new EvalEventSink(directory, evalId, onEvent);
  await sink.open();
  sink.emit(event);
  await sink.close();
}
