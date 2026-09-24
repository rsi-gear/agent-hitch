import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RemoteWorkInputStore, RemoteWorkerProtocol, RemoteWorkerRegistry, recoverRemoteWorkerEvalLeases } from "../src/control-plane/index.js";
import { assertRemoteLeaseRelease, createExecutionLease, heartbeatExecutionLease, parseExecutionLease, readExecutionLeases } from "../src/evals/index.js";
import { sha256Bytes, statePaths } from "../src/foundation/index.js";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import type { EvalId } from "../src/domain/index.js";
import { resourceFixture } from "../test-support/resource-fixture.js";
import { auditResources, confirmResourceResultSealed, createResourceDelivery, materializeResourceTask, preflightResourceTask, reclaimResourceExecution, sealResourceEvidence, selectResources, hash, receiveResourceDelivery, ResourceStore } from "../src/resources/index.js";
import { FixtureImageProvider } from "../test-support/resource-fixture.js";
import { RemoteWorkerHttpClient } from "../src/control-plane/index.js";

const ZERO = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
const TOTAL = { cpu_millis: 8_000, memory_bytes: 16 * 1024 ** 3, container_slots: 4, build_slots: 2 };
const RESERVED = { cpu_millis: 1_000, memory_bytes: 1024 ** 3, container_slots: 0, build_slots: 1 };
const ALLOCATABLE = { cpu_millis: 7_000, memory_bytes: 15 * 1024 ** 3, container_slots: 4, build_slots: 1 };

test("resource offers fence old workers and authorize only objects in the leased delivery", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-remote-resources-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, dataset } = await resourceFixture(directory, 1), root = store.root;
  const registry = new RemoteWorkerRegistry({ root }), protocol = new RemoteWorkerProtocol({ root, registry }), inputs = new RemoteWorkInputStore(root);
  await Promise.all([registry.initialize(), protocol.initialize(), inputs.initialize()]);
  await registry.register(registration());
  const delivery = await createResourceDelivery(store, selectResources(dataset, ['task-0']), 'remote-test', 1);
  const refs = [await inputs.put('work-spec', 'json', Buffer.from(JSON.stringify({ schema_version: '3', resource_delivery: delivery.digest }))), await inputs.put('task-input', 'hitch-resource-delivery-v1', Buffer.from(JSON.stringify(delivery)))];
  const { lease, work } = remoteWork(); work.task_ids = ['task-0'];
  await assert.rejects(protocol.createOffer('worker_remote_a', lease, work, refs), /benchmark_resources/);
  assert.equal((await protocol.listOffers('worker_remote_a', 1)).length, 0);
  const registered = await registry.register(registration({ features: { docker: true, buildkit: true, model_proxy: true, isolated_same_task_attempts: false, benchmark_resources: '1' } }));
  const offer = await protocol.createOffer('worker_remote_a', lease, work, refs);
  const item = delivery.objects[0]!, verified = await protocol.resolveInput('worker_remote_a', lease.lease_id, offer.generation, item.digest);
  assert.equal(sha256Bytes(await readFile(verified.path)), item.digest);
  await assert.rejects(protocol.resolveInput('worker_remote_a', lease.lease_id, offer.generation, hash('unrelated private object')), /not authorized/);
  await assert.rejects(protocol.resolveInput('worker_remote_a', lease.lease_id, offer.generation - 1, item.digest), /generation/);
  let transferredObjects = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${registered.token}`) { response.writeHead(401).end(); return; }
      const url = new URL(request.url!, 'http://localhost');
      const requested = url.pathname.split('/').at(-1) as `sha256:${string}`;
      const resource = await protocol.resolveInput('worker_remote_a', lease.lease_id, Number(url.searchParams.get('generation')), requested);
      transferredObjects++; response.writeHead(200, { 'content-length': resource.size }); createReadStream(resource.path).pipe(response);
    } catch { response.writeHead(403).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as {port:number}, client = new RemoteWorkerHttpClient({ baseUrl: `http://127.0.0.1:${address.port}`, credential: { schema_version:'1', worker_id:'worker_remote_a', generation:offer.generation, token:registered.token } });
  const receiver = new ResourceStore(path.join(directory, 'receiver'), {images:new FixtureImageProvider(),limits:{minFreeBytes:0}});
  const reader = (entry: {digest:`sha256:${string}`;size:number}) => client.streamResource(offer, entry);
  assert.equal((await receiveResourceDelivery(receiver, delivery, reader, 'worker-test', 1)).missingObjects, delivery.objects.length);
  assert.equal((await receiveResourceDelivery(receiver, delivery, reader, 'worker-test', 1)).transferredBytes, 0);
  assert.equal(transferredObjects, delivery.objects.length);
});

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

