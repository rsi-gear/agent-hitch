import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RemoteWorkerProtocol, RemoteWorkerRegistry } from "../src/control-plane/index.js";
import { sha256Bytes, statePaths } from "../src/foundation/index.js";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";

const ZERO = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
const TOTAL = { cpu_millis: 8_000, memory_bytes: 16 * 1024 ** 3, container_slots: 4, build_slots: 2 };
const RESERVED = { cpu_millis: 1_000, memory_bytes: 1024 ** 3, container_slots: 0, build_slots: 1 };
const ALLOCATABLE = { cpu_millis: 7_000, memory_bytes: 15 * 1024 ** 3, container_slots: 4, build_slots: 1 };

function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "1",
    worker_id: "worker_remote_a",
    provider: "remote-docker",
    collision_domain_id: "docker-engine:remote-a",
    platforms: ["linux/amd64"],
    backends: [{ id: "harbor", version: "0.9.1" }],
    features: { docker: true, buildkit: true, model_proxy: true, isolated_same_task_attempts: false },
    task_membership: ["known"],
    capacity: { total: TOTAL, reserved_for_system: RESERVED, allocatable: ALLOCATABLE },
    ...overrides,
  };
}

function remoteWork(slotCount = 1) {
  const reservation = { cpu_millis: 1_000 * slotCount, memory_bytes: 1024 ** 3 * slotCount, container_slots: slotCount, build_slots: 0 };
  const work = {
    schema_version: "1" as const,
    work_id: `work_${"b".repeat(32)}`,
    eval_id: `eval_${"c".repeat(32)}`,
    backend: "harbor" as const,
    logical_attempt: 1,
    task_ids: ["task-a"],
    slots: [`slot_${"d".repeat(32)}`],
    opaque_membership: false,
    requested_parallelism: 1,
    reservation,
    provider: "remote-docker",
  };
  const lease = {
    schema_version: "1" as const,
    lease_id: `lease_${"e".repeat(32)}`,
    work_id: work.work_id,
    eval_id: work.eval_id,
    worker_id: "worker_remote_a",
    provider: "remote-docker",
    collision_domain_id: "docker-engine:remote-a",
    reservation,
    state: "offered" as const,
    epoch: 1,
    resource_epochs: [1],
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  return { work, lease };
}

test("remote worker registry rotates revocable credentials and fences heartbeat generations", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-workers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new RemoteWorkerRegistry({ root, heartbeatTtlMs: 45_000 });
  await registry.initialize();

  const first = await registry.register(registration());
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.equal(first.worker.generation, 1);
  assert.equal(first.worker.worker.capabilities.remote, true);
  assert.equal(await registry.authenticate("worker_remote_a", first.token), true);
  assert.equal(await registry.authenticate("worker_remote_a", "f".repeat(64)), false);
  const persisted = await readFile(path.join(statePaths(root).workers, "worker_remote_a.json"), "utf8");
  assert.equal(persisted.includes(first.token), false);

  const heartbeat = await registry.heartbeat("worker_remote_a", {
    schema_version: "1",
    generation: 1,
    health: "degraded",
    allocated: { cpu_millis: 2_000, memory_bytes: 2 * 1024 ** 3, container_slots: 1, build_slots: 0 },
    active_leases: [{ lease_id: `lease_${"a".repeat(32)}`, epoch: 2 }],
    sent_at: new Date().toISOString(),
  });
  assert.equal(heartbeat.provider_status.health, "degraded");
  assert.equal(heartbeat.worker.capacity.allocated.container_slots, 1);
  assert.equal(heartbeat.active_leases[0]?.epoch, 2);
  await assert.rejects(registry.heartbeat("worker_remote_a", {
    schema_version: "1", generation: 0, health: "healthy", allocated: ZERO, active_leases: [], sent_at: new Date().toISOString(),
  }), (error: unknown) => (error as { code?: string }).code === "worker_protocol_invalid");

  const offline = await registry.get("worker_remote_a", Date.now() + 46_000);
  assert.equal(offline?.worker.status, "offline");
  assert.equal(offline?.provider_status.health, "unavailable");
  const second = await registry.register(registration());
  assert.equal(second.worker.generation, 2);
  assert.equal(await registry.authenticate("worker_remote_a", first.token), false);
  assert.equal(await registry.authenticate("worker_remote_a", second.token), true);
  await assert.rejects(registry.register(registration({ collision_domain_id: "docker-engine:forged" })),
    (error: unknown) => (error as { code?: string }).code === "worker_identity_conflict");
  const revoked = await registry.revoke("worker_remote_a");
  assert.equal(revoked.worker.status, "offline");
  assert.equal(revoked.generation, 3);
  assert.equal(await registry.authenticate("worker_remote_a", second.token), false);
});

