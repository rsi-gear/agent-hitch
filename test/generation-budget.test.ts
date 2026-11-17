import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GenerationBudgetMeter, inputTokenCeiling } from "../src/model-access/generation-budget.js";
import { HostModelProxy } from "../src/model-access/index.js";

const body = { model: "test", instructions: "Follow the task.", input: [{ role: "user", content: [{ type: "input_text", text: "中文 🧭" }] }], stream: true, store: false };
const terminal = (input = 20, output = 5, extra = {}) => ({ encoding: "utf8", truncated: false,
  body: "data: " + JSON.stringify({ type: "response.completed", response: { status: "completed", ...extra,
    usage: { input_tokens: input, output_tokens: output, total_tokens: input + output, input_tokens_details: { cached_tokens: 4 } } } }) + "\n\n" });

test("request and total token budgets include every retry and reused cached input", () => {
  const meter = new GenerationBudgetMeter({ model_requests: 2, tokens: 10000 });
  const ceiling = inputTokenCeiling(body, new Map());
  assert.equal(meter.reserve(body).max_output_tokens, 10000 - ceiling);
  assert.throws(() => meter.reserve(body), /unavailable/);
  meter.settle(terminal());
  assert.equal(meter.reserve(body).max_output_tokens, 9975 - ceiling);
  meter.settle(terminal());
  assert.throws(() => meter.reserve(body), /exhausted/);
  assert.deepEqual(meter.usage(), { model_requests: 2, input_tokens: 40, output_tokens: 10, cached_input_tokens: 8, tokens: 50 });
});

test("insufficient first-call input allowance makes no model request", () => {
  const meter = new GenerationBudgetMeter({ tokens: 1 });
  assert.throws(() => meter.reserve(body), /exhausted/);
  assert.equal(meter.usage().model_requests, 0);
  assert.equal(meter.usage().tokens, 0);
});

test("unknown usage and malformed totals fence further work without zeroing its cost", () => {
  for (const payload of [null, { body: "data: {}\n", truncated: false }, { body: terminal().body, truncated: true }]) {
    const meter = new GenerationBudgetMeter({ tokens: 10000 });
    meter.reserve(body); meter.settle(payload);
    assert.equal(meter.usage().tokens, null);
    assert.equal(meter.usage().model_requests, 1);
    assert.throws(() => meter.reserve(body), /unknown/);
  }
});

test("actual overruns remain visible and stop all later requests", () => {
  const meter = new GenerationBudgetMeter({ tokens: 10000 });
  meter.reserve(body); meter.settle(terminal(11000, 5));
  assert.equal(meter.usage().tokens, 11005);
  assert.equal(meter.error(), "generation_budget_violation");
  assert.throws(() => meter.reserve(body), /violation/);
});

test("server-side expansion and unmeasured encrypted reasoning are rejected before dispatch", () => {
  for (const value of [
    { ...body, previous_response_id: "hidden" },
    { ...body, tools: [{ type: "web_search" }] },
    { ...body, input: [{ type: "item_reference", id: "hidden" }] },
    { ...body, input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test" }] }] },
    { ...body, input: [{ type: "reasoning", encrypted_content: "unknown" }] },
  ]) {
    const meter = new GenerationBudgetMeter({ tokens: 10000 });
    assert.throws(() => meter.reserve(value), /unsupported/);
    assert.equal(meter.usage().model_requests, 0);
  }
  const meter = new GenerationBudgetMeter({ tokens: 10000 });
  meter.reserve(body); meter.settle(terminal(20, 500, { output: [{ type: "reasoning", encrypted_content: "known" }] }));
  const next = meter.reserve({ ...body, input: [{ type: "reasoning", encrypted_content: "known" }] });
  assert.ok(Number(next.max_output_tokens) < 10000 - 520 - 500);
});

test("Codex client metadata, namespaces and deferred client tools remain metered", () => {
  const tool = { type: "namespace", name: "functions", tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }] };
  const meter = new GenerationBudgetMeter({ model_requests: 1, tokens: 10000 });
  const accepted = meter.reserve({ ...body, client_metadata: { turn_id: "one" }, tools: [tool], input: [...body.input, { type: "additional_tools", role: "developer", tools: [tool] }, { type: "function_call_output", call_id: "tool", output: [{ type: "input_text", text: "file contents" }] }] });
  assert.ok(Number(accepted.max_output_tokens) < 10000);
  assert.throws(() => new GenerationBudgetMeter({ tokens: 10000 }).reserve({ ...body, tools: [{ type: "namespace", name: "hidden", tools: [{ type: "web_search" }] }] }), /unsupported/);
});

