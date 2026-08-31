import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RemoteWorkerRegistry } from "../src/control-plane/index.js";
import { statePaths } from "../src/foundation/index.js";
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
  const revoked = await client.request("/v1/workers/worker_remote_a", { method: "DELETE" });
  assert.equal(((revoked.worker as { worker: { status: string } }).worker.status), "offline");
  const afterRevoke = await fetch(`http://127.0.0.1:${server.port}/v1/workers/worker_remote_a/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(heartbeatBody),
  });
  assert.equal(afterRevoke.status, 401);
});
