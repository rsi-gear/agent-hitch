import { persistTerminalEvalResult } from "../evals/index.js";
import path from "node:path";
import type { EvalControlV1, EvalId, EvalRequest } from "../domain/index.js";
import { SCHEMA_VERSION, readJSON } from "../foundation/index.js";
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
  const plan = await readJSON<Record<string, unknown> | null>(path.join(input.directory, "plan.json"), null)
    ?? await readJSON<Record<string, unknown> | null>(path.join(input.directory, "logical-plan.json"), null);
  const frozen = plan?.eval_id === input.evalId && plan.dataset === input.request.dataset
    && (plan.candidate as Record<string, unknown> | undefined)?.requested_harness_ref === input.request.harness_ref ? plan : null;
  const stage = ["planning", "preparing", "running", "finalizing"].includes(control.state) ? control.state : frozen ? "preparing" : "planning";
  await persistTerminalEvalResult(input.directory, {
    schema_version: SCHEMA_VERSION,
    eval_id: input.evalId,
    status: input.status,
    exit_code: input.status === "cancelled" ? 9 : 12,
    error: { code: input.code, message: input.message },
    failure_stage: stage,
    dataset: input.request.dataset,
    ...(frozen ? Object.fromEntries(["candidate", "prepared_artifact", "prepared_artifacts", "controller_runtime"]
      .filter(key => Object.hasOwn(frozen, key)).map(key => [key, frozen[key]])) : {}),
    benchmark_id: input.request.benchmark_id,
    benchmark_revision: input.request.benchmark_revision,
    trials: [],
    started_at: control.created_at,
    completed_at: input.completedAt,
  });
}
