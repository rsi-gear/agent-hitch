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
