import type { ModelEndpointBindingV1, RunId, Sha256 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";

const LOCAL_MODEL_ENVIRONMENT_NAMES = new Set([
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_VERSION",
  "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "HITCH_LOCAL_MAX_OUTPUT_TOKENS", "HITCH_LOCAL_MODEL_BASE_URL", "HITCH_LOCAL_MODEL_TOKEN",
  "HUGGING_FACE_HUB_TOKEN", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_ORGANIZATION",
]);

const LOCAL_MODEL_ENVIRONMENT_PREFIXES = [
  "ANTHROPIC_", "AZURE_OPENAI_", "CLAUDE_", "CODEX_", "COHERE_", "DEEPSEEK_", "FIREWORKS_",
  "GEMINI_", "GOOGLE_GENERATIVE_AI_", "GROQ_", "HF_", "HUGGING_FACE_", "MISTRAL_", "OPENAI_",
  "SGLANG_", "TOGETHER_", "TORCH_", "TRANSFORMERS_", "XAI_",
] as const;

/**
 * Build the inherited portion of a managed-local harness environment. Adapter
 * values are intentionally merged afterwards so only a Hitch-issued endpoint
 * credential can re-enter the child environment.
 */
export function scrubLocalInferenceEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = { ...env };
  for (const name of Object.keys(scrubbed)) {
    if (LOCAL_MODEL_ENVIRONMENT_NAMES.has(name)
      || LOCAL_MODEL_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      delete scrubbed[name];
    }
  }
  return scrubbed;
}

/**
 * Harbor exposes one run-bound capture route inside the trial container. It is
 * not a cloud credential: the fixed key is a sentinel and the capability is in
 * the exact proxy path. Reject any less constrained inherited endpoint.
 */
export function managedHarborModelRuntime(
  env: NodeJS.ProcessEnv,
  runId: RunId,
  identity: { inference_id: Sha256; model_id: Sha256 },
): { model_endpoint: ModelEndpointBindingV1; model_endpoint_credential: string } {
  const base = env.OPENAI_BASE_URL;
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
      kind: "managed-local",
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
