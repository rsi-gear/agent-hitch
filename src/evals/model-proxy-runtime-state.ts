import path from "node:path";
import type { ModelCapturePlanV1 } from "../domain/index.js";
import { atomicWriteJSON, readJSON } from "../foundation/index.js";
import type { HostModelProxyRuntimeIdentity } from "../model-access/index.js";

export interface PersistedModelProxyRuntimeV1 {
  schema_version: "1";
  eval_id: string;
  mode: "proxy" | "hybrid";
  required: boolean;
  topology: "host-side" | "in-sandbox";
  listen_port: number;
  capability_token: string;
  created_at: string;
  updated_at: string;
}

export async function readModelProxyRuntimeState(
  evalDirectory: string,
  evalId: string,
  plan: ModelCapturePlanV1,
): Promise<PersistedModelProxyRuntimeV1 | null> {
  const value = await readJSON<unknown | null>(runtimeStatePath(evalDirectory), null);
  if (value === null) return null;
  const state = parseModelProxyRuntimeState(value);
  if (state.eval_id !== evalId || state.mode !== plan.effective_mode || state.required !== plan.required
    || state.topology !== (plan.topology ?? "host-side")) {
    throw new TypeError("persisted model proxy runtime does not match the eval capture plan");
  }
  return state;
}

export async function writeModelProxyRuntimeState(input: {
  evalDirectory: string;
  evalId: string;
  plan: ModelCapturePlanV1;
  identity: HostModelProxyRuntimeIdentity;
  previous?: PersistedModelProxyRuntimeV1 | null;
}): Promise<PersistedModelProxyRuntimeV1> {
  if (input.plan.effective_mode !== "proxy" && input.plan.effective_mode !== "hybrid") {
    throw new TypeError("model proxy runtime requires an effective proxy capture plan");
  }
  const now = new Date().toISOString();
  const state: PersistedModelProxyRuntimeV1 = {
    schema_version: "1",
    eval_id: input.evalId,
    mode: input.plan.effective_mode,
    required: input.plan.required,
    topology: input.plan.topology ?? "host-side",
    listen_port: input.identity.listenPort,
    capability_token: input.identity.capabilityToken,
    created_at: input.previous?.created_at ?? now,
    updated_at: now,
  };
  await atomicWriteJSON(runtimeStatePath(input.evalDirectory), state);
  return state;
}

export function parseModelProxyRuntimeState(value: unknown): PersistedModelProxyRuntimeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("model proxy runtime state must be an object");
  const state = value as Record<string, unknown>;
  const allowed = new Set(["schema_version", "eval_id", "mode", "required", "topology", "listen_port", "capability_token", "created_at", "updated_at"]);
  if (Object.keys(state).some((key) => !allowed.has(key)) || state.schema_version !== "1"
    || typeof state.eval_id !== "string" || !/^eval_[a-f0-9]{32}$/.test(state.eval_id)
    || state.mode !== "proxy" && state.mode !== "hybrid" || typeof state.required !== "boolean"
    || state.topology !== undefined && state.topology !== "host-side" && state.topology !== "in-sandbox"
    || !Number.isSafeInteger(state.listen_port) || (state.listen_port as number) < 1 || (state.listen_port as number) > 65_535
    || typeof state.capability_token !== "string" || !/^[a-f0-9]{48}$/.test(state.capability_token)
    || typeof state.created_at !== "string" || !Number.isFinite(Date.parse(state.created_at))
    || typeof state.updated_at !== "string" || !Number.isFinite(Date.parse(state.updated_at))) {
    throw new TypeError("model proxy runtime state is invalid");
  }
  return { ...state, topology: state.topology ?? "host-side" } as unknown as PersistedModelProxyRuntimeV1;
}

function runtimeStatePath(evalDirectory: string): string {
  return path.join(evalDirectory, "model-capture", "proxy.runtime.json");
}
