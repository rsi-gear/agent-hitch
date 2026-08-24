import { stat } from "node:fs/promises";
import { getAdapter, normalizeRequest } from "../adapters/index.js";
import type { AdapterRequest } from "../adapters/index.js";
import { SCHEMA_VERSION, invalidInput } from "../foundation/index.js";
import { parseHarnessReference } from "../revisions/index.js";
import { WORKSPACE_MODES } from "../workspaces/index.js";
import type { EvalRunParentV1, ModelIdentityV1, ProtocolIdentityV1, RunContextV1, Sha256 } from "../domain/index.js";
import { asBoolean, asOptionalString, asRecord, asSha256, asString, validateEvalRunParent, validateRunContext } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";
import { defaultModelIdentity } from "./identity.js";

export interface RunRequestInput {
  schema_version?: unknown;
  harness_ref?: unknown;
  agent?: unknown;
  model?: unknown;
  cwd?: unknown;
  workspace_mode?: unknown;
  prompt?: unknown;
  timeout_ms?: unknown;
  agent_args?: unknown;
  context?: unknown;
  parent?: unknown;
  model_identity?: unknown;
  protocol_identity?: unknown;
  /** Internal eval handoff: the host verifier will seal the observation. */
  defer_benchmark_observation?: unknown;
}

export interface ValidatedRunRequest extends AdapterRequest {
  context: RunContextV1;
  parent?: EvalRunParentV1;
  model_identity: ModelIdentityV1;
  protocol_identity: Pick<ProtocolIdentityV1, "environment_identity" | "tool_policy_sha256">;
  defer_benchmark_observation: boolean;
}

export async function validateRunRequest(input: RunRequestInput): Promise<ValidatedRunRequest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidInput("run request must be a JSON object");
  }
  const allowedFields = new Set([
    "schema_version", "harness_ref", "agent", "model", "cwd", "workspace_mode", "prompt", "timeout_ms", "agent_args",
    "context", "parent", "model_identity", "protocol_identity", "defer_benchmark_observation",
  ]);
  const unexpectedField = Object.keys(input).find((field) => !allowedFields.has(field));
  if (unexpectedField) throw invalidInput(`unknown run request field: ${unexpectedField}`);
  if (input.schema_version !== undefined && input.schema_version !== SCHEMA_VERSION) {
    throw invalidInput(`unsupported schema_version: ${input.schema_version}`);
  }
  if (input.harness_ref !== undefined && input.agent !== undefined) {
    throw invalidInput("use only one of harness_ref and the legacy agent field");
  }
  if (typeof input.agent === "string" && input.agent.includes("@")) {
    throw invalidInput("the legacy agent field accepts only a harness name; use harness_ref for revision selection");
  }
  const referenceValue = input.harness_ref ?? input.agent;
  if (typeof referenceValue !== "string" || !referenceValue.trim()) {
    throw invalidInput("harness_ref must be a non-empty string");
  }
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw invalidInput("prompt must be a non-empty string");
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || !input.cwd.trim())) {
    throw invalidInput("cwd must be a non-empty string");
  }
  if (input.workspace_mode !== undefined && !WORKSPACE_MODES.has(input.workspace_mode as string)) {
    throw invalidInput(`workspace_mode must be one of: ${[...WORKSPACE_MODES].join(", ")}`);
  }
  if (input.model !== undefined && typeof input.model !== "string") throw invalidInput("model must be a string");
  if (input.timeout_ms !== undefined && (typeof input.timeout_ms !== "number" || !Number.isFinite(input.timeout_ms) || input.timeout_ms < 0)) {
    throw invalidInput("timeout_ms must be a non-negative number");
  }
  if (input.agent_args !== undefined && (!Array.isArray(input.agent_args) || input.agent_args.some((arg) => typeof arg !== "string"))) {
    throw invalidInput("agent_args must be an array of strings");
  }
  const request = normalizeRequest(input as Record<string, unknown>);
  const reference = parseHarnessReference(request.harness_ref);
  getAdapter(reference.harness_id);
  let workspace: Awaited<ReturnType<typeof stat>>;
  try {
    workspace = await stat(request.cwd);
  } catch (error) {
    throw invalidInput(`workspace does not exist: ${request.cwd}`, { cause: error });
  }
  if (!workspace.isDirectory()) throw invalidInput(`workspace is not a directory: ${request.cwd}`);
  let parent: EvalRunParentV1 | undefined;
  try {
    if (input.parent !== undefined) parent = validateEvalRunParent(input.parent);
  } catch (error) {
    throw invalidInput((error as Error).message, { cause: error });
  }
  let context: RunContextV1;
  try {
    context = validateRunContext(input.context ?? { kind: "ad_hoc" });
  } catch (error) {
    throw invalidInput((error as Error).message, { cause: error });
  }
  if (parent && context.kind !== "benchmark_task") throw invalidInput("eval parent requires a benchmark_task context");
  let deferObservation = false;
  try {
    if (input.defer_benchmark_observation !== undefined) {
      deferObservation = asBoolean(input.defer_benchmark_observation, "defer_benchmark_observation");
    }
  } catch (error) {
    throw invalidInput((error as Error).message, { cause: error });
  }
  if (deferObservation && (!parent || context.kind !== "benchmark_task")) {
    throw invalidInput("defer_benchmark_observation is only valid for eval benchmark runs");
  }
  let modelIdentity: ModelIdentityV1;
  let protocolIdentity: Pick<ProtocolIdentityV1, "environment_identity" | "tool_policy_sha256"> = {};
  try {
    modelIdentity = validateModelIdentity(input.model_identity, request.model, reference.harness_id, request.agent_args);
    protocolIdentity = validateProtocolIdentityInput(input.protocol_identity);
  } catch (error) {
    throw invalidInput((error as Error).message, { cause: error });
  }
  return {
    ...request,
    context,
    ...(parent ? { parent } : {}),
    model_identity: modelIdentity,
    protocol_identity: protocolIdentity,
    defer_benchmark_observation: deferObservation,
  };
}

