import { parseCapabilityBindings, type CapabilityBinding } from "./bindings.js";
import { canonicalJSON } from "../foundation/index.js";
import { at, exact, failure, pointer, record, schemaAt, validateSchema, validateValue, type JSONObject, type JSONValue, type ParameterSchema } from "./schema.js";
export interface ParameterRule {
  mutable: boolean; actors?: ("meta" | "target")[]; apply_at?: "task_start" | "training_start";
  choices?: JSONValue[]; minimum?: number; maximum?: number; nullable?: boolean;
}
export interface ParameterContract {
  version: 1; parameters: JSONObject; schema: ParameterSchema; parameter_policy: Record<string, ParameterRule>;
  capability_requirements?: { path: string; condition: "non_null" | "equals"; value?: JSONValue; capability: string; coverage: string }[];
  capability_bindings?: CapabilityBinding[];
  evaluation_paths?: string[]; evaluation_inputs?: string[]; evaluation_input_origins?: Record<string, string>; candidate_inputs?: string[]; candidate_parameters?: string;
}
export function validateParameterContract(value: unknown): ParameterContract {
  const c = record(value, "parameter contract");
  exact(c, ["version", "parameters", "schema", "parameter_policy", "capability_requirements", "evaluation_paths", "evaluation_inputs", "evaluation_input_origins", "candidate_inputs", "candidate_parameters", "capability_bindings"], "parameter contract");
  if (c.version !== 1) failure("unsupported parameter contract version");
  if (c.candidate_parameters !== undefined && (typeof c.candidate_parameters !== "string" || c.candidate_parameters.startsWith("/") || c.candidate_parameters.split("/").some(p => !p || p === "." || p === "..") || /[\\\0]/.test(c.candidate_parameters))) failure("unsafe candidate_parameters path");
  for (const key of ["evaluation_inputs", "candidate_inputs"]) {
    const inputs = c[key];
    if (inputs !== undefined && (!Array.isArray(inputs) || !inputs.length || inputs.length > 1024 || new Set(inputs).size !== inputs.length
      || inputs.some(p => typeof p !== "string" || !p || p.startsWith("/") || p.split("/").some(part => !part || part === "." || part === "..") || /[\\\0]/.test(p)))) failure(`${key} must be unique safe relative paths`);
  }
  parseCapabilityBindings(c.capability_bindings);
  if (c.evaluation_input_origins !== undefined) {
    const origins = record(c.evaluation_input_origins, "evaluation input origins"), inputs = c.evaluation_inputs as string[] | undefined;
    if (!inputs || Object.keys(origins).length !== inputs.length || Object.keys(origins).some(key => !inputs.includes(key))
      || new Set(Object.values(origins)).size !== inputs.length || Object.values(origins).some(p => typeof p !== "string" || !p || p.startsWith("/")
        || p.split("/").some(part => !part || part === "." || part === "..") || /[\\\0]/.test(p))) failure("evaluation_input_origins must map every input to one unique safe logical path");
  }
  validateSchema(c.schema); record(c.parameters, "parameters"); validateValue(c.parameters, c.schema);
  const policy = record(c.parameter_policy, "parameter_policy"), paths = Object.keys(policy);
  for (const path of paths) {
    pointer(path); at(c.parameters, path); const s = schemaAt(c.schema, path);
    if (paths.some(other => other !== path && other.startsWith(path + "/"))) failure(`overlapping parameter permissions: ${path}`);
    const rule = record(policy[path], `policy ${path}`);
    exact(rule, ["mutable", "actors", "apply_at", "choices", "minimum", "maximum", "nullable"], `policy ${path}`);
    if (typeof rule.mutable !== "boolean") failure(`policy ${path}: mutable is required`);
    if (rule.mutable && (!Array.isArray(rule.actors) || !rule.actors.length || rule.actors.some(a => a !== "meta" && a !== "target") || new Set(rule.actors).size !== rule.actors.length || !["task_start", "training_start"].includes(String(rule.apply_at)))) failure(`policy ${path}: mutable requires actors and apply_at`);
    if (!rule.mutable && (rule.actors !== undefined || rule.apply_at !== undefined)) failure(`policy ${path}: immutable rule cannot grant actors or stages`);
    if (rule.choices !== undefined && (!Array.isArray(rule.choices) || !rule.choices.length)) failure(`policy ${path}: choices must be non-empty`);
    for (const v of (rule.choices ?? []) as JSONValue[]) validateValue(v, s, `policy ${path} choice`);
    if (rule.nullable !== undefined && typeof rule.nullable !== "boolean") failure(`policy ${path}: nullable must be boolean`);
    for (const key of ["minimum", "maximum"]) if (rule[key] !== undefined && (typeof rule[key] !== "number" || !Number.isFinite(rule[key]))) failure(`policy ${path}: invalid ${key}`);
    if (typeof rule.minimum === "number" && typeof rule.maximum === "number" && rule.minimum > rule.maximum) failure(`policy ${path}: reversed range`);
    validateRule(at(c.parameters, path), rule as unknown as ParameterRule, path);
  }
  if (c.evaluation_paths !== undefined && (!Array.isArray(c.evaluation_paths) || new Set(c.evaluation_paths).size !== c.evaluation_paths.length)) failure("evaluation_paths must be unique paths");
  for (const path of (c.evaluation_paths ?? []) as string[]) {
    at(c.parameters, path); schemaAt(c.schema, path);
    if (paths.some(p => (p === path || p.startsWith(path + "/") || path.startsWith(p + "/")) && (policy[p] as ParameterRule).mutable)) failure("evaluation parameters cannot be mutable within one evaluation version");
  }
  if (c.capability_requirements !== undefined && !Array.isArray(c.capability_requirements)) failure("capability_requirements must be an array");
  for (const raw of (c.capability_requirements ?? []) as unknown[]) {
    const req = record(raw, "capability requirement"); exact(req, ["path", "condition", "value", "capability", "coverage"], "capability requirement");
    if (typeof req.path !== "string" || !["non_null", "equals"].includes(String(req.condition)) || typeof req.capability !== "string" || !/^[a-z][a-z0-9_.-]*@[0-9]+$/.test(req.capability) || typeof req.coverage !== "string" || !req.coverage) failure("invalid capability requirement");
    at(c.parameters, req.path);
    if (req.condition === "equals" && !Object.hasOwn(req, "value")) failure("equals requirement needs a value");
  }
  return structuredClone(c) as unknown as ParameterContract;
}
export function validateRule(value: unknown, rule: ParameterRule, path: string): void {
  if (value === null) { if (rule.nullable === false || rule.minimum !== undefined && rule.nullable !== true || rule.maximum !== undefined && rule.nullable !== true) failure(`${path}: null is not allowed`, "parameter_value_rejected"); }
  else if (rule.minimum !== undefined && (typeof value !== "number" || value < rule.minimum) || rule.maximum !== undefined && (typeof value !== "number" || value > rule.maximum)) failure(`${path}: outside allowed range`, "parameter_value_rejected");
  if (rule.choices && !rule.choices.some(v => canonicalJSON(v) === canonicalJSON(value))) failure(`${path}: outside allowed choices`, "parameter_value_rejected");
}
function permitsNull(rule: ParameterRule): boolean {
  return rule.nullable !== false && (rule.minimum === undefined && rule.maximum === undefined || rule.nullable === true)
    && (!rule.choices || rule.choices.some(value => value === null));
}
export function tightenPolicy(contract: ParameterContract, requested: Record<string, ParameterRule>): ParameterContract {
  for (const [path, rule] of Object.entries(requested)) {
    const base = contract.parameter_policy[path];
    if (!base || !base.mutable && rule.mutable || rule.actors?.some(a => !base.actors?.includes(a)) || rule.mutable && rule.apply_at !== base.apply_at
      || base.minimum !== undefined && (rule.minimum === undefined || rule.minimum < base.minimum)
      || base.maximum !== undefined && (rule.maximum === undefined || rule.maximum > base.maximum)
      || base.choices && (!rule.choices || rule.choices.some(v => !base.choices!.some(x => canonicalJSON(x) === canonicalJSON(v))))
      || !permitsNull(base) && permitsNull(rule)) failure(`user policy may only tighten ${path}`, "parameter_permission_rejected");
  }
  return validateParameterContract({ ...contract, parameter_policy: { ...contract.parameter_policy, ...requested } });
}
/** Capability support is deliberately closed: adding a string cannot manufacture trusted execution. */
export function requireCapabilities(contract: ParameterContract, effective: JSONObject, bindings: CapabilityBinding[] = []): void {
  for (const requirement of contract.capability_requirements ?? []) {
    const value = at(effective, requirement.path);
    if (requirement.condition === "non_null" ? value !== null : canonicalJSON(value) === canonicalJSON(requirement.value)) {
      if (bindings.some(binding => binding.capabilities.includes(requirement.capability) && binding.coverage === requirement.coverage)) continue;
      failure(`unsupported_constraint: ${requirement.path} requires ${requirement.capability} (${requirement.coverage}); no verified binding is installed`, "unsupported_constraint");
    }
  }
}
