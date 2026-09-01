import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RemoteWorkInputStore,
  RemoteWorkerHttpClient,
  RemoteWorkerRunner,
} from "../src/control-plane/index.js";
import type { RemoteWorkInputRefV1, RemoteWorkOfferV1 } from "../src/domain/index.js";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import { statePaths } from "../src/foundation/index.js";

const ZERO = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
const CAPACITY = { cpu_millis: 2_000, memory_bytes: 2 * 1024 ** 3, container_slots: 2, build_slots: 1 };

test("remote worker client redacts its bearer credential from transport failures", async () => {
  const token = "a".repeat(64);
  const client = new RemoteWorkerHttpClient({
    baseUrl: "http://127.0.0.1:1",
    credential: { schema_version: "1", worker_id: "worker_packaged", generation: 1, token },
    request: async () => { throw new Error(`transport failed with Authorization: Bearer ${token}`); },
  });
  await assert.rejects(client.listOffers(), (error: unknown) => {
    assert.equal((error as Error).message.includes(token), false);
    assert.match((error as Error).message, /\[REDACTED\]/);
    return true;
  });
});

test("packaged remote worker client and runner complete the HTTP offer lifecycle", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-worker-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = "remote-envelope-value-must-not-persist";
  const server = new DaemonServer({
    root, port: 0, maxConcurrent: 1, logger: () => {}, credentialEnv: { CUSTOM_REMOTE_SECRET: secret },
  });
  await server.start();
  t.after(() => server.close());
  const adminToken = (await readFile(statePaths(root).token, "utf8")).trim();
  const registration = workerRegistration();
  const credential = await RemoteWorkerHttpClient.register({
    baseUrl: `http://127.0.0.1:${server.port}`,
    adminToken,
    registration,
  });
  assert.equal(credential.worker_id, registration.worker_id);
  assert.equal(credential.generation, 1);
  assert.equal(JSON.stringify(credential).includes(adminToken), false);
  const client = new RemoteWorkerHttpClient({ baseUrl: `http://127.0.0.1:${server.port}`, credential });
  const inputs = await stagedInputs(root);
  const { lease, work } = remoteWork("1");
  const admin = await daemonClient(root);
  const created = await admin.request(`/v1/workers/${registration.worker_id}/offers`, {
    method: "POST", body: JSON.stringify({ lease, work, inputs, credential_names: ["CUSTOM_REMOTE_SECRET"] }),
  });
  const offered = created.offer as RemoteWorkOfferV1;
  const received = new Map<RemoteWorkInputRefV1["kind"], Buffer>();
  let executions = 0;
  const runner = new RemoteWorkerRunner({
    client, capacity: registration.capacity.allocatable, once: true,
    pollIntervalMs: 50, heartbeatIntervalMs: 50, retryIntervalMs: 50,
    execute: async ({ offer, inputs: downloaded, credentials, emit }) => {
      executions += 1;
      assert.equal(offer.offer_id, offered.offer_id);
      assert.equal(credentials.get("CUSTOM_REMOTE_SECRET"), secret);
      for (const [kind, body] of downloaded) received.set(kind, body);
      await emit("worker.test", { accepted: true });
      return { status: "succeeded", artifacts: [{ kind: "diagnostic", body: Buffer.from("sealed-diagnostic") }] };
    },
  });
  const running = runner.run();
  const completed = await waitFor(async () => (await client.listOffers()).find((offer) => offer.offer_id === offered.offer_id && offer.state === "completed"));
  assert.equal(executions, 1);
  assert.deepEqual(new Set(received.keys()), new Set(["work-spec", "harness-artifact", "controller-runtime", "task-input"]));
  assert.equal(received.get("work-spec")?.toString(), '{"schema_version":"1"}\n');
  const inspectedWhileCompleted = await admin.request(`/v1/workers/${registration.worker_id}`);
  assert.deepEqual((inspectedWhileCompleted.worker as { active_leases: unknown[] }).active_leases, [{ lease_id: lease.lease_id, epoch: 1 }]);
  await admin.request(`/v1/workers/${registration.worker_id}/offers/${completed.offer_id}/release-request`, { method: "POST" });
  await running;
  assert.equal(executions, 1);
  const inspected = await admin.request(`/v1/workers/${registration.worker_id}`);
  const record = inspected.worker as { active_leases: unknown[]; worker: { capacity: { allocated: typeof ZERO } } };
  assert.deepEqual(record.active_leases, []);
  assert.deepEqual(record.worker.capacity.allocated, ZERO);
  const persisted = await readFile(path.join(statePaths(root).workers, `${registration.worker_id}.json`), "utf8");
  assert.equal(persisted.includes(credential.token), false, "the bearer token must never be persisted in plaintext");
  for (const file of await regularFiles(root)) {
    assert.equal((await readFile(file)).includes(Buffer.from(secret)), false, `credential envelope leaked into ${path.relative(root, file)}`);
  }
});

