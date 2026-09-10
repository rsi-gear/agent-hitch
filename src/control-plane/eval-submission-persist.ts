import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { EvalControlV1, EvalExecutionPolicyV1, EvalId, EvalRequest, EvalSubmissionV1, ModelCapturePlanV1 } from "../domain/index.js";
import { atomicWriteJSON } from "../foundation/index.js";
import { newEvalId } from "../evals/index.js";

export async function persistEvalSubmission(input: {
  evalsRoot: string; request: EvalRequest; execution: EvalExecutionPolicyV1; modelCapturePlan: ModelCapturePlanV1;
  submissionDigest: `sha256:${string}`; keyHash?: `sha256:${string}`; reservedEvalId?: EvalId;
  emit: (directory: string, evalId: EvalId, event: Record<string, unknown>) => Promise<unknown>;
}): Promise<{ evalId: EvalId; directory: string }> {
  const evalId = input.reservedEvalId ?? newEvalId();
  const directory = path.join(input.evalsRoot, evalId);
  await mkdir(directory, { mode: 0o700 });
  try {
    const now = new Date().toISOString();
    const submission: EvalSubmissionV1 = { schema_version: "1", eval_id: evalId, request: input.request, execution: input.execution,
      submission_digest: input.submissionDigest, ...(input.keyHash ? { idempotency_key_hash: input.keyHash } : {}), submitted_at: now };
    const control: EvalControlV1 = { schema_version: "1", eval_id: evalId, generation: 0, state: "queued",
      requested_parallelism: input.execution.max_parallelism, admitted_parallelism: 0, active_leases: [], queued_work_items: [],
      terminal_work_items: [], created_at: now, updated_at: now };
    await atomicWriteJSON(path.join(directory, "request.json"), input.request);
    await atomicWriteJSON(path.join(directory, "submission.json"), submission);
    await atomicWriteJSON(path.join(directory, "control.json"), control);
    await input.emit(directory, evalId, { type: "eval.queued", requested_parallelism: input.execution.max_parallelism, model_capture: input.modelCapturePlan });
    return { evalId, directory };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
