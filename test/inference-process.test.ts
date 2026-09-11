import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import type { InferenceRuntimeManifestV1, InferenceServiceRecordV1 } from "../src/domain/index.js";
import { sha256JSON } from "../src/foundation/index.js";
import { addLocalModel, buildInferenceLock, inferenceRuntimeIdentity, ProcessSGLangLauncher, PythonInferenceNodeClient } from "../src/inference/index.js";
import type { InferenceNodeClient, SGLangLaunchInput, SGLangLaunchedService } from "../src/inference/index.js";
import { safetensorsFixture } from "../test-support/helpers.js";

async function fixture(root: string) {
  const source = path.join(root, "model"); await mkdir(source);
  await writeFile(path.join(source, "config.json"), JSON.stringify({ architectures: ["Qwen2ForCausalLM"], model_type: "qwen2", torch_dtype: "float32", max_position_embeddings: 128 }));
  await writeFile(path.join(source, "tokenizer.json"), "{}");
  await writeFile(path.join(source, "tokenizer_config.json"), JSON.stringify({ chat_template: "{{ messages }}" }));
  await writeFile(path.join(source, "model.safetensors"), safetensorsFixture());
  return addLocalModel({ root: path.join(root, "hitch"), directory: source, name: "fixture" });
}
function runtime(actual: { pythonVersion: string; packagesDigest: `sha256:${string}` }): InferenceRuntimeManifestV1 {
  const body = { schema_version: "2" as const, engine: "sglang" as const, sglang_version: "0.0.0", sglang_commit: null, backend: "cpu" as const,
    package: { kind: "python-env" as const, environment_digest: sha256JSON(actual), python_version: actual.pythonVersion, packages_digest: actual.packagesDigest }, compatibility_profile: "cpu-process-fixture-only" };
  return { ...body, runtime_id: inferenceRuntimeIdentity(body) };
}

test("process launcher preserves ambiguous ownership after a lost stop reply and rejects a foreign generation", async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hitch-process-contract-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const model = await fixture(temporary);
  const actual = { pythonVersion: "3.12.1", packagesDigest: sha256JSON("fixture"), outerImageDigest: null };
  const manifest = runtime(actual); const lock = buildInferenceLock(model, manifest, { backend: "cpu", profile: "baseline" });
  const input: SGLangLaunchInput = { root: path.join(temporary, "hitch"), serviceId: `inference_${"a".repeat(32)}`, model, runtime: manifest, lock };
  let stopCalls = 0;
  const client: InferenceNodeClient = { node: { nodeId: "node", generation: "boot-1" }, prepare: async () => {},
    start: async () => { throw new Error("lost start reply"); }, inspect: async () => null, route: async () => "http://127.0.0.1:30000",
    stop: async () => { stopCalls++; throw new Error("lost stop reply"); } };
  const launcher = new ProcessSGLangLauncher(client);
  await assert.rejects(launcher.start(input), (error: unknown) => (error as { code?: string }).code === "inference_recovery_ambiguous");
  assert.equal(stopCalls, 1);
  const result = await launcher.stopOrphan(input.root, { service_id: input.serviceId, inference_id: lock.inference_id,
    service_handle: { schema_version: "2", kind: "process", node_id: "node", generation: "another-boot", service_id: input.serviceId, process: { pid: 123, created_at: 10 } } } as never);
  assert.equal(result, "ambiguous"); assert.equal(stopCalls, 1);
});

test("node client keeps SSH configuration out of remote shell syntax and pins a stable route", async () => {
  const client = new PythonInferenceNodeClient({ transport: { type: "ssh", host: "gpu-node" }, python: ["/env with space/bin/python"],
    configPath: "/node/it'works.json", gateway: { localPort: 30000, nodePort: 30001 } }, { nodeId: "node", generation: "boot-1" });
  assert.equal(client.command("rpc").at(-1), "'/env with space/bin/python' '-m' 'gear_training.node' 'rpc' '--config' '/node/it'\\''works.json'");
  await assert.rejects(client.route("/unused", 31000), /configured route/);
});

