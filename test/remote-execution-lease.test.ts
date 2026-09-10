import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RemoteWorkerRegistry, RemoteWorkerProtocol, RemoteWorkerHttpClient } from "../src/control-plane/index.js";
import { handleRemoteWorkRoute } from "../src/daemon/worker-routes.js";
import { createExecutionLease } from "../src/evals/index.js";
import { atomicWriteJSON } from "../src/foundation/index.js";
import type { BackendWorkItemV1 } from "../src/domain/index.js";
import { forceRemove } from "../test-support/helpers.js";

test("execution lease grants read current controller authority and fence cancellation, drift and stale generations", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-execution-grant-")); t.after(() => forceRemove(root));
  const registry = new RemoteWorkerRegistry({ root }), protocol = new RemoteWorkerProtocol({ root, registry });
  await registry.initialize(); await protocol.initialize();
  const reservation = { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
  const registration = { schema_version: "1", worker_id: "worker_grant", provider: "remote-docker", collision_domain_id: "grant-engine",
    platforms: ["linux/amd64"], backends: [{ id: "harbor", version: "0.21.0" }],
    features: { docker: true, buildkit: false, model_proxy: false, isolated_same_task_attempts: false }, task_membership: ["known"],
    capacity: { total: reservation, allocatable: reservation, reserved_for_system: { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 } } };
  const registered = await registry.register(registration);
  const work: BackendWorkItemV1 = { schema_version: "1", work_id: `work_${"a".repeat(32)}`, eval_id: `eval_${"b".repeat(32)}`,
    backend: "harbor", provider: registration.provider, logical_attempt: 1, task_ids: ["one"], slots: [`slot_${"c".repeat(32)}`],
    opaque_membership: false, requested_parallelism: 1, reservation };
  const evalDirectory = path.join(root, "evals", work.eval_id);
  const owner = await createExecutionLease({ evalDirectory, evalId: work.eval_id, workId: work.work_id, reservation, initialState: "offered", ttlMs: 60_000,
    worker: { workerId: registration.worker_id, provider: registration.provider, collisionDomainId: registration.collision_domain_id } });
  const offer = await protocol.createOffer(registration.worker_id, owner.current(), work);
  const server = http.createServer((request, response) => {
    void handleRemoteWorkRoute({ request, response, url: new URL(request.url!, "http://localhost"), registry, protocol, adminToken: "f".repeat(64) })
      .then(handled => { if (!handled) { response.writeHead(404); response.end(); } }).catch(error => {
        response.writeHead(409, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { code: error.code, message: error.message } }));
      });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const credential = { schema_version: "1" as const, worker_id: registration.worker_id, generation: registered.worker.generation, token: registered.token };
  const client = new RemoteWorkerHttpClient({ baseUrl, credential }), signal = new AbortController().signal;
  await assert.rejects(client.executionLease(offer, signal), /no accepted offer/);
  const accepted = await client.accept(offer);
  assert.equal((await client.executionLease(accepted, signal)).state, "offered", "accepted offer authorizes the controller admission handoff");
  await owner.accept(); await owner.markRunning();
  const first = await client.executionLease(accepted, signal); assert.equal(first.state, "running");
  await owner.heartbeat();
  const renewed = await client.executionLease(accepted, signal);
  assert.equal(renewed.expires_at, owner.current().expires_at); assert.ok(Date.parse(renewed.expires_at) >= Date.parse(first.expires_at));
  assert.equal(offer.lease.expires_at, accepted.lease.expires_at, "reading current authority never rewrites the frozen offer");
  const url = `${baseUrl}/v1/workers/${credential.worker_id}/leases/${owner.leaseId}/execution?generation=${credential.generation}&epoch=${first.epoch}`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${credential.token}` } });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(url)).status, 401);
  const leaseFile = path.join(evalDirectory, "leases", `${owner.leaseId}.json`), saved = owner.current();
  for (const change of [{ epoch: saved.epoch + 1 }, { expires_at: new Date(Date.now() - 1).toISOString() },
    { reservation: { ...reservation, cpu_millis: 2000 } }, { resource_epochs: [saved.epoch + 1] }, { state: "released", released_at: new Date().toISOString() }]) {
    await atomicWriteJSON(leaseFile, { ...saved, ...change }); await assert.rejects(client.executionLease(accepted, signal));
  }
  await atomicWriteJSON(leaseFile, saved);
  await protocol.requestCancel(credential.worker_id, accepted.offer_id);
  await assert.rejects(client.executionLease(accepted, signal), /no longer active/);
  await registry.register(registration);
  await assert.rejects(client.executionLease(accepted, signal));
});
