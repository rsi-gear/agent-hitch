import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeRun, newRunId, loadRunRecord } from "../src/runs/index.js";
import { connectEndpoint, resolveEndpoint, publicEndpointBinding, HostModelProxy, aggregateModelUsage, loadFrozenEndpoint, endpointRequest, freezeEndpointRequest, loadInteractionCapture } from "../src/model-access/index.js";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import type { ExternalEndpointBindingV1, RunId } from "../src/domain/index.js";
import type { PreparedArtifact, ResolvedRevision } from "../src/artifacts/index.js";
import { endpointHttp } from "../test-support/endpoint-http.js";
import { forceRemove } from "../test-support/helpers.js";
import { delay, packageRoot, readJSON, sha256Bytes, sha256JSON } from "../src/foundation/index.js";

async function state(t: TestContext) { const value = await mkdtemp(path.join(tmpdir(), "hitch-endpoint-execution-")); t.after(() => forceRemove(value)); return value; }
async function artifact() {
  const runner = path.join(packageRoot(), "integrations/model-call/cli.js"), commit = "a".repeat(40), ref = `model-call@commit:${commit}`;
  const resolution = { schema_version: "1", requested_ref: ref, canonical_ref: ref, harness_id: "model-call", selector: { type: "commit", value: commit },
    source: { type: "git", url: "https://github.com/rsi-gear/agent-hitch.git" }, revision: { type: "commit", commit }, identity: sha256JSON(ref), resolved_at: new Date().toISOString() } as unknown as ResolvedRevision;
  const prepared: PreparedArtifact = { schema_version: "1", artifact_id: sha256JSON(runner), harness_id: "model-call", revision_identity: resolution.identity,
    source_type: "git", adapter: "model-call", adapter_version: "1", recipe_version: "1", platform: `${process.platform}-${process.arch}`, entrypoint: runner,
    toolchain: {}, resolved_revision: resolution, artifact_integrity: sha256Bytes(await readFile(runner)), entrypoint_integrity: sha256Bytes(await readFile(runner)),
    prepared_at: new Date().toISOString(), executable: process.execPath, entrypoint_args: [runner], cache_hit: true };
  return { resolution, prepared, ref };
}

for (const api of ["responses", "chat-completions"] as const) test(`two actual model-call runs share ${api} endpoint and publish real usage/identity`, async t => {
  const root = await state(t), http = await endpointHttp(t, api), a = await artifact(), cwd = path.join(root, "workspace"); await mkdir(cwd);
  // Preserve provider-native alias fields while publishing normalized totals.
  if (api === "responses") http.setUsage({ input_tokens: 12, completion_tokens: 7, total_tokens: 19 });
  await connectEndpoint(root, "shared", http.config);
  const ids = [newRunId(), newRunId()];
  const results = await Promise.all(ids.map(runId => executeRun({ runId, root, runsRoot: path.join(root, "runs"), resolvedRevision: a.resolution, preparedArtifact: a.prepared,
    request: { harness_ref: a.ref, model: "endpoint/shared", cwd, prompt: "Ordinary text request", generation: { max_output_tokens: 1024 }, timeout_ms: 10_000 } })));
  for (let i = 0; i < ids.length; i++) {
    assert.equal(results[i]!.status, "succeeded", JSON.stringify(results[i])); assert.equal(results[i]!.output, "ready");
    assert.deepEqual(results[i]!.usage, { requests: 1, source: "model-interactions-v1", completeness: "complete", input_tokens: 12, output_tokens: 7, total_tokens: 19 });
    const record = await loadRunRecord(path.join(root, "runs", ids[i]!));
    assert.equal(record.record.model.identity_resolved, false); assert.equal(record.record.model.endpoint_binding?.wire_model, "candidate-v1");
    const capture = await loadInteractionCapture(path.join(root, "runs", ids[i]!)); assert.equal(capture.interactions[0]!.usage?.completion_tokens, 7);
    if (api === "chat-completions") assert.equal(capture.interactions[0]!.usage?.prompt_tokens, 12);
  }
  assert.equal(http.requests.filter(r => JSON.stringify(r.body).includes("Ordinary text request")).length, 2);
  assert.equal(http.requests.every(r => r.body[api === "responses" ? "max_output_tokens" : "max_tokens"] === 1024), true);
  const missing = await aggregateModelUsage(root, [`run_${"f".repeat(32)}`]);
  assert.equal(missing.requests, undefined); assert.equal(missing.input_tokens, undefined); assert.equal(missing.completeness, "partial");
  const partial = await aggregateModelUsage(root, [ids[0]!, `run_${"f".repeat(32)}`]);
  assert.equal(partial.requests, undefined); assert.equal(partial.output_tokens, undefined); assert.equal(partial.completeness, "partial");
  const merged = await aggregateModelUsage(root, [ids[0]!, ids[1]!, ids[0]!]); assert.equal(merged.requests, 2); assert.equal(merged.output_tokens, 14);
});

