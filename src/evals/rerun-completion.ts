import { rm } from "node:fs/promises";
import path from "node:path";
import { HitchError, atomicWriteJSON, readJSON, sha256JSON } from "../foundation/index.js";
import { evalRerunSemantics } from "./rerun-types.js";
import type { EvalRerunResult } from "./rerun-types.js";

type Completion = { schema_version: "2"; result: EvalRerunResult; result_digest: string; source_result_digest: string };
const file = (directory: string) => path.join(directory, "completion-pending.json");

export async function stageRemoteRerunCompletion(evalDirectory: string, directory: string, result: EvalRerunResult): Promise<void> {
  const source = await readJSON<Record<string, unknown>>(path.join(evalDirectory, "result.json"));
  if (source.status !== result.eval_status) throw invalid();
  await atomicWriteJSON(file(directory), { schema_version: "2", result, result_digest: sha256JSON(result), source_result_digest: sha256JSON(source) });
}

export async function readRemoteRerunCompletion(directory: string, evalId: string, rerunId: string): Promise<Completion | null> {
  const record = await readJSON<Completion | null>(file(directory), null);
  if (!record) return null;
  const result = record.result;
  const request = await readJSON<Record<string, unknown> | null>(path.join(directory, "request.json"), null);
  if (record.schema_version !== "2" || !result || record.result_digest !== sha256JSON(result)
    || typeof record.source_result_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.source_result_digest)
    || result.schema_version !== "1" || result.kind !== "eval-rerun" || result.eval_id !== evalId || result.rerun_id !== rerunId
    || !["candidate-restart", "verifier-only"].includes(result.rerun_type) || result.status !== "completed" || !["succeeded", "failed"].includes(result.eval_status)
    || sha256JSON(result.semantics) !== sha256JSON(evalRerunSemantics(result.rerun_type))
    || !Number.isFinite(Date.parse(result.completed_at)) || !request || request.schema_version !== "1"
    || request.eval_id !== evalId || request.rerun_id !== rerunId || request.rerun_type !== result.rerun_type
    || sha256JSON(request.semantics) !== sha256JSON(result.semantics)
    || sha256JSON(request.trials) !== sha256JSON(result.selected_trials) || sha256JSON(request.tasks) !== sha256JSON(result.selected_tasks)) throw invalid();
  return record;
}

export async function acknowledgeRemoteRerunCompletion(directory: string, result: EvalRerunResult): Promise<void> {
  const record = await readRemoteRerunCompletion(directory, result.eval_id, result.rerun_id);
  if (!record) return;
  if (record.result_digest !== sha256JSON(result)) throw invalid();
  await rm(file(directory));
}
function invalid(): HitchError { return new HitchError("remote rerun completion differs from its frozen result or selection", { code: "execution_state_ambiguous", exitCode: 12 }); }
