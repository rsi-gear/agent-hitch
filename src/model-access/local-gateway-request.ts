import type { InferenceLockV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";

const RESPONSE_FIELDS = new Set([
  "background", "include", "input", "instructions", "max_output_tokens", "max_tool_calls", "metadata", "model",
  "parallel_tool_calls", "previous_response_id", "reasoning", "service_tier", "store", "stream", "temperature",
  "tool_choice", "tools", "top_logprobs", "top_p", "truncation", "user", "request_id", "session_id", "priority",
  "extra_key", "cache_salt", "frequency_penalty", "presence_penalty", "stop", "top_k", "min_p",
  "repetition_penalty", "prompt_cache_key", "client_metadata",
]);
const LOCAL_TOOL_TYPES = new Set(["function", "namespace", "tool_search", "custom"]);
const CHAT_FIELDS = new Set(["model", "messages", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p", "top_k", "min_p",
  "repetition_penalty", "max_tokens", "max_completion_tokens", "stream", "stream_options", "stop", "n", "seed", "user", "metadata", "store",
  "frequency_penalty", "presence_penalty", "logprobs", "top_logprobs", "response_format", "cache_salt", "prompt_cache_key"]);

export function validateRequestBody(buffer: Buffer, lock: InferenceLockV1, wireModel: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(buffer.toString("utf8")); } catch { throw requestError("model request must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw requestError("model request must be an object");
  const body = value as Record<string, unknown>;
  const chat = lock.protocol.api === "chat-completions";
  const unknown = Object.keys(body).find((field) => !(chat ? CHAT_FIELDS : RESPONSE_FIELDS).has(field));
  if (unknown) throw requestError(`unsupported local inference request field: ${unknown}`);
  if (body.model !== wireModel) throw requestError("model request does not match the bound local model");
  if (containsUnsupportedMedia(body)) throw new HitchError("local inference P0 accepts text input only", { code: "inference_modality_unsupported", exitCode: 2 });
  if (chat) {
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.some(message => !message || typeof message !== "object"
      || Array.isArray(message) || !["system", "developer", "user", "assistant", "tool"].includes(String(message.role)))) throw requestError("chat requires complete message history");
    if (body.n !== undefined && body.n !== 1) throw requestError("chat requires one completion per request");
    if (body.seed !== undefined && body.seed !== lock.generation.seed) throw requestError("seed conflicts with the inference lock");
    if (body.stream !== undefined && typeof body.stream !== "boolean") throw requestError("stream must be a boolean");
    if (body.stream_options !== undefined && (!body.stream_options || typeof body.stream_options !== "object" || Array.isArray(body.stream_options)
      || Object.keys(body.stream_options).some(key => key !== "include_usage")
      || typeof (body.stream_options as Record<string, unknown>).include_usage !== "boolean")) throw requestError("invalid chat stream_options");
    body.n = 1; body.seed = lock.generation.seed;
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw requestError("tools must be an array");
  const tools = (body.tools ?? []) as unknown[];
  if (!lock.protocol.tool_calls && tools.length > 0) throw requestError("tools are unavailable for this local inference profile");
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)
      || !(chat ? (tool as Record<string, unknown>).type === "function" : LOCAL_TOOL_TYPES.has(String((tool as Record<string, unknown>).type)))) {
      throw requestError("local inference accepts only Harness-executed function tools");
    }
  }
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== lock.protocol.parallel_tool_calls) {
    throw requestError("parallel_tool_calls conflicts with the inference lock");
  }
  body.parallel_tool_calls = lock.protocol.parallel_tool_calls;
  if (body.store !== undefined && body.store !== false) throw requestError("local inference requires store=false");
  if (body.truncation !== undefined && body.truncation !== "disabled") throw requestError("local inference does not allow automatic truncation");
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) throw requestError("local inference requires complete request history");
  if (body.background === true) throw requestError("background responses are unavailable for local inference");
  if (body.reasoning !== undefined && body.reasoning !== null) {
    if (!body.reasoning || typeof body.reasoning !== "object" || Array.isArray(body.reasoning)) throw requestError("reasoning must be an object");
    const reasoning = body.reasoning as Record<string, unknown>;
    if (reasoning.effort !== undefined && lock.protocol.reasoning_parser === null) {
      throw requestError("reasoning effort requires a certified reasoning parser");
    }
  }
  const expected: Record<string, number> = {
    temperature: lock.generation.temperature,
    top_p: lock.generation.top_p,
    top_k: lock.generation.top_k,
    min_p: lock.generation.min_p,
    repetition_penalty: lock.generation.repetition_penalty,
  };
  for (const [name, configured] of Object.entries(expected)) {
    if (body[name] !== undefined && body[name] !== configured) throw requestError(`${name} conflicts with the inference lock`);
    body[name] = name === "top_k" && configured === 0 ? -1 : configured;
  }
  if (chat && body.max_tokens !== undefined && body.max_completion_tokens !== undefined) throw requestError("chat token limit must be specified once");
  const maxOutput = (chat ? body.max_tokens ?? body.max_completion_tokens : body.max_output_tokens) ?? lock.generation.max_output_tokens;
  if (!Number.isSafeInteger(maxOutput) || (maxOutput as number) < 1 || (maxOutput as number) > lock.generation.max_output_tokens) {
    throw requestError("max_output_tokens exceeds the inference lock");
  }
  // The pinned SGLang Responses implementation subtracts two reserved tokens.
  // Keep the lock/client budget in generated tokens, including budgets of one.
  if (chat) { body.max_tokens = maxOutput; delete body.max_completion_tokens; }
  else { body.max_output_tokens = (maxOutput as number) + 2; body.truncation = "disabled"; }
  body.store = false;
  if (body.prompt_cache_key !== undefined) {
    if (typeof body.prompt_cache_key !== "string" || body.prompt_cache_key.length > 256) throw requestError("prompt_cache_key is invalid");
    if (lock.execution.prefix_cache.mode === "radix" && body.cache_salt === undefined) body.cache_salt = body.prompt_cache_key;
    delete body.prompt_cache_key;
  }
  if (body.client_metadata !== undefined) {
    if (!body.client_metadata || typeof body.client_metadata !== "object" || Array.isArray(body.client_metadata)) throw requestError("client_metadata is invalid");
    if (body.metadata === undefined) body.metadata = body.client_metadata;
    delete body.client_metadata;
  }
  return body;
}

function containsUnsupportedMedia(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUnsupportedMedia);
  if (!value || typeof value !== "object") return false;
  for (const [name, nested] of Object.entries(value as Record<string, unknown>)) {
    if (name === "image_url" || name === "input_image" || name === "audio_url" || name === "input_audio") return true;
    if (containsUnsupportedMedia(nested)) return true;
  }
  return false;
}

function requestError(message: string): HitchError { return new HitchError(message, { code: "inference_parameter_conflict", exitCode: 2 }); }
