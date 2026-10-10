import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { EvalId, EvalRequest } from "../domain/index.js";
import { HitchError, atomicWriteJSON, readJSON } from "../foundation/index.js";

export async function prepareEvalDirectory(input: {
  evalsDirectory: string;
  evalId: EvalId;
  request: EvalRequest;
  precreated: boolean;
  replaceTerminal?: boolean;
}): Promise<string> {
  const directory = path.join(input.evalsDirectory, input.evalId);
  if (input.precreated) {
    const existingRequest = await readJSON<EvalRequest | null>(path.join(directory, "request.json"), null);
    if (!existingRequest) throw new HitchError(`precreated eval request is missing: ${input.evalId}`, { code: "eval_not_found", exitCode: 3 });
    if (JSON.stringify(existingRequest) !== JSON.stringify(input.request)) {
      throw new HitchError(`precreated eval request does not match: ${input.evalId}`, { code: "eval_request_conflict", exitCode: 2 });
    }
    if (!input.replaceTerminal && await readJSON(path.join(directory, "result.json"), null)) {
      throw new HitchError(`eval is already terminal: ${input.evalId}`, { code: "eval_id_conflict", exitCode: 2 });
    }
    if (input.replaceTerminal) {
      const previous = await readJSON<Record<string, unknown> | null>(path.join(directory, "result.json"), null);
      if (previous && (previous.status !== "failed" || !Array.isArray(previous.trials) || previous.trials.length !== 0)) {
        throw new HitchError("only failed pre-execution evals can restart preparation", { code: "eval_id_conflict", exitCode: 2 });
      }
      // preparation-rerun archived the prior result before this explicit restart.
      await rm(path.join(directory, "result.json"), { force: true });
    }
    return directory;
  }
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new HitchError(`eval ID already exists: ${input.evalId}`, { code: "eval_id_conflict", exitCode: 2 });
    }
    throw error;
  }
  await atomicWriteJSON(path.join(directory, "request.json"), input.request);
  return directory;
}
