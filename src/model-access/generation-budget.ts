import { createHash } from "node:crypto";
import { invalidInput } from "../foundation/index.js";

import type { GenerationLimits } from "../domain/index.js";
export type { GenerationLimits } from "../domain/index.js";
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const textTools = (value: unknown): boolean => Array.isArray(value) && value.every(tool => object(tool) && (
  ["function", "custom"].includes(String(tool.type)) ||
  (tool.type === "namespace" && textTools(tool.tools)) ||
  (tool.type === "tool_search" && tool.execution === "client")
));
export function parseGenerationLimits(value: unknown): GenerationLimits {
  if (!object(value) || !Object.keys(value).length || Object.entries(value).some(([key, limit]) =>
    !["model_requests", "tokens"].includes(key) || !count(limit) || limit < 1)) throw invalidInput("invalid generation budget");
  return { ...value } as GenerationLimits;
}

/** Text-only Responses input. Byte-level tokens cannot outnumber their UTF-8 bytes.
 * Reserve framing separately and reject server-side expansion/references/modalities.
 * Opaque reasoning is accepted only from this gateway's own measured responses;
 * its entire original output allowance is reserved again when reused as input.
 */
export function inputTokenCeiling(body: Record<string, unknown>, reasoning: Map<string, number>): number {
  const fields = new Set([
    'model',
    'instructions',
    'input',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'reasoning',
    'text',
    'stream',
    'store',
    'include',
    'prompt_cache_key',
    'max_output_tokens',
    'service_tier',
    'metadata',
    'client_metadata',
    'truncation',
  ])
  const unsupported = Object.keys(body).find(key => !fields.has(key));
  if (unsupported) throw new Error(`generation_budget_input_unsupported:field:${unsupported.slice(0, 80)}`);
  if (Array.isArray(body.tools) && !textTools(body.tools))
    throw new Error(`generation_budget_input_unsupported:tools:${body.tools.map(tool => object(tool) ? String(tool.type).slice(0, 40) : 'invalid').join(',').slice(0, 200)}`);
  if (
    Object.keys(body).some((key) => !fields.has(key)) ||
    !Array.isArray(body.input) ||
    (body.instructions !== undefined && typeof body.instructions !== 'string') ||
    (body.tools !== undefined && !textTools(body.tools))
  )
    throw new Error('generation_budget_input_unsupported:shape')
  let framing = 1024,
    opaque = 0
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!object(value)) return
    framing += 64
    for (const [key, item] of Object.entries(value)) {
      if (key === 'encrypted_content' && item !== null) {
        const tokens = typeof item === 'string' ? reasoning.get(hash(item)) : undefined
        if (tokens === undefined) throw new Error('generation_budget_input_unsupported:unmeasured_reasoning')
        opaque += tokens
      }
      visit(item)
    }
  }
  for (const item of body.input) {
    if (
      !object(item) ||
      ![
        'message',
        'function_call',
        'function_call_output',
        'custom_tool_call',
        'custom_tool_call_output',
        'reasoning',
        'additional_tools',
        'tool_search_call',
        'tool_search_output',
      ].includes(String(item.type ?? 'message'))
    )
      throw new Error(`generation_budget_input_unsupported:input:${object(item) ? String(item.type).slice(0, 80) : 'invalid'}`)
    if ((item.type === 'additional_tools' || item.type === 'tool_search_output') && !textTools(item.tools))
      throw new Error('generation_budget_input_unsupported:additional_tools');
    if (['tool_search_call', 'tool_search_output'].includes(String(item.type)) && item.execution !== 'client')
      throw new Error('generation_budget_input_unsupported:server_tool_search');
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      if (typeof item.output !== 'string' && (!Array.isArray(item.output) || item.output.some(part =>
        !object(part) || part.type !== 'input_text' || typeof part.text !== 'string')))
        throw new Error('generation_budget_input_unsupported:tool_output')
    }
    if ((item.type ?? 'message') === 'message' && typeof item.content !== 'string') {
      if (
        !Array.isArray(item.content) ||
        item.content.some(
          (part) =>
            !object(part) ||
            !['input_text', 'output_text'].includes(String(part.type)) ||
            typeof part.text !== 'string',
        )
      )
        throw new Error('generation_budget_input_unsupported:message_content')
    }
  }
  visit(body)
  const total = Buffer.byteLength(JSON.stringify(body)) + framing + opaque
  if (!count(total)) throw new Error('generation_budget_input_unsupported')
  return total
}

