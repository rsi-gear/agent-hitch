import { canonicalJSON, sha256JSON } from "../foundation/index.js";
import { at, exact, failure, record, type JSONObject, type JSONValue } from "./schema.js";
import type { CapabilityBinding } from "./bindings.js";
import type { ParameterState } from "./authority.js";
export interface CapabilityActionRequest { binding: string; id: string; parameter_action: string; operation: string; arguments: JSONObject }
export interface CapabilityAction {
  binding: string; request_digest: string; request: CapabilityActionRequest; parameter_action_id: string;
  plan: JSONObject; status: "reserved" | "running" | "completed" | "failed" | "unavailable";
  steps: { input: JSONValue; status: "reserved" | "started" | "completed" | "failed"; started_at?: string; result?: JSONObject }[];
  result?: JSONObject; reason?: string; created_at: string;
}
export interface CapabilityCounter { reserved: number; consumed: number; limit: number | null; unit: string }
const actionId = (s: unknown): s is string => typeof s === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(s);
export function parseCapabilityRequest(raw: unknown): CapabilityActionRequest {
  const r = record(raw, "capability action request"); exact(r, ["binding", "id", "parameter_action", "operation", "arguments"], "capability action request");
  if (!actionId(r.binding) || !actionId(r.id) || !actionId(r.parameter_action) || !actionId(r.operation)) failure("invalid capability action identity");
  const args = record(r.arguments, "capability action arguments");
  for (const key of ["command", "execution_id", "request_id", "operation", "parameters", "parameter_action_id", "plan", "results", "steps"]) if (Object.hasOwn(args, key)) failure(`reserved capability argument ${key}`);
  return structuredClone(r) as unknown as CapabilityActionRequest;
}
export function capabilityPlanInput(state: ParameterState, raw: unknown): { request: CapabilityActionRequest; binding: CapabilityBinding; input: JSONObject; existing?: CapabilityAction } {
  const request = parseCapabilityRequest(raw), binding = state.bindings.find(b => b.id === request.binding);
  if (!binding) failure("unsupported_constraint: no admitted capability binding", "unsupported_constraint");
  const selected = request.parameter_action === "task" ? { effective: state.initial_effective, action_id: sha256JSON({ execution_id: state.execution_id, phase: "task_start" }) } : state.actions[request.parameter_action];
  if (!selected) failure("capability requires a registered immutable parameter action");
  const previous = state.capability_actions[request.id];
  if (previous) {
    if (previous.request_digest !== sha256JSON(request)) failure("capability action ID is frozen");
    return { request, binding, input: {}, existing: structuredClone(previous) };
  }
  if (Object.keys(state.selections).some(k => k.startsWith(binding.id + ":"))) failure("capability selection is frozen; no new actions are permitted");
  const args = structuredClone(request.arguments);
  if (args.source_action !== undefined) {
    if (!actionId(args.source_action)) failure("source_action must reference a trusted action");
    const source = state.capability_actions[args.source_action];
    if (!source || source.binding !== binding.id || source.status !== "completed" || !source.result) failure("source_action is not a completed action from this binding");
    args.source_action = { status: source.status, plan: source.plan, summary: source.result.summary ?? null };
  }
  return { request, binding, input: { ...args, command: "plan", execution_id: state.execution_id, request_id: request.id,
    operation: request.operation, parameters: selected.effective, parameter_action_id: selected.action_id } };
}
export function reserveCapabilityAction(state: ParameterState, raw: unknown, output: unknown): ParameterState {
  const next = structuredClone(state), context = capabilityPlanInput(next, raw);
  if (next.capability_deadline_ms !== undefined && Date.now() >= next.capability_deadline_ms && !context.existing) failure("capability whole-task wall budget exhausted");
  if (context.existing) return next;
  const planned = record(output, "capability plan"), plan = record(planned.plan, "frozen capability plan") as JSONObject;
  if (planned.version !== 1 || !Array.isArray(planned.steps) || !planned.steps.length || planned.steps.length > 256
    || planned.count_unit !== context.binding.counter.unit || planned.source_digest !== context.binding.source.sha256
    || plan.execution_id !== next.execution_id || plan.request_id !== context.request.id
    || plan.parameter_action_id !== context.input.parameter_action_id || canonicalJSON(plan.parameters) !== canonicalJSON(context.input.parameters)) failure("trusted capability plan identity mismatch");
  const budget = next.counters[context.binding.id]!;
  if (budget.limit !== null && budget.reserved + budget.consumed + planned.steps.length > budget.limit) failure("capability execution quota exhausted", "constraint_quota_exhausted");
  if (planned.freeze !== undefined) {
    const freeze = record(planned.freeze, "capability selection freeze"); exact(freeze, ["key", "identity"], "capability selection freeze");
    if (!actionId(freeze.key) || typeof freeze.identity !== "string" || !/^sha256:[a-f0-9]{64}$/.test(freeze.identity)) failure("invalid capability selection identity");
    next.selections[`${context.binding.id}:${freeze.key}`] = { identity: freeze.identity, action: context.request.id };
  }
  budget.reserved += planned.steps.length;
  next.capability_actions[context.request.id] = { binding: context.binding.id, request_digest: sha256JSON(context.request), request: context.request,
    parameter_action_id: String(context.input.parameter_action_id), plan: structuredClone(plan), status: "reserved",
    steps: planned.steps.map(input => ({ input: input as JSONValue, status: "reserved" })), created_at: new Date().toISOString() };
  return next;
}
export function startCapabilityStep(state: ParameterState, id: string, index: number): ParameterState {
  const next = structuredClone(state), action = next.capability_actions[id], step = action?.steps[index];
  if (next.capability_deadline_ms !== undefined && Date.now() >= next.capability_deadline_ms) failure("capability whole-task wall budget exhausted");
  if (!action || !Number.isSafeInteger(index) || !step || step.status !== "reserved" || !["reserved", "running"].includes(action.status)) failure("capability step cannot be restarted or is unavailable");
  if (action.steps.some(s => s.status === "started")) failure("an earlier capability step has unavailable evidence");
  step.status = "started"; step.started_at = new Date().toISOString(); action.status = "running";
  const counter = next.counters[action.binding]!; counter.reserved -= 1; counter.consumed += 1;
  return next;
}
export function finishCapabilityStep(state: ParameterState, id: string, index: number, raw: unknown): ParameterState {
  const next = structuredClone(state), action = next.capability_actions[id], step = action?.steps[index];
  if (!action || !Number.isSafeInteger(index) || !step || step.status !== "started") failure("capability step completion is not expected");
  const result = record(raw, "capability step evidence") as JSONObject;
  if (result.version !== 1 || result.step_index !== index || result.plan_id !== action.plan.id || result.top_level_attempts !== 1 || typeof result.status !== "string" || !/^[a-z][a-z_]{0,63}$/.test(result.status)) failure("capability step evidence identity mismatch");
  step.result = structuredClone(result); step.status = result.status === "completed" ? "completed" : "failed";
  return next;
}
export function finishCapabilityAction(state: ParameterState, id: string, raw: unknown): ParameterState {
  const next = structuredClone(state), action = next.capability_actions[id];
  if (!action || !["reserved", "running"].includes(action.status) || action.steps.some(s => s.status !== "completed" && s.status !== "failed")) failure("capability action lacks complete execution evidence");
  const result = record(raw, "capability result") as JSONObject;
  if (result.version !== 1 || !result.summary) failure("capability result is invalid");
  action.result = structuredClone(result); action.status = result.status === "completed" ? "completed" : "failed";
  return next;
}
export function unavailableCapabilityAction(state: ParameterState, id: string, reason: string): ParameterState {
  const next = structuredClone(state), action = next.capability_actions[id];
  if (!action) failure("unknown capability action");
  action.status = "unavailable"; action.reason = reason.slice(0, 4096);
  return next;
}
export function capabilityCounters(bindings: CapabilityBinding[], effective: JSONObject): Record<string, CapabilityCounter> {
  return Object.fromEntries(bindings.map(binding => {
    const limit = at(effective, binding.counter.limit_parameter);
    if (limit !== null && (!Number.isSafeInteger(limit) || Number(limit) < 1)) failure("capability counter limit must be a positive integer or null");
    return [binding.id, { reserved: 0, consumed: 0, limit: limit as number | null, unit: binding.counter.unit }];
  }));
}
