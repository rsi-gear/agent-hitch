import { admittedBindings, type CapabilityBinding, type VerifiedCapabilityBindings } from "./bindings.js";
import { capabilityCounters, type CapabilityAction, type CapabilityCounter } from "./capability-actions.js";
import { canonicalJSON, sha256JSON } from "../foundation/index.js";
import { requireCapabilities, tightenPolicy, validateParameterContract, validateRule, type ParameterContract, type ParameterRule } from "./contract.js";
import { at, failure, record, validateValue, type JSONObject, type JSONValue } from "./schema.js";
export interface ParameterAudit {
  recorded_at: string; actor: "user" | "meta" | "target"; path: string; old_value: unknown; new_value: unknown;
  rule: ParameterRule | null; phase: "task_start" | "training_start"; accepted: boolean; reason: string;
}
export interface ParameterState {
  version: 1; contract: ParameterContract; effective: JSONObject; initial_effective: JSONObject;
  capability_deadline_ms?: number; capability_runtime: Record<string, JSONObject>;
  bindings: CapabilityBinding[]; capability_actions: Record<string, CapabilityAction>; counters: Record<string, CapabilityCounter>; selections: Record<string, { identity: string; action: string }>; policy: Record<string, ParameterRule>;
  evaluation_id: string; candidate_id: string; execution_id: string;
  identity: Record<string, JSONValue>; audit: ParameterAudit[];
  actions: Record<string, { request_digest: string; effective: JSONObject; action_id: string }>;
  compliance: "configuration_validated_execution_unverified";
}
export interface AdmissionOptions {
  bindings?: VerifiedCapabilityBindings;
  user?: JSONObject; meta?: JSONObject; policy?: Record<string, ParameterRule>; identity?: Record<string, JSONValue>;
}
export interface ParameterDecision { accepted: boolean; state: ParameterState; reason: string; action_id?: string }
const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
const escaped = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
function changes(before: unknown, after: unknown, policy: Record<string, ParameterRule>, path = ""): string[] {
  if (same(before, after)) return [];
  if (Object.hasOwn(policy, path)) return [path];
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => changes((before as JSONObject)[key], (after as JSONObject)[key], policy, `${path}/${escaped(key)}`));
  }
  // Deletion/replacement of a parent cannot swallow locked descendants.
  if (before && typeof before === "object" && !Array.isArray(before)) return Object.keys(before).sort().flatMap(key => changes((before as JSONObject)[key], undefined, policy, `${path}/${escaped(key)}`));
  return [path];
}
const optionalAt = (value: unknown, path: string): unknown => { try { return at(value, path); } catch { return { absent: true }; } };
function propose(state: ParameterState, value: JSONObject, actor: ParameterAudit["actor"], phase: ParameterAudit["phase"]): ParameterDecision {
  const next = structuredClone(state), paths = changes(next.effective, value, next.policy);
  let reason = "accepted";
  try {
    validateValue(value, next.contract.schema);
    for (const path of paths) {
      const rule = next.policy[path];
      if (actor !== "user" && (!rule?.mutable || !rule.actors?.includes(actor) || actor === "target" && (phase !== "training_start" || rule.apply_at !== phase))) failure(`${actor} cannot change ${path} at ${phase}`, "parameter_permission_rejected");
    }
    for (const [path, rule] of Object.entries(next.policy)) validateRule(at(value, path), rule, path);
    if (actor === "target") for (const binding of next.bindings) {
      const counter = binding.counter.limit_parameter;
      if (!same(at(value, counter), at(next.initial_effective, counter))) failure("capability quota is frozen for this execution", "parameter_permission_rejected");
    }
    requireCapabilities(next.contract, value, next.bindings);
  } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  const accepted = reason === "accepted";
  for (const path of paths.length ? paths : reason === "accepted" ? [] : [""]) next.audit.push({ recorded_at: new Date().toISOString(), actor, path, old_value: path ? optionalAt(next.effective, path) : next.effective,
    new_value: path ? optionalAt(value, path) : value, rule: next.policy[path] ?? null, phase, accepted, reason });
  if (accepted) next.effective = structuredClone(value);
  return { accepted, state: next, reason };
}
export function admitParameters(raw: unknown, options: AdmissionOptions = {}): ParameterState {
  let contract = validateParameterContract(raw);
  const identity = structuredClone(options.identity ?? {});
  const bindings = admittedBindings(options.bindings);
  if (canonicalJSON(bindings) !== canonicalJSON(contract.capability_bindings ?? [])) failure("capability bindings were not verified for this contract", "unsupported_constraint");
  let state: ParameterState = { version: 1, contract, bindings, capability_runtime: {}, capability_actions: {}, counters: {}, selections: {}, initial_effective: structuredClone(contract.parameters), effective: structuredClone(contract.parameters), policy: structuredClone(contract.parameter_policy),
    evaluation_id: "", candidate_id: "", execution_id: "", identity, audit: [], actions: {}, compliance: "configuration_validated_execution_unverified" };
  const apply = (actor: "user" | "meta") => {
    if (options[actor] === undefined) return;
    record(options[actor], `${actor} parameters`);
    const decision = propose(state, options[actor]!, actor, "task_start"); state = decision.state;
    if (!decision.accepted) { const error = new Error(decision.reason); Object.assign(error, { code: decision.reason.includes("unsupported_constraint") ? "unsupported_constraint" : "parameter_permission_rejected", audit: state.audit }); throw error; }
  };
  apply("user");
  // Tightening and the admitted user value form one configuration. Validate
  // the narrowed bounds against that value, not an obsolete package default.
  if (options.policy !== undefined) {
    record(options.policy, "user parameter policy");
    contract = tightenPolicy({ ...contract, parameters: state.effective }, options.policy);
    state.contract = contract; state.policy = structuredClone(contract.parameter_policy);
  }
  apply("meta");
  requireCapabilities(contract, state.effective, bindings);
  state.initial_effective = structuredClone(state.effective);
  state.counters = capabilityCounters(bindings, state.effective);
  state.evaluation_id = sha256JSON({ task: identity.task ?? null, schema: contract.schema, policy: contract.parameter_policy,
    requirements: contract.capability_requirements ?? [], bindings, evaluation: (contract.evaluation_paths ?? []).map(p => [p, at(state.effective, p)]) });
  state.candidate_id = sha256JSON({ harness: identity.harness ?? null, inputs: identity.candidate_inputs ?? null, meta: options.meta ?? null });
  state.execution_id = sha256JSON({ evaluation_id: state.evaluation_id, candidate_id: state.candidate_id, effective: state.effective, identity });
  return state;
}
export function submitParameterAction(state: ParameterState, id: string, value: JSONObject): ParameterDecision {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)) failure("invalid parameter action ID");
  const request_digest = sha256JSON(value), previous = state.actions[id];
  if (previous) {
    if (previous.request_digest === request_digest) return { accepted: true, state: structuredClone(state), reason: "replayed immutable action", action_id: previous.action_id };
    const next = structuredClone(state), reason = `action ${id} is already frozen`;
    next.audit.push({ recorded_at: new Date().toISOString(), actor: "target", path: "", old_value: previous.effective, new_value: value, rule: null, phase: "training_start", accepted: false, reason });
    return { accepted: false, state: next, reason };
  }
  const decision = propose(state, value, "target", "training_start");
  if (decision.accepted) {
    const action_id = sha256JSON({ execution_id: state.execution_id, id, effective: decision.state.effective });
    decision.state.actions[id] = { request_digest, effective: structuredClone(decision.state.effective), action_id };
    decision.action_id = action_id;
  }
  return decision;
}
