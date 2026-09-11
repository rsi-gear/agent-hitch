import path from "node:path";
import type { EvalProgressV1 } from "../domain/index.js";
import { atomicWriteJSON } from "../foundation/index.js";
import { stageRemoteRerunCompletion } from "./rerun-completion.js";
import { evalRerunSemantics } from "./rerun-types.js";
import type { EvalRerunResult } from "./rerun-types.js";
import { invalidTrialSlots, uniqueTasks } from "./rerun-slots.js";
import type { EvalTrialSlot } from "./rerun-slots.js";
import { summarizeTrialRefs } from "./result-helpers.js";

export async function finishVerifierRerun(input: {
  evalId: string; evalDirectory: string; rerunId: string; rerunDirectory: string; startedAt: string;
  plan: { tasks: string[]; attempts: number }; previousResult: Record<string, unknown> | null;
  selectedTrials: EvalTrialSlot[]; progress: EvalProgressV1; repaired: EvalTrialSlot[];
  sources: NonNullable<EvalRerunResult["sources"]>; remote?: boolean;
}): Promise<EvalRerunResult> {
  const remaining = invalidTrialSlots(input.plan.tasks, input.plan.attempts, input.progress);
  const completed = new Date().toISOString();
  const output: EvalRerunResult = { schema_version: "1", kind: "eval-rerun", rerun_id: input.rerunId, rerun_type: "verifier-only", semantics: evalRerunSemantics("verifier-only"),
    eval_id: input.evalId, status: "completed", selected_tasks: uniqueTasks(input.selectedTrials), selected_trials: input.selectedTrials,
    repaired_tasks: uniqueTasks(input.repaired), repaired_trials: input.repaired, remaining_invalid_tasks: uniqueTasks(remaining), remaining_invalid_trials: remaining, sources: input.sources,
    eval_status: remaining.length ? "failed" : "succeeded", started_at: input.startedAt, completed_at: completed };
  const result = { ...input.previousResult, status: output.eval_status, exit_code: remaining.length ? 13 : 0, generation: input.progress.generation,
    trials: input.progress.trials, summary: summarizeTrialRefs(input.progress.trials), completed_at: completed };
  if (!remaining.length) delete (result as Record<string, unknown>).error;
  await atomicWriteJSON(path.join(input.evalDirectory, "result.json"), result);
  if (input.remote) await stageRemoteRerunCompletion(input.evalDirectory, input.rerunDirectory, output);
  await atomicWriteJSON(path.join(input.rerunDirectory, "state.json"), { ...output, tasks: output.selected_tasks, trials: input.selectedTrials, updated_at: completed });
  return output;
}
