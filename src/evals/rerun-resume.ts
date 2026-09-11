import path from "node:path";
import type { EvalExecutionPlanV1, EvalProgressV1, EvalRequest } from "../domain/index.js";
import { HitchError, readJSON, sha256JSON } from "../foundation/index.js";
import { candidateRestartWorkItem } from "./physical-work-plan.js";
import type { EvalRerunType } from "./rerun-types.js";
import { evalRerunSemantics } from "./rerun-types.js";
import { slotKey, sortSlots, uniqueTasks } from "./rerun-slots.js";
import type { EvalTrialSlot, RerunSelector } from "./rerun-slots.js";
import type { EvalRemoteWorkExecutionResult } from "./service-types.js";
import { readExecutionLeases } from "./execution-leases.js";

/** Restore the original selection; recovered publications must not select a new batch. */
export async function restoreRemoteRerunSelection(input: {
  directory: string; evalId: string; rerunId: string; selector: RerunSelector;
  tasks: readonly string[]; attempts: number; progress: EvalProgressV1; rerunType?: EvalRerunType; verifierRuntimeId?: string;
}): Promise<{ trials: EvalTrialSlot[]; startedAt: string }> {
  const type = input.rerunType ?? "candidate-restart";
  const saved = await readJSON<Record<string, unknown> | null>(path.join(input.directory, "request.json"), null);
  if (!saved || saved.schema_version !== "1" || saved.eval_id !== input.evalId || saved.rerun_id !== input.rerunId
    || !["candidate-restart", "verifier-only"].includes(type) || saved.rerun_type !== type
    || saved.verifier_runtime_id !== input.verifierRuntimeId || saved.mode !== input.selector.mode
    || sha256JSON(saved.semantics) !== sha256JSON(evalRerunSemantics(type))
    || !Number.isSafeInteger(saved.base_generation) || (saved.base_generation as number) < 0
    || (saved.base_generation as number) > input.progress.generation
    || typeof saved.created_at !== "string" || !Number.isFinite(Date.parse(saved.created_at))
    || !Array.isArray(saved.trials)) throw ambiguous("remote rerun has no valid frozen selection");
  const trials = saved.trials.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw ambiguous("remote rerun selected trial is invalid");
    const slot = value as Record<string, unknown>;
    if (Object.keys(slot).length !== 2 || typeof slot.task_id !== "string" || !input.tasks.includes(slot.task_id)
      || !Number.isSafeInteger(slot.attempt) || (slot.attempt as number) < 1 || (slot.attempt as number) > input.attempts) throw ambiguous("remote rerun selected trial differs from the frozen plan");
    return { task_id: slot.task_id, attempt: slot.attempt as number };
  });
  if (new Set(trials.map(slotKey)).size !== trials.length || sha256JSON(trials) !== sha256JSON(sortSlots(trials))
    || sha256JSON(saved.tasks) !== sha256JSON(uniqueTasks(trials))
    || input.selector.mode === "tasks" && sha256JSON([...new Set(input.selector.taskNames)].sort()) !== sha256JSON(uniqueTasks(trials))) {
    throw ambiguous("remote rerun selected tasks do not match its original request");
  }
  return { trials, startedAt: saved.created_at };
}

/** Inspect every work journal before starting a model service or dispatching anything. */
export async function remoteRerunNeedsExecution(input: {
  evalDirectory: string; directory: string; rerunId: string; plan: EvalExecutionPlanV1;
  request: EvalRequest; slots: readonly EvalTrialSlot[];
}): Promise<boolean> {
  const leases = await readExecutionLeases(input.evalDirectory);
  let needsExecution = false;
  for (const slot of input.slots) {
    const logical = input.plan.slots.find(item => item.task_id === slot.task_id && item.attempt === slot.attempt);
    const source = logical && input.plan.work_items.find(item => item.slots.includes(logical.slot_id));
    if (!source || source.slots.length !== 1 || source.task_ids.length !== 1) throw ambiguous("remote rerun selection has no single-task physical source");
    const work = candidateRestartWorkItem(source, input.rerunId);
    const identity = { schema_version: "1", rerun_id: input.rerunId, source_work_id: source.work_id,
      work_id: work.work_id, plan_digest: sha256JSON(input.plan), request_digest: sha256JSON(input.request) };
    const journal = await readJSON<{ identity: unknown; state: string; lease_id?: string; result?: EvalRemoteWorkExecutionResult } | null>(
      path.join(input.directory, "remote-work", `${work.work_id}.json`), null);
    if (!journal) { needsExecution = true; continue; }
    if (journal.state === "not-started" && sha256JSON(journal.identity) === sha256JSON(identity) && !journal.result
      && leases.some(lease => lease.lease_id === journal.lease_id && lease.work_id === work.work_id
        && lease.provider === input.plan.provider && lease.state === "released")) { needsExecution = true; continue; }
    if (sha256JSON(journal.identity) !== sha256JSON(identity) || journal.state !== "completed" || !journal.result
      || !leases.some(lease => lease.lease_id === journal.result!.leaseId && lease.work_id === work.work_id
        && lease.provider === input.plan.provider && lease.state === "released")) throw ambiguous("remote rerun work needs a matching collected result and confirmed lease release");
    if (journal.result.run.backend.process_exit_code !== 0 || journal.result.run.rawResult === null) {
      throw new HitchError("recovered remote Harbor rerun failed before producing a complete result", { code: "eval_rerun_harbor_failed", exitCode: 13 });
    }
  }
  return needsExecution;
}

function ambiguous(message: string): HitchError { return new HitchError(message, { code: "execution_state_ambiguous", exitCode: 12 }); }