test("remote worker capacity accounting preserves GPU availability", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-worker-gpu-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new RemoteWorkerRegistry({ root });
  await registry.initialize();
  const registered = await registry.register(registration({
    capacity: {
      total: { ...TOTAL, gpu_count: 2 },
      reserved_for_system: { ...RESERVED, gpu_count: 0 },
      allocatable: { ...ALLOCATABLE, gpu_count: 2 },
    },
  }));
  const heartbeat = await registry.heartbeat("worker_remote_a", {
    schema_version: "1", generation: registered.worker.generation, health: "healthy",
    allocated: { ...ZERO, gpu_count: 1 }, active_leases: [], sent_at: new Date().toISOString(),
  });
  assert.equal(heartbeat.worker.capacity.total.gpu_count, 2);
  assert.equal(heartbeat.worker.capacity.allocated.gpu_count, 1);
  assert.equal(heartbeat.provider_status.capacity.allocatable.gpu_count, 2);
});

test("remote worker capacity accounting preserves ephemeral disk availability", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-worker-disk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new RemoteWorkerRegistry({ root });
  await registry.initialize();
  const registered = await registry.register(registration({
    capacity: {
      total: { ...TOTAL, ephemeral_disk_bytes: 100 * 1024 ** 3 },
      reserved_for_system: { ...RESERVED, ephemeral_disk_bytes: 20 * 1024 ** 3 },
      allocatable: { ...ALLOCATABLE, ephemeral_disk_bytes: 80 * 1024 ** 3 },
    },
  }));
  const heartbeat = await registry.heartbeat("worker_remote_a", {
    schema_version: "1", generation: registered.worker.generation, health: "healthy",
    allocated: { ...ZERO, ephemeral_disk_bytes: 30 * 1024 ** 3 }, active_leases: [], sent_at: new Date().toISOString(),
  });
  assert.equal(heartbeat.worker.capacity.total.ephemeral_disk_bytes, 100 * 1024 ** 3);
  assert.equal(heartbeat.worker.capacity.allocated.ephemeral_disk_bytes, 30 * 1024 ** 3);
  assert.equal(heartbeat.provider_status.capacity.allocatable.ephemeral_disk_bytes, 80 * 1024 ** 3);
  assert.equal(heartbeat.provider_status.capacity.allocated.ephemeral_disk_bytes, 30 * 1024 ** 3);
});