test("an actual provider response with a different model fails and preserves the observed canonical identity", async t => {
  const root = await state(t), http = await endpointHttp(t), a = await artifact(), cwd = path.join(root, "workspace"); await mkdir(cwd);
  await connectEndpoint(root, "drift", http.config);
  const request = await freezeEndpointRequest(root, { harness_ref: a.ref, model: "endpoint/drift", cwd, prompt: "Ordinary text request", generation: { max_output_tokens: 1024 }, timeout_ms: 10_000 });
  http.setResponseModel("unexpected-fallback"); const runId = newRunId();
  const result = await executeRun({ runId, root, runsRoot: path.join(root, "runs"), resolvedRevision: a.resolution, preparedArtifact: a.prepared, request });
  assert.equal(result.status, "failed"); assert.equal((result.error as { code: string }).code, "endpoint_model_mismatch");
  const record = await loadRunRecord(path.join(root, "runs", runId));
  assert.equal(record.record.model.effective_id, "unexpected-fallback"); assert.equal(record.record.model.identity_resolved, false);
  assert.equal(record.record.model.endpoint_binding?.wire_model, "candidate-v1");
});

test("actual training-tool ordinary endpoint executes shell tool and returns complete history without a policy lease", async t => {
  const root = await state(t), requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body); assert.equal(req.url, "/prefix/v1/chat/completions"); assert.equal(body.model, "candidate-tools-v1");
    const finished = body.messages.at(-1).role === "tool";
    if (finished) assert.match(body.messages.at(-1).content, /external-tool-ok/);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: body.model, usage: { prompt_tokens: 12, completion_tokens: 7 }, choices: [{ finish_reason: finished ? "stop" : "tool_calls", message: finished
      ? { role: "assistant", content: "tool completed" } : { role: "assistant", content: null, tool_calls: [{ id: "call_shell", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf external-tool-ok" }) } }] } }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  await connectEndpoint(root, "tools", { schema_version: "1", base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/prefix/v1`, wire_model: "candidate-tools-v1", api: "chat-completions", auth: { kind: "none" }, capabilities: { streaming: false, tool_calls: true, parallel_tool_calls: false, input_modalities: ["text"] } });
  const ready = await resolveEndpoint(root, "endpoint/tools", { max_output_tokens: 1024 }), binding = publicEndpointBinding(ready), runId = newRunId();
  const proxy = await HostModelProxy.start({ captureRoot: root, evalId: `eval_${"e".repeat(32)}`, mode: "proxy", required: true, advertisedHost: "127.0.0.1",
    upstreams: { openai: ready.connection.base_url }, upstreamAuthorizations: { openai: "" }, upstreamWireModels: { openai: ready.wire_model }, externalEndpointBinding: binding });
  t.after(() => proxy.close());
  const child = spawn(process.execPath, [path.join(packageRoot(), "integrations/training-tool/cli.js"), "--model", "endpoint/tools"], { cwd: root,
    env: { PATH: process.env.PATH, HITCH_HARBOR_INTERNAL: "1", HITCH_EXTERNAL_RUN_ID: runId, HITCH_EXTERNAL_ENDPOINT_BINDING: JSON.stringify(binding),
      HITCH_LOCAL_MAX_OUTPUT_TOKENS: "1024", OPENAI_API_KEY: "task-proxy-sentinel", OPENAI_BASE_URL: `${proxy.localBaseUrl}/${runId}/openai` }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c); child.stdin.end("Run the shell tool.");
  assert.deepEqual(await once(child, "close"), [0, null], stderr);
  const events = stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.filter(e => e.type === "tool.started").length, 1); assert.equal(events.find(e => e.type === "message.completed").text, "tool completed");
  assert.equal(requests.length, 2); assert.equal(requests.every(r => r.max_tokens === 1024 && r.parallel_tool_calls === false), true); assert.equal(requests[1]!.messages instanceof Array, true);
});

test("two independent daemon eval submissions freeze aliases before execution and cancel one consumer", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-endpoint-execution-"));
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let server: DaemonServer | undefined;
  // After hooks run in registration order: drain the daemon while its state and upstream still exist.
  t.after(async () => {
    release();
    try { await server?.close(); }
    finally { await forceRemove(root); }
  });
  const http = await endpointHttp(t);
  await connectEndpoint(root, "eval", http.config);
  server = new DaemonServer({ root, port: 0, maxConcurrent: 2, logger: () => {},
    resourceCapacity: { cpu_millis: 2000, memory_bytes: 2 * 1024 ** 3, container_slots: 2, build_slots: 1 },
    evalExecutor: async options => {
      await Promise.race([gate, new Promise<void>(resolve => options.signal?.addEventListener("abort", () => resolve(), { once: true }))]);
      const binding = options.normalizedRequest!.endpoint_binding!;
      if (!options.signal?.aborted) {
        const ready = await loadFrozenEndpoint(root, binding);
        const response = await fetch(`${ready.connection.base_url}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(endpointRequest(binding, { input: "daemon task" })), ...(options.signal ? { signal: options.signal } : {}) });
        assert.equal(response.status, 200); await response.json();
      }
      return { schema_version: "1", eval_id: options.evalId!, status: options.signal?.aborted ? "cancelled" : "succeeded", exit_code: options.signal?.aborted ? 9 : 0,
        endpoint_binding: binding, task_completed: true, trials: [], started_at: new Date().toISOString(), completed_at: new Date().toISOString() };
    } });
  await server.start();
  const client = await daemonClient(root), submit = (dataset: string) => client.request("/v1/evals", { method: "POST", body: JSON.stringify({ dataset, harness_ref: "model-call@commit:" + "a".repeat(40), model: "endpoint/eval", max_concurrent: 1, generation: { max_output_tokens: 1024 } }) });
  const first = await submit("first@1.0"), second = await submit("second@1.0");
  const before = await readJSON<{ endpoint_binding: ExternalEndpointBindingV1 }>(path.join(root, "evals", String(first.eval_id), "request.json"));
  await connectEndpoint(root, "eval", { ...http.config, wire_model: "candidate-v2" });
  await client.request(`/v1/evals/${first.eval_id}/cancel`, { method: "POST" }); release();
  for (let i = 0; i < 100; i++) { const result = await client.request(`/v1/evals/${second.eval_id}`); if (result.result) break; await delay(10); }
  const inspection = await client.request(`/v1/evals/${second.eval_id}`);
  assert.equal((inspection.result as { status: string }).status, "succeeded");
  assert.deepEqual((inspection.request as { endpoint_binding: unknown }).endpoint_binding, before.endpoint_binding);
  assert.equal(http.requests.filter(r => r.body.input === "daemon task").length, 1);
  assert.equal(http.requests.find(r => r.body.input === "daemon task")!.body.model, "candidate-v1");
  assert.equal(JSON.stringify(inspection).includes(http.config.base_url), false);
});
