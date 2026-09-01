import path from "node:path";
import type { EvalTrialRefV1 } from "../domain/index.js";
import { atomicWriteJSON } from "../foundation/index.js";
import { parseEvalTrialRef } from "./progress.js";

const EVAL_ID = /^eval_[a-f0-9]{32}$/;

export const EVAL_TRIAL_PUBLICATION_REF = path.join("eval", "publication.json");
export type EvalTrialPublicationMode = "settle" | "replace-invalid";

export interface EvalTrialPublicationV1 {
  schema_version: "1";
  eval_id: string;
  mode: EvalTrialPublicationMode;
  trial: EvalTrialRefV1;
  created_at: string;
}

export async function writeEvalTrialPublication(
  runDirectory: string,
  evalId: string,
  mode: EvalTrialPublicationMode,
  trial: EvalTrialRefV1,
): Promise<void> {
  await atomicWriteJSON(path.join(runDirectory, EVAL_TRIAL_PUBLICATION_REF), {
    schema_version: "1", eval_id: evalId, mode, trial, created_at: new Date().toISOString(),
  });
}

export function parseEvalTrialPublication(value: unknown, expectedRunId?: string): EvalTrialPublicationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("eval trial publication must be an object");
  const record = value as Record<string, unknown>;
  if (record.schema_version !== "1" || typeof record.eval_id !== "string" || !EVAL_ID.test(record.eval_id)
    || (record.mode !== "settle" && record.mode !== "replace-invalid")
    || typeof record.created_at !== "string" || !Number.isFinite(Date.parse(record.created_at))) {
    throw new TypeError("eval trial publication is invalid");
  }
  const trial = parseEvalTrialRef(record.trial, "eval trial publication trial");
  if (expectedRunId !== undefined && trial.run_id !== expectedRunId) throw new TypeError("eval trial publication run identity is invalid");
  return { schema_version: "1", eval_id: record.eval_id, mode: record.mode, trial, created_at: record.created_at };
}
