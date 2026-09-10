import { mkdtemp, rename, rm } from "node:fs/promises";
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
  // Recovery must only see complete submissions. A crash before publication
  // must not occupy an ordered command's reserved ID with a partial directory.
  const staging = await mkdtemp(path.join(input.evalsRoot, `.pending-${evalId}-`));
  try {
    const now = new Date().toISOString();
    const submission: EvalSubmissionV1 = { schema_version: "1", eval_id: evalId, request: input.request, execution: input.execution,
      submission_digest: input.submissionDigest, ...(input.keyHash ? { idempotency_key_hash: input.keyHash } : {}), submitted_at: now };
    const control: EvalControlV1 = { schema_version: "1", eval_id: evalId, generation: 0, state: "queued",
      requested_parallelism: input.execution.max_parallelism, admitted_parallelism: 0, active_leases: [], queued_work_items: [],
      terminal_work_items: [], created_at: now, updated_at: now };
    await atomicWriteJSON(path.join(staging, "request.json"), input.request);
    await atomicWriteJSON(path.join(staging, "submission.json"), submission);
    await atomicWriteJSON(path.join(staging, "control.json"), control);
    await input.emit(staging, evalId, { type: "eval.queued", requested_parallelism: input.execution.max_parallelism, model_capture: input.modelCapturePlan });
    await rename(staging, directory);
    return { evalId, directory };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
