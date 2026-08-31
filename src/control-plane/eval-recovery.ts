import { readdir } from "node:fs/promises";
import path from "node:path";
import type { EvalControlV1, EvalId, EvalRequest } from "../domain/index.js";
import { SCHEMA_VERSION, atomicWriteJSON, readJSON } from "../foundation/index.js";
import { EvalEventSink, parseEvalExecutionPlan, readExecutionLeases, recoverLocalDockerEvalLeases } from "../evals/index.js";
import { isTerminalControl, parseEvalControl, parseEvalSubmission, terminalControlState } from "./eval-records.js";

export interface RecoveredEvalEntry {
  evalId: EvalId;
  request: EvalRequest;
  directory: string;
  resumeExisting: boolean;
}

export async function recoverPersistedEvals(input: {
  root: string;
  evalsRoot: string;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<RecoveredEvalEntry[]> {
  const queue: RecoveredEvalEntry[] = [];
  const entries = await readdir(input.evalsRoot, { withFileTypes: true });
  for (const item of entries) {
    if (!item.isDirectory() || !/^eval_[a-f0-9]{32}$/.test(item.name)) continue;
    const evalId = item.name as EvalId;
    const directory = path.join(input.evalsRoot, evalId);
    const submissionValue = await readJSON<unknown | null>(path.join(directory, "submission.json"), null);
    const controlValue = await readJSON<unknown | null>(path.join(directory, "control.json"), null);
    if (!submissionValue || !controlValue) continue;
    const submission = await parseEvalSubmission(submissionValue, evalId);
    const control = parseEvalControl(controlValue);
    const result = await readJSON<Record<string, unknown> | null>(path.join(directory, "result.json"), null);
    if (result) {
      if (!isTerminalControl(control.state)) await updateControl(directory, (current) => ({ ...withoutAllocation(current), state: terminalControlState(result.status) }));
      continue;
    }
    if (control.state === "queued") {
      queue.push({ evalId, request: submission.request, directory, resumeExisting: false });
      continue;
    }
    if (isTerminalControl(control.state)) continue;
    const sink = new EvalEventSink(directory, evalId, input.onEvent);
    await sink.open();
    const leases = await readExecutionLeases(directory);
    const recovery = await recoverLocalDockerEvalLeases({
      root: input.root,
      evalId,
      evalDirectory: directory,
      leases,
      cancelRequested: control.state === "cancelling",
      emit: (event) => sink.emit(event),
    });
    if (control.state === "cancelling") {
      const now = new Date().toISOString();
      await writeSyntheticResult(directory, evalId, submission.request, control, "cancelled", "cancelled", "eval cancellation was recovered after daemon restart", now);
      await updateControl(directory, (current) => ({ ...withoutAllocation(current), state: "cancelled", error: { code: "cancelled", message: "eval cancellation was recovered after daemon restart" } }));
      sink.emit({ type: "eval.recovered", status: "cancelled", code: "cancelled" });
      await sink.close();
      continue;
    }
    if (recovery.status === "ambiguous") {
      const now = new Date().toISOString();
      const code = recovery.code || "execution_state_ambiguous";
      const message = recovery.message || "daemon restarted while eval execution state was ambiguous";
      await writeSyntheticResult(directory, evalId, submission.request, control, "failed", code, message, now);
      await updateControl(directory, (current) => ({ ...withoutAllocation(current), state: "failed", error: { code, message } }));
      sink.emit({ type: "eval.recovered", status: "failed", code });
      await sink.close();
      continue;
    }
    const files = await resumableFiles(directory);
    if (files === "inconsistent") {
      const now = new Date().toISOString();
      const message = "daemon restarted with incomplete persisted eval planning state";
      await writeSyntheticResult(directory, evalId, submission.request, control, "failed", "execution_state_ambiguous", message, now);
      await updateControl(directory, (current) => ({ ...withoutAllocation(current), state: "failed", error: { code: "execution_state_ambiguous", message } }));
      sink.emit({ type: "eval.recovered", status: "failed", code: "execution_state_ambiguous" });
    } else {
      queue.push({ evalId, request: submission.request, directory, resumeExisting: files === "complete" });
      sink.emit({ type: "eval.recovered", status: "queued", recovery: files === "complete" ? "resume" : "restart-before-execution" });
    }
    await sink.close();
  }
  return queue;
}

async function resumableFiles(directory: string): Promise<"absent" | "complete" | "inconsistent"> {
  const [plan, executionPlan, progress, resolution] = await Promise.all([
    readJSON<Record<string, unknown> | null>(path.join(directory, "plan.json"), null),
    readJSON<unknown | null>(path.join(directory, "execution-plan.json"), null),
    readJSON<unknown | null>(path.join(directory, "progress.json"), null),
    readJSON<unknown | null>(path.join(directory, "resolution.json"), null),
  ]);
  const values = [plan, executionPlan, progress, resolution];
  if (values.every((value) => value === null)) return "absent";
  if (values.some((value) => value === null) || plan?.attempt_execution !== "harbor-task-slots-v1") return "inconsistent";
  try {
    const parsed = parseEvalExecutionPlan(executionPlan);
    return parsed.membership === "known"
      && parsed.work_items.every((item) => item.task_ids.length === 1 && item.slots.length === 1 && item.logical_attempt !== null)
      ? "complete"
      : "inconsistent";
  } catch { return "inconsistent"; }
}

async function writeSyntheticResult(
  directory: string,
  evalId: EvalId,
  request: EvalRequest,
  control: EvalControlV1,
  status: "failed" | "cancelled",
  code: string,
  message: string,
  completedAt: string,
): Promise<void> {
  if (await readJSON(path.join(directory, "result.json"), null)) return;
  await atomicWriteJSON(path.join(directory, "result.json"), {
    schema_version: SCHEMA_VERSION,
    eval_id: evalId,
    status,
    exit_code: status === "cancelled" ? 9 : 12,
    error: { code, message },
    benchmark_id: request.benchmark_id,
    benchmark_revision: request.benchmark_revision,
    trials: [],
    started_at: control.created_at,
    completed_at: completedAt,
  });
}

async function updateControl(directory: string, update: (control: EvalControlV1) => EvalControlV1): Promise<void> {
  const current = parseEvalControl(await readJSON(path.join(directory, "control.json")));
  await atomicWriteJSON(path.join(directory, "control.json"), parseEvalControl({
    ...update(current),
    schema_version: "1",
    eval_id: current.eval_id,
    generation: current.generation + 1,
    created_at: current.created_at,
    updated_at: new Date().toISOString(),
  }));
}

function withoutAllocation(control: EvalControlV1): EvalControlV1 {
  const { allocation_id: _allocationId, ...rest } = control;
  return rest;
}
