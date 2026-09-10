import type { ModelEndpointBindingV1, RunId, Sha256, ModelNodeBindingV2 } from "../domain/index.js";
import { HitchError, sha256JSON } from "../foundation/index.js";
import { parseModelNodeBinding } from "../domain/index.js";
import { scrubLocalInferenceEnvironment } from "../model-access/index.js";

/**
 * Harbor exposes one run-bound capture route inside the trial container. It is
 * not a cloud credential: the fixed key is a sentinel and the capability is in
 * the exact proxy path. Reject any less constrained inherited endpoint.
 */
export function managedHarborModelRuntime(
  env: NodeJS.ProcessEnv,
  runId: RunId,
  identity: { inference_id: Sha256; model_id: Sha256; model_node?: ModelNodeBindingV2 },
): { model_endpoint: ModelEndpointBindingV1; model_endpoint_credential: string } {
  const base = env.OPENAI_BASE_URL;
  const modelNode = env.HITCH_MANAGED_NODE_BINDING ? parseModelNodeBinding(JSON.parse(env.HITCH_MANAGED_NODE_BINDING)) : undefined;
  if (sha256JSON(modelNode ?? null) !== sha256JSON(identity.model_node ?? null)) throw invalidHandoff();
  if (env.HITCH_HARBOR_INTERNAL !== "1" || env.HITCH_MANAGED_LOCAL_INFERENCE !== "1"
    || env.HITCH_MANAGED_RUN_ID !== runId || env.HITCH_MANAGED_INFERENCE_ID !== identity.inference_id
    || env.HITCH_MANAGED_MODEL_ID !== identity.model_id || env.OPENAI_API_KEY !== "hitch-managed-local"
    || !base || base.length > 2_048 || /[\0\r\n]/.test(base)) {
    throw invalidHandoff();
  }
  let parsed: URL;
  try { parsed = new URL(base); } catch { throw invalidHandoff(); }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || !new RegExp(`^/[a-f0-9]{48}/${runId}/openai/?$`).test(parsed.pathname)) {
    throw invalidHandoff();
  }
  return {
    model_endpoint: {
      kind: modelNode ? "managed-node" : "managed-local",
      ...(modelNode ? { model_node: modelNode } : {}),
      inference_id: identity.inference_id,
      api: "responses",
      base_url: base,
      wire_model: "hitch-wire-model",
      credential_env_name: "HITCH_LOCAL_MODEL_TOKEN",
      capabilities: { streaming: true, tool_calls: true, parallel_tool_calls: false, input_modalities: ["text"] },
    },
    model_endpoint_credential: "hitch-managed-local",
  };
}

export function harnessChildEnvironment(input: {
  parent: NodeJS.ProcessEnv;
  adapter?: Record<string, string>;
  cwd: string;
  managedLocal: boolean;
}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...(input.managedLocal ? scrubLocalInferenceEnvironment(input.parent) : input.parent),
    ...input.adapter,
    PWD: input.cwd,
  };
  delete result.OLDPWD;
  return result;
}

function invalidHandoff(): HitchError {
  return new HitchError("managed local inference proxy environment is invalid", {
    code: "local_inference_topology_unsupported", exitCode: 12,
  });
}
