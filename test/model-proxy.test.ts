import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HostModelProxy, loadInteractionCapture } from "../src/model-access/index.js";
import { startEvalModelCaptureRuntime } from "../src/evals/model-capture-runtime.js";

test("host model proxy streams provider traffic and seals redacted run-scoped evidence", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-model-proxy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = "sk-this-is-a-test-secret-value";
  let observed: { path?: string | undefined; authorization?: string | undefined; body?: string | undefined } = {};
  const upstream = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      observed = {
        path: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
      response.end(JSON.stringify({ model: "gpt-effective", usage: { input_tokens: 3, output_tokens: 2 }, output: "ok", api_key: secret }));
    });
  });
  const upstreamUrl = await serverUrl(upstream);
  t.after(() => close(upstream));
  const proxy = await HostModelProxy.start({
    captureRoot: path.join(root, "capture"),
    evalId: `eval_${"a".repeat(32)}`,
    mode: "hybrid",
    required: true,
    upstreams: { openai: `${upstreamUrl}/api/v1` },
    env: { OPENAI_API_KEY: secret },
    bindHost: "127.0.0.1",
    advertisedHost: "127.0.0.1",
  });
  t.after(() => proxy.close());
  const runId = `run_${"b".repeat(32)}`;
  assert.equal((await fetch(`${proxy.localBaseUrl}/${runId}/health`)).status, 200);
  const response = await fetch(`${proxy.localBaseUrl}/${runId}/openai/responses?beta=1`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "x-api-key": secret },
    body: JSON.stringify({ model: "gpt-requested", input: `use ${secret}` }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { output: string }).output, "ok");
  assert.deepEqual(observed, {
    path: "/api/v1/responses?beta=1",
    authorization: `Bearer ${secret}`,
    body: JSON.stringify({ model: "gpt-requested", input: `use ${secret}` }),
  });
  const destination = path.join(root, "run");
  const ref = await proxy.finalizeRun(runId, destination);
  assert.equal(ref.completeness, "complete");
  assert.equal(ref.interaction_count, 1);
  const loaded = await loadInteractionCapture(destination);
  assert.equal(loaded.interactions[0]?.requested_model, "gpt-requested");
  assert.equal(loaded.interactions[0]?.effective_model, "gpt-effective");
  assert.deepEqual(loaded.interactions[0]?.usage, { input_tokens: 3, output_tokens: 2 });
  assert.equal(loaded.interactions[0]?.http_status, 200);
  for (const file of await filesUnder(path.join(destination, "interactions"))) {
    assert.equal((await readFile(file, "utf8")).includes(secret), false);
  }
  assert.deepEqual(await proxy.finalizeRun(runId, destination), ref);
});

test("proxy health registration produces explicit none completeness when no model request occurs", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-model-proxy-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxy = await HostModelProxy.start({
    captureRoot: path.join(root, "capture"),
    evalId: `eval_${"c".repeat(32)}`,
    mode: "proxy",
    required: false,
    bindHost: "127.0.0.1",
    advertisedHost: "127.0.0.1",
  });
  t.after(() => proxy.close());
  const runId = `run_${"d".repeat(32)}`;
  assert.equal((await fetch(`${proxy.localBaseUrl}/${runId}/health`)).status, 200);
  const ref = await proxy.finalizeRun(runId, path.join(root, "run"));
  assert.equal(ref.completeness, "none");
  assert.equal(ref.interaction_count, 0);
});

test("host model proxy restores its endpoint and appends to persisted capture state", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-model-proxy-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model: "gpt-restored", usage: { output_tokens: 1 } }));
  });
  const upstreamUrl = await serverUrl(upstream);
  t.after(() => close(upstream));
  const options = {
    captureRoot: path.join(root, "capture"),
    evalId: `eval_${"e".repeat(32)}`,
    mode: "proxy" as const,
    required: true,
    upstreams: { openai: upstreamUrl },
    bindHost: "127.0.0.1",
    advertisedHost: "127.0.0.1",
  };
  const first = await HostModelProxy.start(options);
  const identity = first.runtimeIdentity();
  const runId = `run_${"f".repeat(32)}`;
  assert.equal((await fetch(`${first.localBaseUrl}/${runId}/openai/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-one" }),
  })).status, 200);
  await first.close();

  const restored = await HostModelProxy.start({
    ...options,
    listenPort: identity.listenPort,
    capabilityToken: identity.capabilityToken,
    resumeExisting: true,
  });
  t.after(() => restored.close());
  assert.equal(restored.localBaseUrl, first.localBaseUrl);
  assert.equal((await fetch(`${restored.localBaseUrl}/${runId}/openai/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-two" }),
  })).status, 200);
  const ref = await restored.finalizeRun(runId, path.join(root, "run"));
  assert.equal(ref.completeness, "complete");
  assert.equal(ref.interaction_count, 2);
  const loaded = await loadInteractionCapture(path.join(root, "run"));
  assert.deepEqual(loaded.interactions.map((entry) => entry.sequence), [1, 2]);
});

test("eval model capture runtime persists and restores the exact Harbor route", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-model-runtime-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evalId = `eval_${"1".repeat(32)}`;
  const plan = { requested_mode: "proxy" as const, effective_mode: "proxy" as const, required: true, topology: "host-side" as const };
  const first = await startEvalModelCaptureRuntime({ plan, evalId, evalDirectory: root, env: {} });
  assert.ok(first.route);
  const originalRoute = first.route;
  await first.close();
  const restored = await startEvalModelCaptureRuntime({ plan, evalId, evalDirectory: root, env: {} });
  t.after(() => restored.close());
  assert.deepEqual(restored.route, originalRoute);
});

async function serverUrl(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function filesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(candidate));
    else if (entry.isFile()) files.push(candidate);
  }
  return files;
}