test("remote work protocol fences offers, events, terminal receipts, and release", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-protocol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new RemoteWorkerRegistry({ root });
  const secret = "lease-fenced-remote-secret";
  const protocol = new RemoteWorkerProtocol({
    root, registry, credentialEnvelopeTtlMs: 5_000, credentialEnv: { CUSTOM_REMOTE_SECRET: secret },
  });
  await Promise.all([registry.initialize(), protocol.initialize()]);
  await registry.register(registration());
  const { lease, work } = remoteWork(3);
  const offer = await protocol.createOffer("worker_remote_a", lease, work, [], ["CUSTOM_REMOTE_SECRET"]);
  assert.equal(offer.state, "offered");
  assert.deepEqual(offer.credential_names, ["CUSTOM_REMOTE_SECRET"]);
  assert.equal(JSON.stringify(offer).includes(secret), false);
  await assert.rejects(protocol.issueCredentialEnvelope("worker_remote_a", lease.lease_id, 1, 1),
    (error: unknown) => (error as { code?: string }).code === "worker_protocol_invalid");
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
  const envelope = await protocol.issueCredentialEnvelope("worker_remote_a", lease.lease_id, 1, 1);
  assert.deepEqual(envelope.credentials, { CUSTOM_REMOTE_SECRET: secret });
  assert.equal(envelope.offer_id, offer.offer_id);
  assert.equal(Date.parse(envelope.expires_at) - Date.parse(envelope.issued_at), 5_000);
  await assert.rejects(protocol.issueCredentialEnvelope("worker_remote_a", lease.lease_id, 1, 2),
    (error: unknown) => (error as { code?: string }).code === "worker_protocol_invalid");
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
  await assert.rejects(protocol.issueCredentialEnvelope("worker_remote_a", lease.lease_id, 1, 1),
    (error: unknown) => (error as { code?: string }).code === "worker_protocol_invalid");
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

test("remote recovery withdraws an unaccepted offer before it can be safely requeued", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-not-started-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new RemoteWorkerRegistry({ root });
  const protocol = new RemoteWorkerProtocol({ root, registry });
  await Promise.all([registry.initialize(), protocol.initialize()]);
  await registry.register(registration());
  const { work } = remoteWork();
  const evalDirectory = path.join(root, "evals", work.eval_id);
  await mkdir(evalDirectory, { recursive: true });
  const lease = await createExecutionLease({
    evalDirectory, evalId: work.eval_id, workId: work.work_id,
    worker: { workerId: "worker_remote_a", provider: "remote-docker", collisionDomainId: "docker-engine:remote-a" },
    reservation: work.reservation, ttlMs: 60_000, initialState: "offered",
  });
  const offer = await protocol.createOffer("worker_remote_a", lease.current(), work);
  const recovered = await recoverRemoteWorkerEvalLeases({
    root, evalId: work.eval_id as EvalId, evalDirectory, leases: [lease.current()], registry, protocol,
    pollIntervalMs: 5, releaseTimeoutMs: 10,
  });
  assert.equal(recovered.status, "resumable", JSON.stringify(recovered));
  assert.equal((await protocol.getOffer("worker_remote_a", offer.offer_id))?.state, "expired");
  assert.equal((await readExecutionLeases(evalDirectory))[0]?.state, "released");
});

