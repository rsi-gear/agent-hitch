import type { EvalId } from "../domain/index.js";
import { evalRerunSemantics, parseEvalRerunType } from "../evals/index.js";
import type { EvalRerunType, RerunSelector } from "../evals/index.js";
import { invalidInput } from "../foundation/index.js";

export type ParsedRerunInput = { rerun_id?: string; rerun_type: EvalRerunType; verifier_runtime_id?: string; selector: RerunSelector };

export function validateRerunId(value: string): void {
  if (!/^rerun_[a-f0-9]{32}$/.test(value)) throw invalidInput("eval rerun id is invalid");
}

export function parseEvalRerunSubmissionInput(value: unknown): ParsedRerunInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput("eval rerun request must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "rerun_type" && key !== "selector" && key !== "rerun_id" && key !== "verifier_runtime_id")) throw invalidInput("eval rerun request has unknown fields");
  if (input.rerun_id !== undefined) {
    if (typeof input.rerun_id !== "string") throw invalidInput("eval rerun id is invalid");
    validateRerunId(input.rerun_id);
  }
  const rerunType = parseEvalRerunType(input.rerun_type ?? "candidate-restart");
  if (input.verifier_runtime_id !== undefined && (rerunType !== "verifier-only" || typeof input.verifier_runtime_id !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(input.verifier_runtime_id))) throw invalidInput("verifier runtime requires verifier-only and an exact digest");
  return { ...(input.rerun_id === undefined ? {} : { rerun_id: input.rerun_id as string }),
    ...(input.verifier_runtime_id === undefined ? {} : { verifier_runtime_id: input.verifier_runtime_id as string }),
    rerun_type: rerunType, selector: parseSelector(input.selector) };
}

export function parsePersistedSubmission(value: Record<string, unknown>, evalId: EvalId, rerunId: string): ParsedRerunInput {
  const allowed = new Set(["schema_version", "rerun_id", "eval_id", "rerun_type", "semantics", "selector", "submitted_at", "verifier_runtime_id"]);
  if (value.schema_version !== "1" || value.eval_id !== evalId || value.rerun_id !== rerunId
    || Object.keys(value).some((key) => !allowed.has(key))
    || typeof value.submitted_at !== "string" || !Number.isFinite(Date.parse(value.submitted_at))) {
    throw new TypeError("eval rerun submission identity is invalid");
  }
  const parsed = parseEvalRerunSubmissionInput({ rerun_type: value.rerun_type, selector: value.selector,
    ...(value.verifier_runtime_id === undefined ? {} : { verifier_runtime_id: value.verifier_runtime_id }) });
  if (JSON.stringify(value.semantics) !== JSON.stringify(evalRerunSemantics(parsed.rerun_type))) {
    throw new TypeError("eval rerun submission semantics do not match rerun_type");
  }
  return parsed;
}

function parseSelector(value: unknown): RerunSelector {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput("eval rerun selector must be an object");
  const selector = value as Record<string, unknown>;
  if (selector.mode === "invalid") {
    if (Object.keys(selector).some((key) => key !== "mode")) throw invalidInput("invalid selector has unknown fields");
    return { mode: "invalid" };
  }
  if (selector.mode !== "tasks" || Object.keys(selector).some((key) => key !== "mode" && key !== "task_names")
    || !Array.isArray(selector.task_names) || selector.task_names.length < 1 || selector.task_names.length > 10_000
    || selector.task_names.some((task) => typeof task !== "string" || task.length < 1 || task.length > 1_024)) {
    throw invalidInput("task selector requires 1-10000 bounded task_names");
  }
  const taskNames = selector.task_names as string[];
  if (new Set(taskNames).size !== taskNames.length) throw invalidInput("eval rerun task_names must be unique");
  return { mode: "tasks", taskNames: [...taskNames] };
}

export function serializedSelector(selector: RerunSelector): Record<string, unknown> {
  return selector.mode === "invalid" ? { mode: "invalid" } : { mode: "tasks", task_names: [...selector.taskNames] };
}
