import path from "node:path";
import { atomicWriteJSON } from "../foundation/index.js";
import type { EvalEventSink } from "./events.js";
import type { EvalResult } from "./service-types.js";

export async function finalizeEvalResult(directory: string, sink: EvalEventSink, result: EvalResult): Promise<EvalResult> {
  await atomicWriteJSON(path.join(directory, "result.json"), result);
  sink.emit({ type: result.status === "succeeded" ? "eval.completed" : "eval.failed", status: result.status, exit_code: result.exit_code, error: result.error });
  await sink.close();
  return result;
}