for (const resourceAware of [false, true]) test(`remote ${resourceAware ? "resource v3" : "legacy"} recovery cannot acknowledge cleanup or retry a lease after release times out`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-remote-release-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = resourceAware ? await resourceFixture(directory, 1) : undefined, root = fixture?.store.root ?? directory;
  const registry = new RemoteWorkerRegistry({ root }), protocol = new RemoteWorkerProtocol({ root, registry });
  await registry.initialize(); await protocol.initialize(); await registry.register(registration(resourceAware ? { features: { docker: true, buildkit: true, model_proxy: true, isolated_same_task_attempts: false, benchmark_resources: '1' } } : {}));
  const { work } = remoteWork(), evalDirectory = path.join(root, "evals", work.eval_id);
  const inputs = new RemoteWorkInputStore(root); await inputs.initialize();
  const refs = [], workerStore = new ResourceStore(path.join(directory, 'worker'), { images: new FixtureImageProvider(), limits: { minFreeBytes: 0 } });
  const resourceEvidence = path.join(directory, 'resource-evidence.json');
  let workspace: Awaited<ReturnType<typeof materializeResourceTask>> | undefined;
  if (fixture) {
    work.task_ids = ['task-0'];
    const delivery = await createResourceDelivery(fixture.store, selectResources(fixture.dataset, work.task_ids), 'remote-loss', 1);
    refs.push(await inputs.put('work-spec', 'json', Buffer.from(JSON.stringify({ schema_version: '3', resource_delivery: delivery.digest }))),
      await inputs.put('task-input', 'hitch-resource-delivery-v1', Buffer.from(JSON.stringify(delivery))));
    await receiveResourceDelivery(workerStore, delivery, async entry => createReadStream(fixture.store.objects.objectPath(entry.digest)), 'worker-loss', 1);
    const checked = await preflightResourceTask(workerStore, delivery.selection.tasks[0]!, { owner: 'worker-execution', generation: 1, platform: 'linux/amd64' });
    workspace = await materializeResourceTask(workerStore, checked.plan, { owner: 'worker-execution', generation: 1, policy: { mode: 'copy' } });
    await writeFile(resourceEvidence, JSON.stringify({ ...workspace, executionEnded: false, preflightPlanDigest: checked.plan.digest }));
  }
  await mkdir(evalDirectory, { recursive: true });
  const handle = await createExecutionLease({ evalDirectory, evalId: work.eval_id, workId: work.work_id,
    worker: { workerId: "worker_remote_a", provider: "remote-docker", collisionDomainId: "docker-engine:remote-a" },
    reservation: work.reservation, ttlMs: 60_000, initialState: "offered" });
  const offer = await protocol.createOffer("worker_remote_a", handle.current(), work, refs);
  await protocol.acceptOffer(offer.worker_id, { schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce,
    generation: offer.generation, accepted: true, sent_at: new Date().toISOString() });
  await protocol.completeOffer(offer.worker_id, { schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce,
    generation: offer.generation, lease_id: handle.leaseId, epoch: 1, status: "failed", artifacts: [], sent_at: new Date().toISOString() });
  const events: Array<Record<string, unknown>> = [];
  const recover = async () => recoverRemoteWorkerEvalLeases({ root, evalId: work.eval_id as EvalId, evalDirectory,
    leases: await readExecutionLeases(evalDirectory), registry, protocol, cancelRequested: true,
    pollIntervalMs: 5, releaseTimeoutMs: 10, emit: event => { events.push(event); } });
  const first = await recover();
  assert.equal(first.status, "ambiguous"); assert.equal(first.code, "worker_release_timeout");
  assert.deepEqual(first.recovered_lease_ids, []);
  const fenced = (await readExecutionLeases(evalDirectory))[0]!;
  assert.equal(fenced.state, "lost"); assert.equal(fenced.epoch, 2);
  assert.equal((await protocol.getOffer(offer.worker_id, offer.offer_id))!.state, "release-requested");
  const again = await recover();
  assert.equal(again.status, "ambiguous"); assert.equal(again.code, "execution_state_ambiguous");
  assert.deepEqual(await readExecutionLeases(evalDirectory), [fenced]);
  assert.equal(events.some(event => event.type === "sandbox.cleanup.completed"), false);
  if (workspace) {
    const restartedStore = new ResourceStore(workerStore.root, { images: new FixtureImageProvider(), limits: { minFreeBytes: 0 } });
    await auditResources(restartedStore, { apply: true, graceMs: 0 });
    assert.equal(await reclaimResourceExecution(restartedStore, resourceEvidence, true), false, 'unknown execution and unsealed result retain the workspace');
    assert.ok((await lstat(workspace.taskDirectory)).isDirectory());
    await restartedStore.objects.verify(workspace.materializedTree!.manifestDigest);
    const resultDirectory = path.join(directory, 'late-result'); await mkdir(resultDirectory);
    await writeFile(resourceEvidence, JSON.stringify({ ...workspace, executionEnded: true, preflightPlanDigest: workspace.plan.digest }));
    await sealResourceEvidence({ store: restartedStore, file: resourceEvidence, runDirectory: resultDirectory, owner: `run:run_${'a'.repeat(32)}`, taskId: 'task-0', requireObserved: false });
    await confirmResourceResultSealed(resourceEvidence);
    assert.equal(await reclaimResourceExecution(restartedStore, resourceEvidence, false), false, 'a late sealed result alone is not cleanup acknowledgement');
    await auditResources(restartedStore, { apply: true, graceMs: 0 });
    assert.ok((await lstat(workspace.taskDirectory)).isDirectory());
    await assert.rejects(restartedStore.release('worker-execution', 2), /stale/);
    assert.equal((await restartedStore.readRecord<{ state: string }>('roots', 'worker-execution'))!.state, 'active');
  }
  const receipt = { schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce,
    generation: offer.generation, lease_id: handle.leaseId, epoch: 1, sent_at: new Date().toISOString() };
  await assert.rejects(protocol.releaseOffer(offer.worker_id, { ...receipt, epoch: 2 }));
  const restartedRegistry = new RemoteWorkerRegistry({ root }), restartedProtocol = new RemoteWorkerProtocol({ root, registry: restartedRegistry });
  await restartedRegistry.initialize(); await restartedProtocol.initialize();
  await assert.rejects(restartedProtocol.releaseOffer(offer.worker_id, { ...receipt, generation: receipt.generation - 1 }));
  const acknowledged = await restartedProtocol.releaseOffer(offer.worker_id, receipt);
  for (const changed of [{ ...acknowledged, generation: acknowledged.generation + 1 },
    { ...acknowledged, release_receipt_digest: `sha256:${"f".repeat(64)}` as const },
    { ...acknowledged, lease: { ...acknowledged.lease, reservation: { ...work.reservation, container_slots: 0 } } }]) {
    assert.throws(() => assertRemoteLeaseRelease(fenced, changed), { code: "execution_state_ambiguous" });
  }
  const late = await recover(); assert.equal(late.status, "resumable", JSON.stringify(late));
  const confirmed = (await readExecutionLeases(evalDirectory))[0]!;
  assert.equal(confirmed.state, "released"); assert.equal(confirmed.epoch, 2);
  assert.deepEqual(confirmed.resource_epochs, [1]); assert.equal(confirmed.release_confirmation!.execution_epoch, 1);
  assert.equal(confirmed.release_confirmation!.receipt_digest, acknowledged.release_receipt_digest);
  assert.throws(() => parseExecutionLease({ ...confirmed, state: "running", terminal_at: undefined }), { code: "execution_state_ambiguous" });
  await assert.rejects(handle.heartbeat(1), { code: "lease_epoch_mismatch" });
  await assert.rejects(heartbeatExecutionLease({ evalDirectory, leaseId: handle.leaseId, expectedEpoch: 2 }), { code: "lease_not_active" });
  await assert.rejects(protocol.authorizeModelRequest(offer.worker_id, handle.leaseId, offer.generation, 1));
  await recover(); assert.deepEqual(await readExecutionLeases(evalDirectory), [confirmed]);
  if (workspace) {
    assert.equal(await reclaimResourceExecution(workerStore, resourceEvidence, true), true);
    await assert.rejects(lstat(workspace.taskDirectory), { code: 'ENOENT' });
    await auditResources(workerStore, { apply: true, graceMs: 0 });
    await workerStore.objects.verify(workspace.materializedTree!.manifestDigest);
    const sealed = await workerStore.readRecord<{ state: string }>('roots', `run:run_${'a'.repeat(32)}`); assert.equal(sealed!.state, 'active');
  }
});

