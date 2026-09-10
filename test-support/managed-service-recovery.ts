import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { AcquireManagedInferenceInputV1, EvalRequest, RemoteWorkerRegistrationV1 } from "../src/domain/index.js";
import { LocalInferenceManager, ManagedServiceRecovery, RemoteWorkerHttpClient, RemoteWorkerProtocol, RemoteWorkerRegistry, RemoteWorkInputStore } from "../src/control-plane/index.js";
import { SGLangServiceSupervisor } from "../src/inference/index.js";
import { buildEvalExecutionPlan, createExecutionLease, validateEvalId } from "../src/evals/index.js";
import { candidateRestartWorkItem } from "../src/evals/physical-work-plan.js";
import { remoteModelBinding } from "../src/model-access/index.js";
import type { RemoteModelTargetV2 } from "../src/model-access/index.js";
import { atomicWriteJSON, hitchRootId, sha256JSON, statePaths } from "../src/foundation/index.js";
import { handleRemoteWorkRoute } from "../src/daemon/worker-routes.js";
import { inferenceAttachmentFixture } from "./inference-attachment.js";

/** Real controller HTTP; model-node/CUDA and task execution are explicit fixtures. */
export async function managedRecoveryFixture(t: TestContext, options: { rerun?: boolean; heartbeatTtlMs?: number } = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), "hitch-managed-recovery-"));
  const cleanups: Array<() => Promise<unknown>> = [];
  t.after(async () => { try { for (const cleanup of cleanups.reverse()) await cleanup(); } finally { await rm(temporary, { recursive: true, force: true }); } });
  const f = await inferenceAttachmentFixture(temporary);
  const requests: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const access = f.status.access as { port: number; engineToken: string; adminToken: string; wireModel: string };
  const engine = http.createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url !== "/health" && ![access.engineToken, access.adminToken].some(token => req.headers.authorization === `Bearer ${token}`)) {
      res.writeHead(401); res.end(); return;
    }
    if (req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/v1/models" ? { data: [{ id: access.wireModel }] } : req.url === "/server_info" ? f.status.serverInfo : { ok: true })); return;
    }
    let body = ""; for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    assert.equal(JSON.parse(body).model, access.wireModel);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: "fixture answer" }, finish_reason: "stop" }] }));
  });
  const engineUrl = await listen(engine); cleanups.push(() => close(engine));
  access.port = Number(new URL(engineUrl).port); f.client.route = async () => { f.calls.push("route"); return engineUrl; };
  const evalId = `eval_${"c".repeat(32)}`, rerunId = options.rerun ? `rerun_${"d".repeat(32)}` : undefined;
  const runId = `run_${(rerunId ?? evalId).slice((rerunId ? "rerun_" : "eval_").length)}`;
  const prepared = { model: f.input.model, runtime: f.input.runtime, lock: f.input.lock, runtime_cache_hit: true,
    node_observation: { nodeId: f.client.node.nodeId, generation: f.client.node.generation, runtimeDigest: f.input.lock.model_node!.runtime_digest,
      runtime: f.status.runtime, gpuUuids: ["GPU-fixture"], launchers: ["process"], capabilities: { binaryCas: true, durableInferenceProcesses: true } } as never };
  const input: AcquireManagedInferenceInputV1 = { run_id: runId, harness_ref: "training-tool@commit:" + "a".repeat(40),
    cache_scope_owner: rerunId ? `${evalId}:${rerunId}` : evalId, evidence_owner: { kind: "eval", eval_id: evalId, ...(rerunId ? { rerun_id: rerunId } : {}) },
    selection: { model: "local/attachment-fixture", device: "cuda", profile: "baseline", offline: true, inference_id: f.input.lock.inference_id, model_node: f.input.lock.model_node! } };
  const original = new LocalInferenceManager({ root: f.root,
    supervisor: new SGLangServiceSupervisor({ root: f.root, launcher: f.launcher, healthIntervalMs: 60_000 }), preflight: async () => prepared });
  cleanups.push(() => original.close());
  const modelLease = await original.acquire(input);
  const record = (await original.list())[0]!;
  const registry = new RemoteWorkerRegistry({ root: f.root, ...(options.heartbeatTtlMs ? { heartbeatTtlMs: options.heartbeatTtlMs } : {}) });
  const protocol = new RemoteWorkerProtocol({ root: f.root, registry }); await registry.initialize(); await protocol.initialize();
  const resources = { cpu_millis: 1_000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
  const zero = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
  const registration: RemoteWorkerRegistrationV1 = { schema_version: "1", worker_id: "worker_live_model", provider: "remote-docker",
    collision_domain_id: "docker-engine:fixture", platforms: ["linux/amd64"], backends: [{ id: "harbor", version: "fixture" }],
    features: { docker: true, buildkit: false, model_proxy: true, isolated_same_task_attempts: false, managed_model_node: "2", physical_work: "2" },
    task_membership: ["known"], capacity: { total: resources, allocatable: resources, reserved_for_system: zero } };
  const registered = await registry.register(registration);
  const request: EvalRequest = { schema_version: "1", backend: "harbor", dataset: "fixture@1", harness_ref: input.harness_ref,
    model: "", attempts: 1, max_concurrent: 1, infrastructure_retries: 1, infrastructure_retry_backoff_ms: 0,
    timeout_ms: 60_000, setup_timeout_ms: 60_000, agent_args: [], pass_env: [], benchmark_id: "fixture", benchmark_revision: "1" };
  const plan = buildEvalExecutionPlan({ evalId: validateEvalId(evalId), request, tasks: ["one"], workItemMode: "task-slots", maxParallelism: 1,
    candidate: { revisionIdentity: sha256JSON("revision"), artifactId: sha256JSON("artifact") }, provider: registration.provider, trialResources: resources });
  const source = plan.work_items[0]!, work = rerunId ? candidateRestartWorkItem(source, rerunId) : source;
  const evalDirectory = path.join(statePaths(f.root).evals, evalId);
  const lease = await createExecutionLease({ evalDirectory, evalId, workId: work.work_id,
    worker: { workerId: registration.worker_id, provider: registration.provider, collisionDomainId: registration.collision_domain_id },
    reservation: resources, initialState: "offered", ttlMs: 60_000 });
  const target: RemoteModelTargetV2 = { kind: "managed-inference", binding: modelLease.binding, credential: modelLease.credential,
    modelId: modelLease.lock.model_id, maxOutputTokens: modelLease.lock.generation.max_output_tokens };
  const store = new RemoteWorkInputStore(f.root); await store.initialize();
  const spec = { schema_version: "2", plan, work, model_binding: remoteModelBinding(target),
    ...(rerunId ? { physical_execution: { schema_version: "2", kind: "candidate-restart", source_work_id: source.work_id, rerun_id: rerunId } } : {}) };
  const ref = await store.put("work-spec", "json", Buffer.from(JSON.stringify(spec)));
  const offer = await protocol.createOffer(registration.worker_id, lease.current(), work, [ref], [], target);
  const workerServer = http.createServer((request, response) => {
    handleRemoteWorkRoute({ request, response, url: new URL(request.url!, "http://localhost"), registry, protocol, adminToken: "a".repeat(64) })
      .then(handled => { if (!handled) { response.writeHead(404); response.end(); } })
      .catch(error => { if (response.headersSent) { response.destroy(); return; }
        response.writeHead(409, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { code: error.code ?? "fixture-fenced" } })); });
  });
  const baseUrl = await listen(workerServer); cleanups.push(() => close(workerServer));
  const credential = { schema_version: "1" as const, worker_id: registration.worker_id, generation: registered.worker.generation, token: registered.token };
  const worker = new RemoteWorkerHttpClient({ baseUrl, credential });
  const accepted = await worker.accept(offer); await lease.accept(); await lease.markRunning();
  const canonicalRun = `run_${"9".repeat(32)}`, signal = AbortSignal.timeout(30_000);
  await worker.relayModel(accepted, canonicalRun, "bind", null, signal);
  const control = { schema_version: "1", eval_id: evalId, generation: 1, state: "running", requested_parallelism: 1, admitted_parallelism: 1,
    active_leases: [lease.current().lease_id], queued_work_items: [], terminal_work_items: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  await atomicWriteJSON(path.join(evalDirectory, "control.json"), control);
  const serviceDirectory = path.join(statePaths(f.root).inferenceServices, record.service_id);
  const sourceDirectory = rerunId ? path.join(evalDirectory, "reruns", rerunId) : evalDirectory;
  if (rerunId) await atomicWriteJSON(path.join(sourceDirectory, "state.json"), { schema_version: "1", eval_id: evalId, rerun_id: rerunId, status: "running" });
  const protectedFiles = [path.join(serviceDirectory, "attachment.json"), path.join(sourceDirectory, "inference", "execution.json"),
    path.join(statePaths(f.root).workerProtocol, "model-routes", lease.current().lease_id, "route.json"),
    path.join(statePaths(f.root).workerProtocol, "model-routes", lease.current().lease_id, "bound.json")];
  const snapshot = await Promise.all(protectedFiles.map(file => readFile(file)));
  const crash = async () => {
    const saved = await readFile(path.join(serviceDirectory, "state.json"));
    await original.close(); await writeFile(path.join(serviceDirectory, "state.json"), saved); f.calls.length = 0;
  };
  const recovery = new ManagedServiceRecovery(f.root, registry, protocol);
  const resume = async () => {
    const manager = new LocalInferenceManager({ root: f.root, recovery, recoveryPollIntervalMs: 10,
      supervisor: new SGLangServiceSupervisor({ root: f.root, launcher: f.launcher, healthIntervalMs: 60_000 }), preflight: async () => prepared });
    cleanups.push(() => manager.close()); await manager.initialize(); return manager;
  };
  const generate = (client = worker) => client.relayModel(accepted, canonicalRun, "generate", { payload: { messages: [{ role: "user", content: "hello" }] } }, signal);
  const peerConfig = path.join(temporary, "node-peer.json"), peerFile = path.join(temporary, "node-peer.mjs"), peerCalls = path.join(temporary, "node-calls.jsonl");
  const prepareDaemonPeer = async (attachDelayMs = 0) => {
    await writeFile(peerFile, peer);
    await atomicWriteJSON(peerConfig, { status: f.status, node: f.client.node, owner: hitchRootId(f.root), calls: peerCalls, attachDelayMs });
    await atomicWriteJSON(path.join(statePaths(f.root).inferenceNodes, sha256JSON(record.model_node).slice(7) + ".json"), {
      schema_version: "2", binding: record.model_node, connection: { transport: { type: "local" }, python: [process.execPath, peerFile],
        configPath: peerConfig, gateway: { localPort: access.port, nodePort: access.port } } });
  };
  return { ...f, input, prepared, original, record, modelLease, registry, protocol, recovery, accepted, lease, registration, credential,
    worker, control, evalDirectory, sourceDirectory, serviceDirectory, runId, canonicalRun, rerunId, target, signal, requests, bodies,
    crash, resume, generate, prepareDaemonPeer, peerCalls, cleanups,
    verifyOriginal: async () => { for (let i = 0; i < protectedFiles.length; i++) assert.deepEqual(await readFile(protectedFiles[i]!), snapshot[i]); } };
}
async function listen(server: http.Server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`; }
async function close(server: http.Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

const peer = `
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
const file = process.argv[process.argv.indexOf('--config') + 1], config = JSON.parse(readFileSync(file, 'utf8'));
const request = JSON.parse(readFileSync(0, 'utf8')), s = config.status, p = request.payload;
if (JSON.stringify(request.node) !== JSON.stringify(config.node) || p.ownerId !== config.owner || p.inferenceId !== s.inferenceId) process.exit(2);
appendFileSync(config.calls, request.operation + '\\n');
if (request.operation === 'inference.attach') {
  if (p.inputDigest !== s.inputDigest || JSON.stringify(p.expectedHandle) !== JSON.stringify(s.handle)) process.exit(3);
  if (config.attachDelayMs) await new Promise(resolve => setTimeout(resolve, config.attachDelayMs));
} else if (request.operation === 'inference.stop') {
  s.state = 'stopped'; s.resourcesReleased = true; writeFileSync(file, JSON.stringify(config));
} else if (request.operation !== 'inference.inspect') process.exit(4);
process.stdout.write(JSON.stringify({ schemaVersion: 2, requestId: request.requestId, node: request.node, inputDigest: request.inputDigest, result: s }));
`;