test("remote worker registration rejects inconsistent capacity accounting", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-worker-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new RemoteWorkerRegistry({ root });
  await registry.initialize();
  await assert.rejects(registry.register(registration({
    capacity: { total: TOTAL, reserved_for_system: RESERVED, allocatable: TOTAL },
  })), (error: unknown) => (error as { code?: string }).code === "worker_protocol_invalid");
});

test("remote work protocol fences offers, events, terminal receipts, and release", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-protocol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new RemoteWorkerRegistry({ root });
  const protocol = new RemoteWorkerProtocol({ root, registry });
  await Promise.all([registry.initialize(), protocol.initialize()]);
  await registry.register(registration());
  const { lease, work } = remoteWork(3);
  const offer = await protocol.createOffer("worker_remote_a", lease, work);
  assert.equal(offer.state, "offered");
  await assert.rejects(protocol.createOffer("worker_remote_a", {
    ...lease, lease_id: `lease_${"f".repeat(32)}`, work_id: `work_${"1".repeat(32)}`,
  }, {
    ...work, work_id: `work_${"1".repeat(32)}`,
  }), (error: unknown) => (error as { code?: string }).code === "worker_rejected");
  assert.equal((await protocol.listOffers("worker_remote_a", 1)).length, 1);

  const acceptedAt = new Date().toISOString();
  const accept = {
    schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce, generation: 1,
    accepted: true, sent_at: acceptedAt,
  };
  const accepted = await protocol.acceptOffer("worker_remote_a", accept);
  assert.equal(accepted.state, "accepted");
  await protocol.validateHeartbeatLeases("worker_remote_a", {
    schema_version: "1", generation: 1, health: "healthy", allocated: work.reservation,
    active_leases: [{ lease_id: lease.lease_id, epoch: 1 }], sent_at: new Date().toISOString(),
  });
  await assert.rejects(protocol.validateHeartbeatLeases("worker_remote_a", {
    schema_version: "1", generation: 1, health: "healthy", allocated: work.reservation,
    active_leases: [{ lease_id: `lease_${"a".repeat(32)}`, epoch: 1 }], sent_at: new Date().toISOString(),
  }), (error: unknown) => (error as { code?: string }).code === "worker_protocol_invalid");
  assert.deepEqual(await protocol.acceptOffer("worker_remote_a", accept), accepted);
  await assert.rejects(protocol.acceptOffer("worker_remote_a", { ...accept, nonce: "0".repeat(64) }),
    (error: unknown) => (error as { code?: string }).code === "worker_protocol_replay");

  const event = {
    schema_version: "1", generation: 1, lease_id: lease.lease_id, epoch: 1, sequence: 1,
    type: "worker.started", payload: { pid: 123 }, sent_at: new Date().toISOString(),
  };
  assert.equal((await protocol.recordEvent("worker_remote_a", event)).duplicate, false);
  assert.equal((await protocol.recordEvent("worker_remote_a", event)).duplicate, true);
  await assert.rejects(protocol.recordEvent("worker_remote_a", { ...event, payload: { pid: 456 } }),
    (error: unknown) => (error as { code?: string }).code === "worker_protocol_replay");
  await assert.rejects(protocol.recordEvent("worker_remote_a", { ...event, sequence: 3 }),
    (error: unknown) => (error as { code?: string }).code === "worker_protocol_invalid");

  const artifactBody = Buffer.from("sealed-result-bundle");
  const artifactDigest = sha256Bytes(artifactBody);
  await protocol.uploadArtifact({
    workerId: "worker_remote_a", leaseId: lease.lease_id, generation: 1, epoch: 1,
    digest: artifactDigest, expectedSize: artifactBody.length, body: (async function* () { yield artifactBody; })(),
  });
  const complete = {
    schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce, generation: 1,
    lease_id: lease.lease_id, epoch: 1, status: "succeeded",
    artifacts: [{ kind: "result-bundle", digest: artifactDigest, size: artifactBody.length }],
    sent_at: new Date().toISOString(),
  };
  const completed = await protocol.completeOffer("worker_remote_a", complete);
  assert.equal(completed.state, "completed");
  assert.deepEqual(await protocol.completeOffer("worker_remote_a", complete), completed);
  const release = {
    schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce, generation: 1,
    lease_id: lease.lease_id, epoch: 1, sent_at: new Date().toISOString(),
  };
  const released = await protocol.releaseOffer("worker_remote_a", release);
  assert.equal(released.state, "released");
  assert.deepEqual(await protocol.releaseOffer("worker_remote_a", release), released);
  assert.deepEqual(await protocol.listOffers("worker_remote_a", 1), []);
});