test("accepted remote work reconnects with exact lease proof instead of being replayed", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-reconnect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new RemoteWorkerRegistry({ root, heartbeatTtlMs: 1_000 });
  const protocol = new RemoteWorkerProtocol({ root, registry });
  await Promise.all([registry.initialize(), protocol.initialize()]);
  await registry.register(registration());
  const { work } = remoteWork();
  const evalDirectory = path.join(root, "evals", work.eval_id);
  await mkdir(evalDirectory, { recursive: true });
  const lease = await createExecutionLease({
    evalDirectory, evalId: work.eval_id, workId: work.work_id,
    worker: { workerId: "worker_remote_a", provider: "remote-docker", collisionDomainId: "docker-engine:remote-a" },
    reservation: work.reservation, ttlMs: 60_000, initialState: "offered",
  });
  const offer = await protocol.createOffer("worker_remote_a", lease.current(), work);
  await protocol.acceptOffer("worker_remote_a", {
    schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce, generation: offer.generation,
    accepted: true, sent_at: new Date().toISOString(),
  });
  await delay(1_050);
  assert.equal((await registry.get("worker_remote_a"))?.worker.status, "offline");
  const events: Array<Record<string, unknown>> = [];
  const reconnect = (async () => {
    await waitForState(protocol, "worker_remote_a", offer.offer_id, "cancel-requested");
    const heartbeat = {
      schema_version: "1" as const, generation: offer.generation, health: "healthy" as const,
      allocated: work.reservation, active_leases: [{ lease_id: lease.leaseId, epoch: 1 }], sent_at: new Date().toISOString(),
    };
    await protocol.validateHeartbeatLeases("worker_remote_a", heartbeat);
    await registry.heartbeat("worker_remote_a", heartbeat);
    await delay(20);
    await protocol.releaseOffer("worker_remote_a", {
      schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce, generation: offer.generation,
      lease_id: lease.leaseId, epoch: 1, sent_at: new Date().toISOString(),
    });
  })();
  const recovered = await recoverRemoteWorkerEvalLeases({
    root, evalId: work.eval_id as EvalId, evalDirectory, leases: [lease.current()], registry, protocol,
    cancelRequested: true, pollIntervalMs: 5, releaseTimeoutMs: 100, reconnectTimeoutMs: 500,
    emit: (event) => { events.push(event); },
  });
  await reconnect;

  assert.equal(recovered.status, "resumable", JSON.stringify(recovered));
  assert.deepEqual(recovered.recovered_lease_ids, [lease.leaseId]);
  const leases = await readExecutionLeases(evalDirectory);
  assert.equal(leases.length, 1, "recovery must not create a second physical execution");
  assert.equal(leases[0]?.state, "released");
  assert.equal((await protocol.getOffer("worker_remote_a", offer.offer_id))?.state, "released");
  assert.ok(events.some((event) => event.type === "worker.heartbeat_missed"));
  assert.ok(events.some((event) => event.type === "worker.reconnected"));
});

