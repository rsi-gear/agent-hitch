#!/usr/bin/env node
// Trusted no-tools harness. One Responses request, native text/image inputs,
// no tool executor, retries, subprocesses, browser, or continuation loop.
import { randomUUID } from 'node:crypto';

if (process.argv.includes('--version')) {
  console.log('hitch-model-call 1.0.0');
  process.exit(0);
}
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--model' || !args[1]) throw new Error('Usage: model-call --model MODEL');
const model = args[1];
const key = process.env.HITCH_LOCAL_MODEL_TOKEN || process.env.OPENAI_API_KEY;
if (!key) throw new Error('a model API credential is required for the model-call harness');
const base = new URL(process.env.HITCH_LOCAL_MODEL_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/');
const loopback = base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
const managedRunId = process.env.HITCH_MANAGED_RUN_ID || '';
const managed = process.env.HITCH_MANAGED_LOCAL_INFERENCE === '1'
  && key === 'hitch-managed-local'
  && /^run_[a-f0-9]{32}$/.test(managedRunId)
  && base.protocol === 'http:'
  && new RegExp(`^/[a-f0-9]{48}/${managedRunId}/openai/?$`).test(base.pathname);
if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !loopback && !managed)) throw new Error('invalid model endpoint');
if (!base.pathname.endsWith('/')) base.pathname += '/';
let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 30 * 1024 * 1024) throw new Error('model input exceeds 30 MB');
}
const input = JSON.parse(raw);
const allowed = new Set(['schema_version', 'messages', 'max_output_tokens', 'reasoning_effort']);
if (input.schema_version !== '1' || Object.keys(input).some(k => !allowed.has(k)) || !Array.isArray(input.messages) || !input.messages.length) throw new Error('invalid model input');
for (const message of input.messages) {
  if (!['system', 'user'].includes(message.role) || Object.keys(message).some(k => !['role', 'content'].includes(k)) || !Array.isArray(message.content) || !message.content.length) throw new Error('invalid model message');
  for (const part of message.content) {
    if (part.type === 'input_text') {
      if (typeof part.text !== 'string' || Object.keys(part).some(k => !['type', 'text'].includes(k))) throw new Error('invalid text part');
    } else if (part.type === 'input_image') {
      if (typeof part.image_url !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(part.image_url) || Object.keys(part).some(k => !['type', 'image_url'].includes(k))) throw new Error('images must be native, embedded PNG/JPEG/WebP');
    } else throw new Error('unsupported input modality');
  }
}
const localDefault = process.env.HITCH_LOCAL_MAX_OUTPUT_TOKENS === undefined ? 8192 : Number(process.env.HITCH_LOCAL_MAX_OUTPUT_TOKENS);
const maxTokens = input.max_output_tokens ?? localDefault;
if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 131072) throw new Error('invalid max_output_tokens');
if (input.reasoning_effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(input.reasoning_effort)) throw new Error('invalid reasoning effort');
const emit = event => console.log(JSON.stringify(event));
emit({ type: 'session.created', session_id: randomUUID() });
const response = await fetch(new URL('responses', base), {
  redirect: 'error',
  method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, input: input.messages, tools: [], tool_choice: 'none', store: false,
    max_output_tokens: maxTokens, ...(input.reasoning_effort ? { reasoning: { effort: input.reasoning_effort } } : {}) }),
  signal: AbortSignal.timeout(3600000),
});
if (!response.ok) throw new Error(`model API returned HTTP ${response.status}`);
const body = await response.json();
if (!['completed', 'incomplete'].includes(body.status) || !Array.isArray(body.output)) throw new Error('invalid model completion');
if (body.output.some(item => !['message', 'reasoning'].includes(item.type))) throw new Error('model returned a prohibited tool/action item');
const output = body.output.filter(item => item.type === 'message').flatMap(item => item.content || []).map(part => part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : '').join('\n');
// An empty answer (including token exhaustion) remains a gradable model
// outcome. Provider/transport failures above remain infrastructure errors.
emit({ type: 'provider.response', response: body });
emit({ type: 'usage.updated', usage: body.usage || {} });
emit({ type: 'message.completed', text: output });