/** One run's immutable allowance. Missing usage fences all subsequent dispatch. */
export class GenerationBudgetMeter {
  private readonly reasoning = new Map<string, number>();
  private requests = 0;
  private input = 0;
  private output = 0;
  private cached = 0;
  private cacheKnown = true;
  private unknown = false;
  private active: { ceiling: number; outputLimit?: number } | undefined;
  private failure: string | undefined;
  readonly attempts: Array<Record<string, number | string | null>> = [];
  constructor(readonly limits: GenerationLimits) { if (Object.keys(limits).length) parseGenerationLimits(limits); }

  reserve(value: unknown): Record<string, unknown> {
    if (this.unknown || this.active || this.failure) throw invalidInput(this.failure ?? "generation_budget_unavailable");
    if (!object(value) || value.stream !== true || value.store !== false) throw invalidInput("generation_budget_input_unsupported:stream/store");
    const body: Record<string, unknown> = { ...value };
    const ceiling = inputTokenCeiling(body, this.reasoning);
    const remaining = this.limits.tokens === undefined ? undefined : this.limits.tokens - this.input - this.output;
    if ((this.limits.model_requests !== undefined && this.requests >= this.limits.model_requests) ||
        (remaining !== undefined && remaining <= ceiling)) {
      this.failure = "generation_budget_exhausted";
      throw invalidInput(this.failure);
    }
    if (body.max_output_tokens !== undefined && (!count(body.max_output_tokens) || body.max_output_tokens < 1)) throw invalidInput("generation_budget_input_unsupported");
    let outputLimit = body.max_output_tokens as number | undefined;
    if (remaining !== undefined) {
      outputLimit = Math.min(remaining - ceiling, outputLimit ?? Infinity);
      body.max_output_tokens = outputLimit;
    }
    this.requests++;
    this.active = { ceiling, ...(outputLimit === undefined ? {} : { outputLimit }) };
    this.attempts.push({ request: this.requests, input_upper_bound: ceiling, max_output_tokens: outputLimit ?? null,
      input_tokens: null, output_tokens: null, status: "unknown" });
    return body;
  }

  settle(payload: unknown): void {
    if (!this.active) throw invalidInput("generation budget has no active request");
    let response: Record<string, unknown> | undefined;
    if (object(payload) && typeof payload.body === "string" && payload.truncated === false) {
      for (const line of payload.body.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        let event: unknown;
        try { event = JSON.parse(line.slice(5)); } catch { continue; }
        if (object(event) && ["response.completed", "response.incomplete", "response.failed"].includes(String(event.type))) {
          if (response || !object(event.response)) { this.fail(); return; }
          response = event.response;
        }
      }
    }
    const usage = response?.usage;
    if (!object(usage) || !count(usage.input_tokens) || !count(usage.output_tokens) || !count(usage.total_tokens) ||
        usage.total_tokens !== usage.input_tokens + usage.output_tokens) { this.fail(); return; }
    const cache = object(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : undefined;
    if (cache !== undefined && (!count(cache) || cache > usage.input_tokens)) { this.fail(); return; }
    this.input += usage.input_tokens; this.output += usage.output_tokens;
    if (count(cache)) this.cached += cache; else this.cacheKnown = false;
    if (!count(this.input + this.output)) { this.fail(); return; }
    Object.assign(this.attempts.at(-1)!, { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, status: String(response!.status ?? "complete") });
    if (usage.input_tokens > this.active.ceiling || (this.active.outputLimit !== undefined && usage.output_tokens > this.active.outputLimit))
      this.failure = "generation_budget_violation";
    if (Array.isArray(response!.output)) for (const item of response!.output) {
      if (object(item) && item.type === "reasoning" && typeof item.encrypted_content === "string")
        this.reasoning.set(hash(item.encrypted_content), usage.output_tokens);
    }
    this.active = undefined;
  }

  fail(): void { this.unknown = true; this.active = undefined; this.failure ??= "generation_usage_unknown"; }
  error(): string | undefined { return this.failure; }
  usage(): Record<string, number | null> {
    const known = !this.unknown && !this.active;
    return { model_requests: this.requests, input_tokens: known ? this.input : null, output_tokens: known ? this.output : null,
      cached_input_tokens: known && this.cacheKnown ? this.cached : null, tokens: known ? this.input + this.output : null };
  }
  audit() { return { schema_version: "1", limits: this.limits, attempts: this.attempts, failure: this.failure ?? null }; }
}
