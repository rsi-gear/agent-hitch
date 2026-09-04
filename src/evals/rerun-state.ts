import { SCHEMA_VERSION, atomicWriteJSON } from "../foundation/index.js";
import { evalRerunSemantics } from "./rerun-types.js";
import type { EvalRerunType } from "./rerun-types.js";
import { sortSlots } from "./rerun-slots.js";
import type { EvalTrialSlot } from "./rerun-slots.js";

export async function writeRerunState(file: string, input: {
  rerunId: string;
  evalId: string;
  rerunType: EvalRerunType;
  status: "running" | "completed" | "failed";
  tasks: readonly string[];
  trials?: readonly EvalTrialSlot[];
  repairedTasks: readonly string[];
  repairedTrials?: readonly EvalTrialSlot[];
  startedAt: string;
  completedAt?: string;
  evalStatus?: "succeeded" | "failed";
  remainingInvalidTasks?: readonly string[];
  remainingInvalidTrials?: readonly EvalTrialSlot[];
  errorCode?: string;
}): Promise<void> {
  await atomicWriteJSON(file, {
    schema_version: SCHEMA_VERSION,
    rerun_id: input.rerunId,
    eval_id: input.evalId,
    rerun_type: input.rerunType,
    semantics: evalRerunSemantics(input.rerunType),
    status: input.status,
    tasks: [...input.tasks],
    ...(input.trials ? { trials: sortSlots(input.trials) } : {}),
    repaired_tasks: [...input.repairedTasks],
    ...(input.repairedTrials ? { repaired_trials: sortSlots(input.repairedTrials) } : {}),
    ...(input.evalStatus ? { eval_status: input.evalStatus } : {}),
    ...(input.remainingInvalidTasks ? { remaining_invalid_tasks: [...input.remainingInvalidTasks] } : {}),
    ...(input.remainingInvalidTrials ? { remaining_invalid_trials: sortSlots(input.remainingInvalidTrials) } : {}),
    ...(input.errorCode ? { error: { code: input.errorCode } } : {}),
    started_at: input.startedAt,
    ...(input.completedAt ? { completed_at: input.completedAt } : {}),
    updated_at: input.completedAt ?? new Date().toISOString(),
  });
}
