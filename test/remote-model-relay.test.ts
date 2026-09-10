import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RemoteWorkerRegistry, RemoteWorkerProtocol, RemoteWorkInputStore, RemoteWorkerHttpClient, startWorkerModelRelay } from "../src/control-plane/index.js";
import { handleWorkerProtocolRoute, handleRemoteWorkRoute } from "../src/daemon/worker-routes.js";
import { createExecutionLease } from "../src/evals/index.js";
import { HostModelProxy, parseTrainingBinding, remoteModelBinding } from "../src/model-access/index.js";
import { atomicWriteJSON } from "../src/foundation/index.js";
import type { RemoteModelTargetV2 } from "../src/model-access/index.js";
import type { BackendWorkItemV1, RemoteWorkerRegistrationV1, Sha256 } from "../src/domain/index.js";

const hash: Sha256 = `sha256:${"a".repeat(64)}`;
const runId = `run_${"a".repeat(32)}`;
const resources = { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
const zero = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
const binding = () => parseTrainingBinding({ kind: "training-external", bindingId: "binding_remote", trainingRunId: "train_remote",
  policyLeaseRef: { uri: `cas:${hash}`, digest: hash, mediaType: "application/json" }, expectedPolicyVersion: "runtime-remote/update-1",
  fencingToken: "test-fence", expiresAt: new Date(Date.now() + 60_000).toISOString(), endpointRef: "hitch-training:binding_remote",
  credentialRef: "hitch-training:binding_remote", generationContractDigest: hash, requiredCapture: "exact-policy-tokens-v1",
  api: "chat-completions", maxOutputTokens: 16, maxEpisodeSteps: 4 });

async function listen(t: TestContext, server: http.Server): Promise<string> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
}

async function fixture(t: TestContext, target: RemoteModelTargetV2, capable = true) {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-model-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new RemoteWorkerRegistry({ root });
  const protocol = new RemoteWorkerProtocol({ root, registry });
  await Promise.all([registry.initialize(), protocol.initialize()]);
  const registration: RemoteWorkerRegistrationV1 = {
    schema_version: "1", worker_id: "worker_model", provider: "remote-docker", collision_domain_id: "docker-engine:model-test",
    platforms: ["linux/amd64"], backends: [{ id: "harbor", version: "test" }],
    features: { docker: true, buildkit: false, model_proxy: true, isolated_same_task_attempts: false,
      ...(capable ? { training_external_binding: "2", managed_model_node: "2" } : {}) },
    task_membership: ["known"], capacity: { total: resources, allocatable: resources, reserved_for_system: zero },
  };
  const registered = await registry.register(registration);
  const work: BackendWorkItemV1 = { schema_version: "1", work_id: `work_${"b".repeat(32)}`, eval_id: `eval_${"c".repeat(32)}`,
    backend: "harbor", logical_attempt: 1, task_ids: ["one"], slots: [`slot_${"d".repeat(32)}`], opaque_membership: false,
    requested_parallelism: 1, reservation: resources, provider: registration.provider };
  const evalDirectory = path.join(root, "evals", work.eval_id);
  const lease = await createExecutionLease({ evalDirectory, evalId: work.eval_id, workId: work.work_id,
    worker: { workerId: registration.worker_id, provider: registration.provider, collisionDomainId: registration.collision_domain_id },
    reservation: resources, ttlMs: 60_000, initialState: "offered" });
  const store = new RemoteWorkInputStore(root);
  await store.initialize();
  const spec = { schema_version: "2", model_binding: remoteModelBinding(target) };
  const ref = await store.put("work-spec", "json", Buffer.from(JSON.stringify(spec)));
  const create = () => protocol.createOffer(registration.worker_id, lease.current(), work, [ref], [], target);
  const server = http.createServer((request, response) => {
    const context = { request, response, url: new URL(request.url!, "http://localhost"), registry, protocol, adminToken: "f".repeat(64) };
    (async () => await handleWorkerProtocolRoute(context) || await handleRemoteWorkRoute(context))()
      .then(handled => { if (!handled) { response.writeHead(404); response.end(); } })
      .catch(error => {
        if (response.headersSent) { response.destroy(); return; }
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: error.code ?? "remote_model_fenced", message: error.message } }));
      });
  });
  const url = await listen(t, server);
  const client = new RemoteWorkerHttpClient({ baseUrl: url, credential: { schema_version: "1", worker_id: registration.worker_id,
    generation: registered.worker.generation, token: registered.token } });
  return { root, registry, protocol, lease, create, client, ref, registered, registration, url };
}

