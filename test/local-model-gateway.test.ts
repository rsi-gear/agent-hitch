import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { InferenceLockV1, LocalModelManifestV1 } from "../src/domain/index.js";
import { buildInferenceLock, runtimeCatalogEntry } from "../src/inference/index.js";
import { LocalModelGateway } from "../src/model-access/index.js";

const model: LocalModelManifestV1 = {
  schema_version: "1",
  model_id: `sha256:${"1".repeat(64)}`,
  format: "hf-safetensors",
  files: [{ path: "model.safetensors", size: 7, sha256: `sha256:${"2".repeat(64)}` }],
  architecture: "Qwen2ForCausalLM",
  model_type: "qwen2",
  dtype: "bfloat16",
  quantization: null,
  context_tokens: 8192,
  tokenizer_digest: `sha256:${"3".repeat(64)}`,
  template_digest: `sha256:${"4".repeat(64)}`,
  source: { kind: "local-directory", label: "fixture", license: "apache-2.0" },
  created_at: "2026-09-04T00:00:00.000Z",
};

test("local model gateway binds one run, enforces the lock, and hides the engine credential", async (t) => {
  const upstreamRequests: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    upstreamRequests.push({
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
    });
    response.writeHead(200, { "content-type": "application/json", "set-cookie": "must-not-forward=1" });
    response.end(JSON.stringify({ id: "resp_1", status: "completed", model: "wire-model", output: [] }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const port = (upstream.address() as AddressInfo).port;
  const lock = buildInferenceLock(model, runtimeCatalogEntry("cuda"), { backend: "cuda", profile: "baseline" });
  const gateway = await LocalModelGateway.start({
    upstreamBaseUrl: `http://127.0.0.1:${port}`,
    engineToken: "engine-secret",
    wireModel: "wire-model",
    lock,
  });
  t.after(() => gateway.close());
  const runId = `run_${"a".repeat(32)}`;
  const registration = gateway.register(runId);

  const catalog = await fetch(new URL("models?client_version=0.145.0", registration.binding.base_url), {
    headers: { authorization: `Bearer ${registration.credential}` },
  });
  assert.equal(catalog.status, 200);
  assert.equal(((await catalog.json() as { data: Array<{ id: string }> }).data[0]?.id), "wire-model");

  const accepted = await fetch(new URL("responses", registration.binding.base_url), {
    method: "POST",
    headers: { authorization: `Bearer ${registration.credential}`, "content-type": "application/json", cookie: "user-cookie=1" },
    body: JSON.stringify({ model: registration.binding.wire_model, input: "hello" }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.has("set-cookie"), false);
  assert.equal((await accepted.json() as { status: string }).status, "completed");
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0]?.authorization, "Bearer engine-secret");
  assert.equal(upstreamRequests[0]?.body.model, "wire-model");
  assert.equal(upstreamRequests[0]?.body.temperature, 0);
  assert.equal(upstreamRequests[0]?.body.top_p, 1);
  assert.equal(upstreamRequests[0]?.body.top_k, 0);
  assert.equal(upstreamRequests[0]?.body.min_p, 0);
  assert.equal(upstreamRequests[0]?.body.repetition_penalty, 1);
  assert.equal(upstreamRequests[0]?.body.parallel_tool_calls, false);
  assert.equal(upstreamRequests[0]?.body.max_output_tokens, lock.generation.max_output_tokens);
  assert.equal(upstreamRequests[0]?.body.store, false);
  assert.equal(upstreamRequests[0]?.body.truncation, "disabled");

  const wrongModel = await fetch(new URL("responses", registration.binding.base_url), {
    method: "POST",
    headers: { authorization: `Bearer ${registration.credential}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "another-model", input: "hello" }),
  });
  assert.equal(wrongModel.status, 400);
  assert.equal((await wrongModel.json() as { error: { code: string } }).error.code, "inference_parameter_conflict");

  const cloudTool = await fetch(new URL("responses", registration.binding.base_url), {
    method: "POST",
    headers: { authorization: `Bearer ${registration.credential}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "wire-model", input: "hello", tools: [{ type: "web_search" }] }),
  });
  assert.equal(cloudTool.status, 400);

  const reasoning = await fetch(new URL("responses", registration.binding.base_url), {
    method: "POST",
    headers: { authorization: `Bearer ${registration.credential}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "wire-model", input: "hello", reasoning: { effort: "high" } }),
  });
  assert.equal(reasoning.status, 400);

  const codexShape = await fetch(new URL("responses", registration.binding.base_url), {
    method: "POST",
    headers: { authorization: `Bearer ${registration.credential}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "wire-model", input: "hello", tools: [{ type: "function", name: "shell", parameters: {} }],
      reasoning: { summary: "auto" }, include: ["reasoning.encrypted_content"],
      prompt_cache_key: "thread-1", client_metadata: { turn_id: "turn-1" }, stream: true,
    }),
  });
  assert.equal(codexShape.status, 200);
  assert.equal(upstreamRequests[1]?.body.prompt_cache_key, undefined);
  assert.deepEqual(upstreamRequests[1]?.body.metadata, { turn_id: "turn-1" });

  const unauthorized = await fetch(new URL("responses", registration.binding.base_url), {
    method: "POST",
    headers: { authorization: `Bearer ${"f".repeat(64)}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "wire-model", input: "hello" }),
  });
  assert.equal(unauthorized.status, 401);
  registration.revoke();
  const revoked = await fetch(new URL("responses", registration.binding.base_url), {
    method: "POST",
    headers: { authorization: `Bearer ${registration.credential}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "wire-model", input: "hello" }),
  });
  assert.equal(revoked.status, 401);
});

test("local model gateway bounds concurrent and queued requests", async (t) => {
  let finishFirst: (() => void) | undefined;
  let received = 0;
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume */ }
    received += 1;
    if (received === 1) await new Promise<void>((resolve) => { finishFirst = resolve; });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "completed", output: [] }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const runtime = runtimeCatalogEntry("cuda");
  const built = buildInferenceLock(model, runtime, { backend: "cuda", profile: "baseline" });
  const lock: InferenceLockV1 = {
    ...built,
    execution: { ...built.execution, max_running_requests: 1, max_queued_requests: 1, queue_timeout_ms: 5_000 },
  };
  const gateway = await LocalModelGateway.start({
    upstreamBaseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    engineToken: "engine-secret",
    wireModel: "wire-model",
    lock,
  });
  t.after(() => gateway.close());
  const registrations = ["a", "b", "c"].map((suffix) => gateway.register(`run_${suffix.repeat(32)}`));
  const call = (index: number) => fetch(new URL("responses", registrations[index]!.binding.base_url), {
    method: "POST",
    headers: { authorization: `Bearer ${registrations[index]!.credential}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "wire-model", input: "hello" }),
  });
  const first = call(0);
  while (received < 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = call(1);
  const third = await call(2);
  assert.equal(third.status, 429);
  finishFirst?.();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});