function validateModelIdentity(value: unknown, requestedId: string, harnessId: string, agentArgs: string[]): ModelIdentityV1 {
  const derivedParameters = modelParameterDigest(agentArgs);
  if (value === undefined) return defaultModelIdentity(requestedId, harnessId, {
    ...(derivedParameters ? { parametersSha256: derivedParameters } : {}),
  });
  const record = asRecord(value, "model_identity");
  const allowed = new Set(["provider", "requested_id", "effective_id", "parameters_sha256", "identity_resolved"]);
  const unexpected = Object.keys(record).find((field) => !allowed.has(field));
  if (unexpected) throw new TypeError(`model_identity has unknown field: ${unexpected}`);
  const declaredRequested = asString(record.requested_id ?? requestedId, "model_identity.requested_id");
  if (declaredRequested !== requestedId) throw new TypeError("model_identity.requested_id must match model");
  const effective = asString(record.effective_id ?? requestedId, "model_identity.effective_id");
  const resolved = record.identity_resolved === undefined ? undefined : asBoolean(record.identity_resolved, "model_identity.identity_resolved");
  const provider = asOptionalString(record.provider, "model_identity.provider");
  const parameters = record.parameters_sha256 === undefined
    ? derivedParameters
    : asSha256(record.parameters_sha256, "model_identity.parameters_sha256");
  return defaultModelIdentity(requestedId, harnessId, {
    ...(provider ? { provider } : {}),
    effectiveId: effective,
    ...(parameters ? { parametersSha256: parameters } : {}),
    ...(resolved !== undefined ? { resolved } : {}),
  });
}

function modelParameterDigest(agentArgs: string[]): Sha256 | undefined {
  const safeFlags = new Set([
    "--temperature", "--top-p", "--max-tokens", "--max-output-tokens", "--reasoning-effort",
  ]);
  const parameters: Record<string, string> = {};
  for (let index = 0; index < agentArgs.length; index += 1) {
    const argument = agentArgs[index] as string;
    const [flag, inline] = argument.split("=", 2);
    if (!flag || !safeFlags.has(flag)) continue;
    const value = inline ?? agentArgs[index + 1];
    if (value === undefined || (!inline && value.startsWith("--"))) continue;
    parameters[flag] = value;
    if (inline === undefined) index += 1;
  }
  return Object.keys(parameters).length ? sha256JSON(parameters) : undefined;
}

function validateProtocolIdentityInput(value: unknown): Pick<ProtocolIdentityV1, "environment_identity" | "tool_policy_sha256"> {
  if (value === undefined) return {};
  const record = asRecord(value, "protocol_identity");
  const allowed = new Set(["environment_identity", "tool_policy_sha256"]);
  const unexpected = Object.keys(record).find((field) => !allowed.has(field));
  if (unexpected) throw new TypeError(`protocol_identity has unknown field: ${unexpected}`);
  const result: Pick<ProtocolIdentityV1, "environment_identity" | "tool_policy_sha256"> = {};
  if (record.environment_identity !== undefined) result.environment_identity = asSha256(record.environment_identity, "environment_identity");
  if (record.tool_policy_sha256 !== undefined) result.tool_policy_sha256 = asSha256(record.tool_policy_sha256, "tool_policy_sha256");
  return result;
}