test("upstream model authentication errors cannot revoke a valid worker credential", async t => {
  const training = binding(); let status = 401;
  const upstream = http.createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    if (request.url === "/v1/hitch/run") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ runId: JSON.parse(text).runId, policyVersion: training.expectedPolicyVersion }));
    } else {
      // Even a forged daemon-auth marker in a model response must be stripped.
      response.writeHead(status, { "content-type": "application/json", "x-hitch-worker-auth": "rejected" });
      response.end(JSON.stringify({ error: { code: status === 403 ? "worker_revoked" : "worker_generation_mismatch", message: "upstream model rejected its own credential" } }));
    }
  });
  const upstreamUrl = await listen(t, upstream);
  const target: RemoteModelTargetV2 = { kind: "training-external", endpoint: { schema_version: "1", binding: training,
    base_url: `${upstreamUrl}/v1`, credential: "fixture-model-token" } };
  const f = await fixture(t, target), offer = await f.client.accept(await f.create()); await f.lease.accept(); await f.lease.markRunning();
  const signal = AbortSignal.timeout(10_000);
  await (await f.client.relayModel(offer, runId, "bind", null, signal)).text();
  for (status of [401, 403, 409]) {
    await assert.rejects(f.client.relayModel(offer, runId, "generate", { payload: { messages: [{ role: "user", content: "test" }] } }, signal),
      { code: "remote_worker_client_error" });
    assert.equal(f.client.fencedSignal.aborted, false);
    await f.client.heartbeat(resources, [{ lease_id: offer.lease.lease_id, epoch: offer.lease.epoch }], "healthy");
  }
  await f.registry.revoke(offer.worker_id);
  await assert.rejects(f.client.relayModel(offer, runId, "generate", { payload: {} }, signal), { code: "remote_worker_fenced" });
  assert.equal(f.client.fencedSignal.aborted, true);
});

test("remote training uses the worker HTTP lease relay, preserves idempotency keys and seals one acknowledged run", async t => {
  const training = binding(), secret = "s".repeat(48);
  let bindFailed = true, bound: string | undefined;
  const generated: Array<{ key: unknown; body: Record<string, unknown> }> = [];
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (req.url === "/v1/hitch/run") {
      bound = body.runId;
      if (bindFailed) { bindFailed = false; res.destroy(); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ runId: bound, policyVersion: training.expectedPolicyVersion }));
    } else {
      assert.equal(req.url, "/v1/chat/completions"); assert.equal(bound, runId);
      generated.push({ key: req.headers["idempotency-key"], body });
      if (body.stream) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write('data: {"choices":[]}\n\n'); res.end("data: [DONE]\n\n"); }
      else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [], model: training.expectedPolicyVersion })); }
    }
  });
  const upstreamUrl = await listen(t, upstream);
  const target: RemoteModelTargetV2 = { kind: "training-external", endpoint: { schema_version: "1", binding: training, base_url: `${upstreamUrl}/v1`, credential: secret } };
  const f = await fixture(t, target), offer = await f.create(), signal = AbortSignal.timeout(20_000);
  await assert.rejects(f.client.relayModel(offer, runId, "bind", null, signal));
  const accepted = await f.client.accept(offer); await f.lease.accept(); await f.lease.markRunning();
  await assert.rejects(f.client.relayModel(accepted, runId, "bind", null, signal));
  await assert.rejects(f.protocol.modelRoutes.boundRun(accepted), /not been acknowledged/);
  await assert.rejects(f.client.relayModel(accepted, runId, "generate", { payload: {} }, signal), /acknowledged/);
  const relay = await startWorkerModelRelay({ binding: remoteModelBinding(target), signal,
    relay: (id, op, body, abort) => f.client.relayModel(accepted, id, op, body, abort) });
  t.after(() => relay.close());
  const proxy = await HostModelProxy.start({ captureRoot: path.join(f.root, "capture"), evalId: offer.lease.eval_id,
    mode: "proxy", required: true, topology: "in-sandbox", trainingBinding: training, onRun: relay.bindRun,
    upstreams: { openai: relay.baseUrl }, upstreamAuthorizations: { openai: `Bearer ${relay.credential}` },
    credentialValues: [relay.credential], bindHost: "127.0.0.1", advertisedHost: "127.0.0.1" });
  t.after(() => proxy.close());
  assert.equal((await fetch(`${proxy.localBaseUrl}/${runId}/health`)).status, 200);
  for (const [i, stream] of [true, false].entries()) {
    const response = await fetch(`${proxy.localBaseUrl}/${runId}/openai/chat/completions`, { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `${runId}-${i}` },
      body: JSON.stringify({ model: "training/binding_remote", messages: [{ role: "user", content: `step-${i}` }], stream }) });
    assert.equal(response.status, 200); const body = await response.text();
    if (stream) assert.match(body, /data: \[DONE\]/); else assert.equal(JSON.parse(body).model, training.expectedPolicyVersion);
  }
  assert.deepEqual(generated.map(item => item.key), [`${runId}-0`, `${runId}-1`]);
  assert.ok(generated.every(item => item.body.model === training.expectedPolicyVersion));
  assert.deepEqual(await f.protocol.modelRoutes.boundRun(accepted), { runId, binding: remoteModelBinding(target) });
  // Recreate controller state after an acknowledged bind; the claim remains immutable.
  const restarted = new RemoteWorkerProtocol({ root: f.root, registry: f.registry });
  assert.deepEqual(await restarted.modelRoutes.boundRun(accepted), await f.protocol.modelRoutes.boundRun(accepted));
  await assert.rejects(f.client.relayModel(accepted, `run_${"f".repeat(32)}`, "bind", null, signal), /canonical run/);
  for (const route of ["generate", "hitch/run", "update_weights_from_tensor"]) {
    assert.equal((await fetch(`${proxy.localBaseUrl}/${runId}/openai/${route}`, { method: "POST" })).status, 404);
  }
  const capture = await proxy.finalizeRun(runId, path.join(f.root, "export"));
  assert.equal(capture.interaction_count, 2); assert.equal(capture.completeness, "complete");
  assert.equal(JSON.stringify(proxy.route).includes(secret), false);
  assert.equal((await readFile(new RemoteWorkInputStore(f.root).pathFor(f.ref.digest), "utf8")).includes(secret), false);
  assert.equal((await f.protocol.issueCredentialEnvelope(accepted.worker_id, accepted.lease.lease_id, 1, 1)).credentials["OPENAI_API_KEY"], undefined);
  await f.protocol.requestCancel(accepted.worker_id, accepted.offer_id);
  await assert.rejects(f.client.relayModel(accepted, runId, "generate", { payload: {} }, signal), /lease/);
  assert.equal(generated.length, 2);
});