test("daemon remote-worker API separates admin registration from worker heartbeat credentials", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-worker-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs: Array<{ type: string; fields: Record<string, unknown> }> = [];
  const server = new DaemonServer({ root, port: 0, maxConcurrent: 1, logger: (type, fields) => logs.push({ type, fields }) });
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
  assert.ok(logs.some((entry) => entry.type === "event" && entry.fields.type === "worker.registered" && entry.fields.worker_id === "worker_remote_a"));
  assert.ok(logs.some((entry) => entry.type === "event" && entry.fields.type === "worker.heartbeat" && entry.fields.worker_id === "worker_remote_a"));
  const health = await client.request("/health") as { workers: { healthy: number; lost: number }; metrics: { event_counts: Record<string, number> } };
  assert.equal(health.workers.healthy, 2);
  assert.equal(health.workers.lost, 0);
  assert.equal(health.metrics.event_counts["worker.registered"], 1);
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
  const inputStore = new RemoteWorkInputStore(root);
  await inputStore.initialize();
  const inputBody = Buffer.from('{"schema_version":"1","work":"test"}\n');
  const inputRef = await inputStore.put("work-spec", "json", inputBody);
  const created = await client.request("/v1/workers/worker_remote_a/offers", {
    method: "POST", body: JSON.stringify({ lease, work, inputs: [inputRef] }),
  });
  const offer = created.offer as { offer_id: string; nonce: string };
  const workerHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const downloaded = await fetch(`http://127.0.0.1:${server.port}/v1/workers/worker_remote_a/leases/${lease.lease_id}/inputs/${inputRef.digest}?generation=1`, { headers: workerHeaders });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), inputBody);
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

async function waitForState(protocol: RemoteWorkerProtocol, workerId: string, offerId: string, state: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    if ((await protocol.getOffer(workerId, offerId))?.state === state) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for remote offer state: ${state}`);
    await delay(5);
  }
}