test("a restarted runner does not execute an already accepted offer again", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-worker-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = new DaemonServer({ root, port: 0, maxConcurrent: 1, logger: () => {} });
  await server.start();
  t.after(() => server.close());
  const adminToken = (await readFile(statePaths(root).token, "utf8")).trim();
  const registration = workerRegistration();
  const credential = await RemoteWorkerHttpClient.register({ baseUrl: `http://127.0.0.1:${server.port}`, adminToken, registration });
  const client = new RemoteWorkerHttpClient({ baseUrl: `http://127.0.0.1:${server.port}`, credential });
  const { lease, work } = remoteWork("2");
  const admin = await daemonClient(root);
  const created = await admin.request(`/v1/workers/${registration.worker_id}/offers`, {
    method: "POST", body: JSON.stringify({ lease, work, inputs: await stagedInputs(root) }),
  });
  const offer = created.offer as RemoteWorkOfferV1;
  const accepted = await client.accept(offer);
  assert.equal(accepted.state, "accepted");
  let executions = 0;
  const restarted = new RemoteWorkerRunner({
    client, capacity: registration.capacity.allocatable,
    execute: async () => { executions += 1; return { status: "failed" }; },
    pollIntervalMs: 50, heartbeatIntervalMs: 50, retryIntervalMs: 50,
  });
  await restarted.tick();
  assert.equal(executions, 0, "accepted work without a local durable job must remain ambiguous, not be rerun");
  const inspected = await admin.request(`/v1/workers/${registration.worker_id}`);
  assert.deepEqual((inspected.worker as { active_leases: unknown[] }).active_leases, []);
});

test("executor setup failure remains ownership-releasable", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-worker-setup-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = "remote-setup-failure-secret-must-be-redacted";
  const server = new DaemonServer({ root, port: 0, maxConcurrent: 1, logger: () => {}, credentialEnv: { CUSTOM_REMOTE_SECRET: secret } });
  await server.start();
  t.after(() => server.close());
  const adminToken = (await readFile(statePaths(root).token, "utf8")).trim();
  const registration = workerRegistration();
  const credential = await RemoteWorkerHttpClient.register({ baseUrl: `http://127.0.0.1:${server.port}`, adminToken, registration });
  const client = new RemoteWorkerHttpClient({ baseUrl: `http://127.0.0.1:${server.port}`, credential });
  const { lease, work } = remoteWork("3");
  const admin = await daemonClient(root);
  const created = await admin.request(`/v1/workers/${registration.worker_id}/offers`, {
    method: "POST", body: JSON.stringify({ lease, work, inputs: await stagedInputs(root), credential_names: ["CUSTOM_REMOTE_SECRET"] }),
  });
  const offered = created.offer as RemoteWorkOfferV1;
  let recovered = 0;
  const runner = new RemoteWorkerRunner({
    client, capacity: registration.capacity.allocatable, once: true,
    pollIntervalMs: 50, heartbeatIntervalMs: 50, retryIntervalMs: 50,
    execute: async ({ credentials }) => { throw new Error(`proxy setup failed with ${credentials.get("CUSTOM_REMOTE_SECRET")}`); },
    releaseUnknown: async (offer) => {
      assert.equal(offer.offer_id, offered.offer_id);
      recovered += 1;
    },
  });
  const running = runner.run();
  const completed = await waitFor(async () => (await client.listOffers()).find((offer) => offer.offer_id === offered.offer_id && offer.state === "completed"));
  assert.equal(completed.terminal?.status, "failed");
  await admin.request(`/v1/workers/${registration.worker_id}/offers/${completed.offer_id}/release-request`, { method: "POST" });
  await running;
  assert.equal(recovered, 1);
  assert.equal((await client.listOffers()).length, 0);
  for (const file of await regularFiles(root)) {
    assert.equal((await readFile(file)).includes(Buffer.from(secret)), false, `executor diagnostic leaked credential into ${path.relative(root, file)}`);
  }
});

function workerRegistration() {
  return {
    schema_version: "1" as const, worker_id: "worker_packaged", provider: "remote-docker",
    collision_domain_id: "docker-engine:packaged", platforms: [`${process.platform}-${process.arch}`],
    backends: [{ id: "harbor", version: "test" }],
    features: { docker: true, buildkit: true, model_proxy: false, isolated_same_task_attempts: false },
    task_membership: ["known" as const],
    capacity: { total: CAPACITY, reserved_for_system: ZERO, allocatable: CAPACITY },
  };
}

function remoteWork(suffix: string) {
  const work = {
    schema_version: "1" as const, work_id: `work_${suffix.repeat(32)}`, eval_id: `eval_${suffix.repeat(32)}`,
    backend: "harbor" as const, logical_attempt: 1, task_ids: ["task-a"], slots: [`slot_${suffix.repeat(32)}`],
    opaque_membership: false, requested_parallelism: 1,
    reservation: { cpu_millis: 1_000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 }, provider: "remote-docker",
  };
  return { work, lease: {
    schema_version: "1" as const, lease_id: `lease_${suffix.repeat(32)}`, work_id: work.work_id, eval_id: work.eval_id,
    worker_id: "worker_packaged", provider: "remote-docker", collision_domain_id: "docker-engine:packaged",
    reservation: work.reservation, state: "offered" as const, epoch: 1, resource_epochs: [1],
    issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
  } };
}

async function regularFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await regularFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

async function stagedInputs(root: string): Promise<RemoteWorkInputRefV1[]> {
  const store = new RemoteWorkInputStore(root);
  await store.initialize();
  return Promise.all([
    store.put("work-spec", "json", Buffer.from('{"schema_version":"1"}\n')),
    store.put("harness-artifact", "hitch-tree-v1", Buffer.from('{"schema_version":"1","files":[]}\n')),
    store.put("controller-runtime", "hitch-tree-v1", Buffer.from('{"schema_version":"1","files":[]}\n')),
    store.put("task-input", "hitch-tree-v1", Buffer.from('{"schema_version":"1","files":[]}\n')),
  ]);
}

async function waitFor<T>(operation: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await operation();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for remote worker state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