test("daemon remote-worker API separates admin registration from worker heartbeat credentials", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-worker-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = new DaemonServer({ root, port: 0, maxConcurrent: 1, logger: () => {} });
  await server.start();
  t.after(() => server.close());
  const client = await daemonClient(root);
  const registered = await client.request("/v1/workers/register", {
    method: "POST",
    body: JSON.stringify(registration()),
  });
  const token = (registered.credential as { token: string }).token;
  const heartbeatBody = {
    schema_version: "1", generation: 1, health: "healthy", allocated: ZERO,
    active_leases: [], sent_at: new Date().toISOString(),
  };
  const heartbeat = await fetch(`http://127.0.0.1:${server.port}/v1/workers/worker_remote_a/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(heartbeatBody),
  });
  assert.equal(heartbeat.status, 200);
  const unauthorized = await fetch(`http://127.0.0.1:${server.port}/v1/workers/worker_remote_a/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${"f".repeat(64)}`, "content-type": "application/json" },
    body: JSON.stringify(heartbeatBody),
  });
  assert.equal(unauthorized.status, 401);
  const listed = await client.request("/v1/workers");
  const workers = listed.workers as Array<{ worker_id: string; status?: string; capabilities?: { remote: boolean } }>;
  const remote = workers.find((worker) => worker.worker_id === "worker_remote_a");
  assert.equal(remote?.status, "ready");
  assert.equal(remote?.capabilities?.remote, true);
  const inspected = await client.request("/v1/workers/worker_remote_a");
  assert.equal(((inspected.worker as { worker: { provider: string } }).worker.provider), "remote-docker");
  const { lease, work } = remoteWork();
  const created = await client.request("/v1/workers/worker_remote_a/offers", {
    method: "POST", body: JSON.stringify({ lease, work }),
  });
  const offer = created.offer as { offer_id: string; nonce: string };
  const workerHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const polled = await fetch(`http://127.0.0.1:${server.port}/v1/workers/worker_remote_a/offers?generation=1`, { headers: workerHeaders });
  assert.equal(polled.status, 200);
  assert.equal(((await polled.json() as { offers: unknown[] }).offers).length, 1);
  const accepted = await fetch(`http://127.0.0.1:${server.port}/v1/workers/worker_remote_a/offers/${offer.offer_id}/accept`, {
    method: "POST", headers: workerHeaders,
    body: JSON.stringify({ schema_version: "1", nonce: offer.nonce, generation: 1, accepted: true, sent_at: new Date().toISOString() }),
  });
  assert.equal(accepted.status, 200);
  const event = await fetch(`http://127.0.0.1:${server.port}/v1/workers/worker_remote_a/leases/${lease.lease_id}/events`, {
    method: "POST", headers: workerHeaders,
    body: JSON.stringify({ schema_version: "1", generation: 1, epoch: 1, sequence: 1, type: "worker.started", sent_at: new Date().toISOString() }),
  });
  assert.equal(event.status, 201);
  const artifactBody = Buffer.from("api-result-bundle");
  const artifactDigest = sha256Bytes(artifactBody);
  const badUpload = await fetch(`http://127.0.0.1:${server.port}/v1/workers/worker_remote_a/leases/${lease.lease_id}/artifacts/${sha256Bytes("different")}?generation=1&epoch=1`, {
    method: "PUT", headers: workerHeaders, body: artifactBody,
  });
  assert.equal(badUpload.status, 400);
  const uploaded = await fetch(`http://127.0.0.1:${server.port}/v1/workers/worker_remote_a/leases/${lease.lease_id}/artifacts/${artifactDigest}?generation=1&epoch=1`, {
    method: "PUT", headers: workerHeaders, body: artifactBody,
  });
  assert.equal(uploaded.status, 201);
  const completed = await fetch(`http://127.0.0.1:${server.port}/v1/workers/worker_remote_a/offers/${offer.offer_id}/complete`, {
    method: "POST", headers: workerHeaders,
    body: JSON.stringify({
      schema_version: "1", nonce: offer.nonce, generation: 1, lease_id: lease.lease_id, epoch: 1,
      status: "succeeded", artifacts: [{ kind: "result-bundle", digest: artifactDigest, size: artifactBody.length }], sent_at: new Date().toISOString(),
    }),
  });
  assert.equal(completed.status, 200);
  const released = await fetch(`http://127.0.0.1:${server.port}/v1/workers/worker_remote_a/offers/${offer.offer_id}/release`, {
    method: "POST", headers: workerHeaders,
    body: JSON.stringify({ schema_version: "1", nonce: offer.nonce, generation: 1, lease_id: lease.lease_id, epoch: 1, sent_at: new Date().toISOString() }),
  });
  assert.equal(released.status, 200);
  const revoked = await client.request("/v1/workers/worker_remote_a", { method: "DELETE" });
  assert.equal(((revoked.worker as { worker: { status: string } }).worker.status), "offline");
  const afterRevoke = await fetch(`http://127.0.0.1:${server.port}/v1/workers/worker_remote_a/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(heartbeatBody),
  });
  assert.equal(afterRevoke.status, 401);
});