test("completed streamed reasoning is reusable when the terminal response omits output", () => {
  const meter = new GenerationBudgetMeter({ model_requests: 2, tokens: 10000 });
  meter.reserve(body);
  const payload = terminal(20, 500, { output: [] });
  payload.body = [
    { type: "response.output_item.added", item: { id: "rs_1", type: "reasoning", encrypted_content: "partial" } },
    { type: "response.output_item.done", item: { id: "rs_1", type: "reasoning", encrypted_content: "complete" } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + payload.body;
  meter.settle(payload);
  assert.equal(meter.usage().tokens, 520);
  assert.throws(() => meter.reserve({ ...body, input: [{ type: "reasoning", encrypted_content: "partial" }] }), /unmeasured_reasoning/);
  const next = meter.reserve({ ...body, input: [{ type: "reasoning", encrypted_content: "complete" }] });
  assert.ok(Number(next.max_output_tokens) < 10000 - 520 - 500);
  meter.settle(terminal());
  assert.equal(meter.usage().tokens, 545);
  assert.throws(() => meter.reserve(body), /exhausted/);
});

test("streamed reasoning without settled usage or after the terminal event remains untrusted", () => {
  const done = `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "opaque" } })}\n\n`;
  const incomplete = new GenerationBudgetMeter({ tokens: 10000 });
  incomplete.reserve(body);
  incomplete.settle({ body: done, truncated: false });
  assert.equal(incomplete.usage().tokens, null);
  assert.throws(() => incomplete.reserve({ ...body, input: [{ type: "reasoning", encrypted_content: "opaque" }] }), /unknown/);

  const late = new GenerationBudgetMeter({ tokens: 10000 });
  late.reserve(body);
  late.settle({ ...terminal(), body: terminal().body + done });
  assert.throws(() => late.reserve({ ...body, input: [{ type: "reasoning", encrypted_content: "opaque" }] }), /unmeasured_reasoning/);
  assert.equal(late.usage().model_requests, 1);
});

test("the real proxy enforces the same allowance before forwarding and never routes compaction around it", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const forwarded: Array<Record<string, unknown>> = [];
  const upstream = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      assert.equal(request.headers.authorization, "Bearer private-upstream");
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (forwarded.length === 1) response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "streamed" } })}\n\n`);
      response.write(terminal(20, 5, { output: [] }).body);
      setTimeout(() => response.end(), 30);
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const proxy = await HostModelProxy.start({ captureRoot: root, evalId: `eval_${"a".repeat(32)}`, mode: "proxy", required: true,
    upstreams: { openai: `http://127.0.0.1:${address.port}/v1` }, upstreamAuthorizations: { openai: "Bearer private-upstream" },
    upstreamWireModels: { openai: "test" }, generationLimits: { model_requests: 2, tokens: 10000 } });
  t.after(() => proxy.close());
  const base = `${proxy.localBaseUrl}/run_${"b".repeat(32)}/openai/responses`;
  const send = (url = base, payload: Record<string, unknown> = body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const blocked = await send(base + "/compact"); await blocked.text(); assert.equal(blocked.status, 400);
  for (let index = 0; index < 2; index++) {
    const payload = index === 0 ? body : { ...body, input: [...body.input, { type: "reasoning", encrypted_content: "streamed" }] };
    const response = await send(base, payload); assert.equal(response.status, 200);
    const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
    assert.equal(proxy.generationBudget!.usage().tokens, 25 * (index + 1));
  }
  const exhausted = await send(); assert.equal(exhausted.status, 502); assert.match(await exhausted.text(), /exhausted/);
  assert.equal(forwarded.length, 2);
  assert.ok(Number(forwarded[0]!.max_output_tokens) - Number(forwarded[1]!.max_output_tokens) > 25 + 5);
  assert.equal(proxy.generationBudget!.usage().tokens, 50);
});

test("explicit upstream proxy authentication stays outside the model request and remains budgeted", async t => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major! > 24 || (major === 24 && minor! >= 5) || (major === 22 && minor! >= 21))) return t.skip("Node built-in proxy support unavailable");
  const root = await mkdtemp(path.join(tmpdir(), "hitch-upstream-proxy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const upstream = http.createServer((request, response) => {
    calls++;
    assert.equal(request.url, "http://models.example.test/v1/responses");
    assert.equal(request.headers['proxy-authorization'], `Basic ${Buffer.from('test:private-proxy').toString('base64')}`);
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" }); response.end(terminal().body);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const proxy = await HostModelProxy.start({ captureRoot: root, evalId: `eval_${"a".repeat(32)}`, mode: "proxy", required: true,
    upstreams: { openai: "http://models.example.test/v1" }, upstreamWireModels: { openai: "test" },
    upstreamProxyEnv: { HTTP_PROXY: `http://test:private-proxy@127.0.0.1:${address.port}` }, generationLimits: { model_requests: 1, tokens: 10000 } });
  t.after(() => proxy.close());
  const response = await fetch(`${proxy.localBaseUrl}/run_${"b".repeat(32)}/openai/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200); assert.ok(!(await response.text()).includes("private-proxy"));
  assert.equal(calls, 1); assert.equal(proxy.generationBudget!.usage().tokens, 25);
});
