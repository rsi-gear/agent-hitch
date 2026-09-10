#!/usr/bin/env node
// Fixed linear tool loop, restricted to a managed Harbor task container.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

if (process.argv.includes('--version')) { console.log('hitch-training-tool 1.0.0'); process.exit(0); }
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--model' || !args[1]) throw new Error('Usage: training-tool --model MODEL');
if (process.env.HITCH_HARBOR_INTERNAL !== '1') throw new Error('training-tool requires a Harbor task container');
const binding = JSON.parse(process.env.HITCH_TRAINING_BINDING || 'null');
const training = process.env.HITCH_TRAINING_EXTERNAL === '1';
if (!training && process.env.HITCH_MANAGED_LOCAL_INFERENCE !== '1') throw new Error('explicit Hitch model binding required');
const runId = training ? process.env.HITCH_TRAINING_RUN_ID : process.env.HITCH_MANAGED_RUN_ID;
const base = new URL(process.env.OPENAI_BASE_URL || '');
if (!/^run_[a-f0-9]{32}$/.test(runId || '') || base.protocol !== 'http:' || base.username || base.password || base.search || base.hash
  || !new RegExp(`^/[a-f0-9]{48}/${runId}/openai/?$`).test(base.pathname)) throw new Error('invalid run-scoped endpoint');
if (training && args[1] !== `training/${binding?.binding_id}`) throw new Error('wrong training binding');
if (!base.pathname.endsWith('/')) base.pathname += '/';
const maxTokens = training ? binding.max_output_tokens : Number(process.env.HITCH_LOCAL_MAX_OUTPUT_TOKENS || 2048);
const maxSteps = training ? binding.max_episode_steps : Number(process.env.HITCH_TRAINING_EVAL_MAX_STEPS || 16);
if (![maxTokens, maxSteps].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('invalid harness budget');
let prompt = '';
for await (const chunk of process.stdin) { prompt += chunk; if (Buffer.byteLength(prompt) > 8 * 1024 * 1024) throw new Error('prompt exceeds 8 MiB'); }
const messages = [{ role: 'user', content: prompt }];
const tools = [{ type: 'function', function: { name: 'bash', description: 'Run a command in the task container.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } } }];
const emit = event => console.log(JSON.stringify(event));
let child;
const abort = new AbortController();
const killTool = () => { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
const cancel = () => { abort.abort(); killTool(); };
process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
emit({ type: 'session.created', session_id: randomUUID(), policy_version: binding?.policy_version });
for (let step = 0; step < maxSteps; step++) {
  const response = await fetch(new URL('chat/completions', base), {
    method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${runId}-${step}` },
    body: JSON.stringify({ model: args[1], messages, tools, stream: false, max_tokens: maxTokens }), signal: abort.signal,
  });
  if (!response.ok) throw new Error(`training gateway returned HTTP ${response.status}`);
  const body = await response.json(); const choice = body.choices?.[0];
  if (!choice?.message || body.choices.length !== 1) throw new Error('invalid completion');
  emit({ type: 'provider.response', response: body, receipt_id: response.headers.get('x-gear-receipt-id') });
  emit({ type: 'usage.updated', usage: body.usage || {} });
  if (choice.finish_reason === 'length') { emit({ type: 'training.terminated', termination: 'truncated' }); process.exitCode = 8; break; }
  const message = choice.message; messages.push(message);
  const calls = message.tool_calls || [];
  if (!calls.length) {
    if (choice.finish_reason !== 'stop') throw new Error('missing terminal state');
    emit({ type: 'message.completed', text: message.content || '' }); emit({ type: 'training.terminated', termination: 'terminated' }); break;
  }
  if (choice.finish_reason !== 'tool_calls') throw new Error('missing tool terminal state');
  for (const call of calls) {
    if (call.function?.name !== 'bash' || typeof call.id !== 'string') throw new Error('unsupported tool');
    const input = JSON.parse(call.function.arguments);
    if (typeof input.command !== 'string' || Object.keys(input).join(',') !== 'command') throw new Error('invalid bash arguments');
    emit({ type: 'tool.started', call_id: call.id, name: 'bash', arguments: input });
    const result = await new Promise((resolve, reject) => {
      let output = ''; let truncated = false;
      child = spawn('/bin/bash', ['-lc', input.command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const append = data => { const remaining = 32768 - output.length; if (remaining > 0) output += data.toString().slice(0, remaining); if (data.length > remaining) truncated = true; };
      child.stdout.on('data', append); child.stderr.on('data', append);
      const timer = setTimeout(killTool, 30000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); child = undefined; resolve(`exit=${code}\n${output}${truncated ? '\n[tool output truncated]' : ''}`); });
    });
    messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    emit({ type: 'tool.completed', call_id: call.id, output: result });
  }
  if (step === maxSteps - 1) { emit({ type: 'training.terminated', termination: 'truncated' }); process.exitCode = 8; }
}
