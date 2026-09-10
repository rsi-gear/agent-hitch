import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { atomicWriteJSON, sha256JSON } from "../src/foundation/index.js";
import { addLocalModel, prepareLocalInference, registerModelNode } from "../src/inference/index.js";
import { safetensorsFixture } from "./helpers.js";

/** Real RPC and HTTP transports, with explicit model/CUDA/process observations supplied by a fixture. */
export async function managedCandidateNode(directory: string, root: string) {
  const source = path.join(directory, "model"); await mkdir(source);
  await writeFile(path.join(source, "config.json"), JSON.stringify({ model_type: "qwen2", torch_dtype: "bfloat16", max_position_embeddings: 128 }));
  await writeFile(path.join(source, "tokenizer.json"), "{}");
  await writeFile(path.join(source, "model.safetensors"), safetensorsFixture());
  const model = await addLocalModel({ root, directory: source, name: "test" });
  const packages = [{ name: "sglang", version: "0.0.0", recordDigest: sha256JSON("candidate-fixture"), commit: null }];
  const runtime = { schemaVersion: 2, kind: "python-env", pythonVersion: "3.12.1", packagesDigest: sha256JSON(packages), packages,
    system: "Linux", machine: "x86_64", bridgeDigest: sha256JSON("bridge-fixture"), outerImageDigest: null };
  const observation = { nodeId: "candidate-node", generation: "boot-1", runtimeDigest: sha256JSON(runtime), runtime,
    gpuUuids: ["GPU-fixture"], launchers: ["process"], capabilities: { binaryCas: true, durableInferenceProcesses: true } };
  const binding = { schema_version: "2" as const, node_id: observation.nodeId, generation: observation.generation,
    runtime_digest: observation.runtimeDigest, launcher: "process" as const };
  const access = { engineToken: "d".repeat(64), adminToken: "e".repeat(64), wireModel: `hitch-${model.model_id.slice(7, 23)}`, port: 0 };
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const engine = http.createServer(async (request, response) => {
    try {
      if (request.url !== "/health") assert.ok([access.engineToken, access.adminToken].some(token => request.headers.authorization === `Bearer ${token}`));
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        response.end(JSON.stringify(request.url === "/v1/models" ? { data: [{ id: access.wireModel }] } : { ok: true })); return;
      }
      assert.equal(request.url, "/v1/responses");
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); assert.equal(body.model, access.wireModel);
      requests.push({ url: request.url!, body });
      const result = { id: `resp_${requests.length}`, object: "response", status: "completed", model: access.wireModel,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "fixture answer" }] }] };
      if (body.stream) { response.setHeader("content-type", "text/event-stream"); response.end(`data: ${JSON.stringify({ type: "response.completed", response: result })}\n\ndata: [DONE]\n\n`); }
      else response.end(JSON.stringify(result));
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  engine.listen(0, "127.0.0.1"); await once(engine, "listening");
  const close = async () => { engine.closeAllConnections(); await new Promise<void>(resolve => engine.close(() => resolve())); };
  try {
    access.port = (engine.address() as import("node:net").AddressInfo).port;
    const configPath = path.join(directory, "candidate-node.json"), script = path.join(directory, "candidate-node.mjs"), calls = path.join(directory, "candidate-node-calls.jsonl");
    await atomicWriteJSON(configPath, { observation, access, calls, model, status: null });
    await writeFile(script, peer);
    await registerModelNode(root, { schema_version: "2", binding, connection: { transport: { type: "local" },
      python: [process.execPath, script], configPath, gateway: { localPort: access.port, nodePort: access.port } } });
    const prepared = await prepareLocalInference({ root, selection: { model: "local/test", device: "cuda", profile: "baseline", offline: true, model_node: binding },
      harnessRef: "codex@version:0.145.0", doctor: { deviceConstraint: "GPU-fixture" } });
    return { prepared, binding, model, requests, access, calls, configPath, close };
  } catch (error) { await close(); throw error; }
}

const peer = `
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const file = process.argv[process.argv.indexOf('--config') + 1], config = JSON.parse(readFileSync(file, 'utf8'));
const request = JSON.parse(readFileSync(0, 'utf8')), p = request.payload, o = config.observation;
const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
const digest = value => 'sha256:' + createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
if (request.node.nodeId !== o.nodeId || request.node.generation !== o.generation || digest(p) !== request.inputDigest) process.exit(2);
appendFileSync(config.calls, request.operation + '\\n');
let result;
if (request.operation === 'probe') result = o;
else if (request.operation === 'cas.stat') {
  const entry = config.model.files.find(file => file.sha256 === p.digest);
  if (!entry) process.exit(3); result = {present: true, size: entry.size};
} else if (request.operation === 'inference.prepare') result = {prepared: true};
else if (request.operation === 'inference.start') {
  if (config.status) process.exit(4);
  const e = p.lock.execution;
  config.owner = p.ownerId;
  config.status = {schemaVersion: 2, state: 'ready', resourcesReleased: false, inferenceId: p.lock.inference_id,
    inputDigest: digest(p), handle: {schema_version:'2',kind:'process',node_id:o.nodeId,generation:o.generation,service_id:p.serviceId,process:{pid:42,created_at:1.5}},
    access: config.access, runtime:o.runtime, gpuUuid:'GPU-fixture', serverInfo:{version:'0.0.0',device:'cuda',dtype:e.dtype,kv_cache_dtype:e.kv_cache_dtype,
      attention_backend:e.attention_backend,sampling_backend:e.sampling_backend,context_length:e.context_tokens_per_request,max_running_requests:e.max_running_requests,
      tp_size:1,dp_size:1,pp_size:1,disable_radix_cache:true,disable_overlap_schedule:true,max_total_num_tokens:e.max_total_tokens,mem_fraction_static:e.platform.mem_fraction_static}};
  writeFileSync(file, JSON.stringify(config)); result = config.status;
} else {
  const s = config.status;
  if (!s || p.serviceId !== s.handle.service_id || p.ownerId !== config.owner || p.inferenceId !== s.inferenceId) process.exit(5);
  if (request.operation === 'inference.attach') {
    if (s.state !== 'ready' || p.inputDigest !== s.inputDigest || digest(p.expectedHandle) !== digest(s.handle)) process.exit(6);
  } else if (request.operation === 'inference.stop') {
    s.state = 'stopped'; s.resourcesReleased = true; writeFileSync(file, JSON.stringify(config));
  } else if (request.operation !== 'inference.inspect') process.exit(7);
  result = s;
}
process.stdout.write(JSON.stringify({schemaVersion:2,requestId:request.requestId,node:request.node,inputDigest:request.inputDigest,result}));
`;
