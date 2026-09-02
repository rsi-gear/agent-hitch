import path from "node:path";
import type { ExecutionEvidenceV1 } from "../domain/index.js";
import { atomicWriteJSON } from "../foundation/index.js";
import { parseExecutionEvidence } from "./execution-evidence.js";

export async function writeTrialExecutionEvidence(
  runDirectory: string,
  evidence: ExecutionEvidenceV1 | undefined,
  expected: { evalId: string; taskId: string },
): Promise<void> {
  if (evidence === undefined) return;
  const parsed = parseExecutionEvidence(evidence);
  if (parsed.eval_id !== expected.evalId || parsed.task_id !== expected.taskId) {
    throw new TypeError("execution evidence does not match the imported trial");
  }
  await atomicWriteJSON(path.join(runDirectory, "execution.json"), parsed);
}