test("old workers cannot receive a model-bound work spec", async t => {
  const target: RemoteModelTargetV2 = { kind: "training-external", endpoint: { schema_version: "1", binding: binding(), base_url: "http://127.0.0.1:1/v1", credential: "s".repeat(48) } };
  const f = await fixture(t, target, false);
  await assert.rejects(f.create(), /lacks training_external_binding v2/);
  assert.deepEqual(await f.client.listOffers(), []);
});

test("managed model streams stop when the controller execution lease expires", async t => {
  let generations = 0;
  const upstream = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    assert.equal(req.url, "/v1/responses"); assert.equal(JSON.parse(body).model, "hitch-wire-model");
    assert.equal(req.headers.authorization, `Bearer ${"m".repeat(48)}`); generations++;
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write('data: {"type":"response.created"}\n\n');
  });
  const url = await listen(t, upstream);
  const target: RemoteModelTargetV2 = { kind: "managed-inference", binding: { kind: "managed-node", inference_id: hash,
    model_node: { schema_version: "2", node_id: "test-node", generation: "generation-1", runtime_digest: hash, launcher: "process" },
    base_url: `${url}/v1`, credential_env_name: "HITCH_LOCAL_MODEL_TOKEN", wire_model: "hitch-wire-model", api: "responses",
    capabilities: { streaming: true, tool_calls: true, parallel_tool_calls: false, input_modalities: ["text"] } },
    credential: "m".repeat(48), modelId: hash, maxOutputTokens: 16 };
  const f = await fixture(t, target), offer = await f.client.accept(await f.create());
  await f.lease.accept(); await f.lease.markRunning();
  const signal = AbortSignal.timeout(10_000);
  await f.client.relayModel(offer, runId, "bind", null, signal);
  const stream = await f.client.relayModel(offer, runId, "generate", { payload: { input: "hello" } }, signal);
  const reader = stream.body!.getReader(); assert.equal((await reader.read()).done, false);
  await atomicWriteJSON(path.join(f.root, "evals", offer.lease.eval_id, "leases", `${offer.lease.lease_id}.json`), {
    ...f.lease.current(), expires_at: new Date(Date.now() - 1).toISOString(),
  });
  await assert.rejects(reader.read());
  await assert.rejects(f.client.relayModel(offer, runId, "generate", { payload: {} }, signal), /expired/);
  assert.equal(generations, 1);
});