// This optional cross-package integration is explicitly enabled in Gear/Hitch
// joint validation; normal Hitch unit runs do not require installing Gear.
test("Hitch process launcher uses real node RPC, separate model CAS and durable CPU processes without Docker", {
  skip: !process.env.GEAR_TRAINING_NODE_PYTHONPATH,
}, async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hitch-process-rpc-"));
  let service: SGLangLaunchedService | undefined;
  t.after(async () => { try { await service?.stop(); } finally { await rm(temporary, { recursive: true, force: true }); } });
  const module = path.join(temporary, "fixture"); await mkdir(path.join(module, "sglang"), { recursive: true });
  await writeFile(path.join(module, "sglang", "__init__.py"), "");
  await writeFile(path.join(module, "sglang", "launch_server.py"), server);
  const metadata = path.join(module, "sglang-0.0.0.dist-info"); await mkdir(metadata);
  await writeFile(path.join(metadata, "METADATA"), "Name: sglang\nVersion: 0.0.0\n"); await writeFile(path.join(metadata, "RECORD"), "fixture\n");
  const python = process.env.GEAR_TRAINING_TEST_PYTHON || "python3";
  const requestLog = path.join(temporary, "engine-requests.jsonl");
  const env = { ...process.env, PYTHONPATH: [module, process.env.GEAR_TRAINING_NODE_PYTHONPATH].join(path.delimiter), HITCH_FIXTURE_REQUEST_LOG: requestLog };
  const listener = net.createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  const configPath = path.join(temporary, "node.json");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 2, nodeId: "cpu-process-fixture", nodeRoot: path.join(temporary, "node"),
    storeRoot: path.join(temporary, "node-cas"), jobConfigPath: path.join(temporary, "absent-job.json"), inferencePort: port }));
  const result = await promisify(execFile)(python, ["-c", "import json,sys; from gear_training.node import NodeService; print(json.dumps(NodeService(json.load(open(sys.argv[1]))).probe()))", configPath], { env });
  const probe = JSON.parse(result.stdout);
  const client = new PythonInferenceNodeClient({ transport: { type: "local" }, python: [python], configPath,
    gateway: { localPort: port, nodePort: port } }, { nodeId: probe.nodeId, generation: probe.generation }, env);
  const model = await fixture(temporary); const manifest = runtime(probe.runtime);
  const lock = buildInferenceLock(model, manifest, { backend: "cpu", profile: "baseline", api: "chat-completions" });
  const input: SGLangLaunchInput = { root: path.join(temporary, "hitch"), serviceId: `inference_${"b".repeat(32)}`, model, runtime: manifest, lock };
  const launcher = new ProcessSGLangLauncher(client);
  service = await launcher.start(input);
  assert.equal(service.service_handle?.kind, "process"); assert.equal(service.observation?.schema_version, "2");
  assert.equal("container_id" in service, false); assert.equal(JSON.stringify(service.observation).includes("fixture-private"), false);
  await service.checkHealth?.();
  const handle = service.service_handle!; assert.equal(service.observation?.schema_version, "2");
  const record: InferenceServiceRecordV1 = { schema_version: "1", service_id: input.serviceId, inference_id: lock.inference_id,
    isolation_key: sha256JSON("cpu-recovery"), epoch: 7, owner_id: `run_${"c".repeat(32)}`, lease_owner_ids: [`run_${"c".repeat(32)}`],
    state: "ready", backend: "cpu", service_handle: handle, started_at: service.observation!.observed_at, updated_at: new Date().toISOString() };
  // A fresh controller/client attaches to the same actual detached CPU engine.
  // Public managed-node planning still requires CUDA; this exercises the lower
  // process transport without claiming real model/GPU validation.
  const nextClient = new PythonInferenceNodeClient(client.connection, client.node, env);
  nextClient.start = async () => { throw new Error("attachment must not start"); };
  nextClient.prepare = async () => { throw new Error("attachment must not prepare"); };
  const nextLauncher = new ProcessSGLangLauncher(nextClient);
  const before = (await readFile(requestLog, "utf8")).trim().split("\n");
  const originalObservation = service.observation;
  service = await nextLauncher.attach({ root: input.root, lock, model, runtime: manifest, record, observation: originalObservation as never });
  assert.deepEqual(service.service_handle, handle); assert.deepEqual(service.observation, originalObservation);
  service = await nextLauncher.attach({ root: input.root, lock, model, runtime: manifest, record, observation: originalObservation as never });
  const attachedRequests = (await readFile(requestLog, "utf8")).trim().split("\n").slice(before.length).map(line => JSON.parse(line) as string[]);
  assert.deepEqual(attachedRequests, [["GET", "/server_info"], ["GET", "/v1/models"], ["GET", "/server_info"], ["GET", "/v1/models"]]);
  assert.equal(JSON.stringify(service.observation).includes("fixture-private"), false);
  await service.checkHealth?.();
  await service.stop(); await service.stop();
  assert.equal(await launcher.stopOrphan(input.root, { service_id: input.serviceId, inference_id: lock.inference_id, service_handle: service.service_handle } as never), "stopped");
});

const server = `
import argparse,json,os
from http.server import BaseHTTPRequestHandler,HTTPServer
p=argparse.ArgumentParser()
for key in ('port','api-key','admin-api-key','served-model-name','dtype','context-length','max-running-requests','max-total-tokens','kv-cache-dtype','attention-backend','sampling-backend'): p.add_argument('--'+key)
args,_=p.parse_known_args()
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def record(self):
        if os.environ.get('HITCH_FIXTURE_REQUEST_LOG'):
            with open(os.environ['HITCH_FIXTURE_REQUEST_LOG'],'a') as output: output.write(json.dumps([self.command,self.path])+'\\n')
    def do_GET(self):
        self.record()
        token = args.admin_api_key if self.path == '/flush_cache' else args.api_key
        if self.path != '/health' and self.headers.get('Authorization') != 'Bearer '+token:
            self.send_response(401); self.end_headers(); return
        data={'data':[{'id':args.served_model_name}]}
        if self.path=='/server_info': data={'version':'0.0.0','device':'cpu','dtype':args.dtype,'kv_cache_dtype':args.kv_cache_dtype,'attention_backend':args.attention_backend,'sampling_backend':args.sampling_backend,'context_length':int(args.context_length),'max_running_requests':int(args.max_running_requests),'max_total_num_tokens':int(args.max_total_tokens),'tp_size':1,'dp_size':1,'pp_size':1,'disable_radix_cache':True,'disable_overlap_schedule':True,'api_key':'fixture-private'}
        self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(data).encode())
    def do_POST(self):
        self.record()
        if self.headers.get('Authorization') != 'Bearer '+args.api_key: self.send_response(401); self.end_headers(); return
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        result=json.dumps({'choices':[{'finish_reason':'stop','message':{'role':'assistant','content':'ok'}}]})
        self.send_response(200)
        if body.get('stream'): self.send_header('content-type','text/event-stream')
        self.end_headers(); self.wfile.write(('data: '+result+'\\n\\ndata: [DONE]\\n\\n' if body.get('stream') else result).encode())
HTTPServer(('127.0.0.1',int(args.port)),Handler).serve_forever()
`;
