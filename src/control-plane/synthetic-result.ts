import path from "node:path";
import type { EvalControlV1, EvalId, EvalRequest } from "../domain/index.js";
import { SCHEMA_VERSION, atomicWriteJSON, readJSON } from "../foundation/index.js";
import { parseEvalControl } from "./eval-records.js";

export async function writeSyntheticEvalResult(input: {
  directory: string;
  evalId: EvalId;
  request: EvalRequest;
  status: "failed" | "cancelled";
  code: string;
  message: string;
  completedAt: string;
}): Promise<void> {
  if (await readJSON(path.join(input.directory, "result.json"), null)) return;
  const control = parseEvalControl(await readJSON<EvalControlV1>(path.join(input.directory, "control.json")));
  await atomicWriteJSON(path.join(input.directory, "result.json"), {
    schema_version: SCHEMA_VERSION,
    eval_id: input.evalId,
    status: input.status,
    exit_code: input.status === "cancelled" ? 9 : 12,
    error: { code: input.code, message: input.message },
    benchmark_id: input.request.benchmark_id,
    benchmark_revision: input.request.benchmark_revision,
    trials: [],
    started_at: control.created_at,
    completed_at: input.completedAt,
  });
}
