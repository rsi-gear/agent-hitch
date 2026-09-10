import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { RemoteWorkerHttpClient, RemoteWorkerProtocol, RemoteWorkerRegistry, recoverRemoteWorkerEvalLeases } from "../src/control-plane/index.js";
import { DaemonServer } from "../src/daemon/index.js";
import { handleWorkerProtocolRoute } from "../src/daemon/worker-routes.js";
import { readExecutionLeases } from "../src/evals/index.js";
import { atomicWriteJSON, delay, sha256Bytes, statePaths, withFileLock } from "../src/foundation/index.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-generation-commit-"));
  const cleanups: Array<() => Promise<unknown>> = [];
  t.after(async () => { try { for (const cleanup of cleanups.reverse()) await cleanup(); } finally { await rm(root, { recursive: true, force: true }); } });
  const resources = { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
  const zero = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
  const registration = { schema_version: "1", worker_id: "worker_commit", provider: "remote-docker", collision_domain_id: "docker:commit",
    platforms: ["linux/amd64"], backends: [{ id: "harbor", version: "0.21.0" }],
    features: { docker: true, buildkit: false, model_proxy: false, isolated_same_task_attempts: false }, task_membership: ["known"],
    capacity: { total: resources, allocatable: resources, reserved_for_system: zero } };
  class ObservedRegistry extends RemoteWorkerRegistry {
    onRead?: () => void;
    onAuthenticated?: () => void;
    beforePublication?: () => Promise<void>;
    override async get(workerId: string, now?: number) {
      const result = await super.get(workerId, now); const callback = this.onRead; delete this.onRead; callback?.(); return result;
    }
    override async withGeneration<T>(workerId: string, generation: number, publish: () => Promise<T>): Promise<T> {
      const callback = this.beforePublication; delete this.beforePublication; await callback?.();
      return super.withGeneration(workerId, generation, publish);
    }
    override async authenticatedGeneration(workerId: string, token: string): Promise<number | null> {
      const result = await super.authenticatedGeneration(workerId, token);
      const callback = this.onAuthenticated; delete this.onAuthenticated; callback?.(); return result;
    }
  }
  const registry = new ObservedRegistry({ root }); await registry.initialize(); const registered = await registry.register(registration);
  const protocol = new RemoteWorkerProtocol({ root, registry }); await protocol.initialize();
  const work = { schema_version: "1" as const, work_id: `work_${"b".repeat(32)}`, eval_id: `eval_${"c".repeat(32)}`, backend: "harbor" as const,
    logical_attempt: 1, task_ids: ["one"], slots: [`slot_${"d".repeat(32)}`], opaque_membership: false, requested_parallelism: 1, reservation: resources, provider: registration.provider };
  const lease = { schema_version: "1" as const, lease_id: `lease_${"e".repeat(32)}`, work_id: work.work_id, eval_id: work.eval_id,
    worker_id: registration.worker_id, provider: registration.provider, collision_domain_id: registration.collision_domain_id, reservation: resources,
    state: "offered" as const, epoch: 1, resource_epochs: [1], issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() };
  const offer = await protocol.createOffer(registration.worker_id, lease, work);
  const receipt = { schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce, generation: offer.generation, sent_at: new Date().toISOString() };
  const accept = () => protocol.acceptOffer(registration.worker_id, { ...receipt, accepted: true });
  const terminal = { ...receipt, lease_id: lease.lease_id, epoch: lease.epoch };
  return { root, registry, registration, registered, protocol, offer, lease, work, resources, zero, accept, receipt, terminal, cleanups };
}

for (const mutation of ["accept", "complete", "release", "event"] as const) {
  test(`generation rotation fences an already-authorized ${mutation} waiting to write`, async t => {
    const f = await fixture(t);
    if (mutation !== "accept") await f.accept();
    if (mutation === "release") await f.protocol.completeOffer(f.registration.worker_id, { ...f.terminal, status: "failed", artifacts: [] });
    const original = await f.protocol.getOffer(f.registration.worker_id, f.offer.offer_id);
    const held = deferred(), resume = deferred(), read = deferred();
    const key = mutation === "event" ? `event-${f.lease.lease_id}` : f.offer.offer_id;
    const blocker = withFileLock(statePaths(f.root).workerProtocolLocks, key, async () => { held.resolve(); await resume.promise; });
    await held.promise;
    f.registry.onRead = read.resolve;
    const mutationPromise = mutation === "accept" ? f.accept() : mutation === "complete"
      ? f.protocol.completeOffer(f.registration.worker_id, { ...f.terminal, status: "failed", artifacts: [] }) : mutation === "release"
        ? f.protocol.releaseOffer(f.registration.worker_id, f.terminal)
        : f.protocol.recordEvent(f.registration.worker_id, { schema_version: "1", generation: 1, lease_id: f.lease.lease_id,
          epoch: 1, sequence: 1, type: "worker.finished", sent_at: new Date().toISOString() });
    const rejected = assert.rejects(mutationPromise, error => (error as { code?: string }).code === "worker_generation_mismatch");
    void rejected.catch(() => {});
    try { await read.promise; await f.registry.register(f.registration); } finally { resume.resolve(); await blocker; }
    await rejected;
    assert.deepEqual(await f.protocol.getOffer(f.registration.worker_id, f.offer.offer_id), original);
    if (mutation === "accept") await assert.rejects(readFile(path.join(statePaths(f.root).workerProtocol, "leases", `${f.lease.lease_id}.json`)), { code: "ENOENT" });
    if (mutation === "event") await assert.rejects(readFile(path.join(statePaths(f.root).workerProtocol, "events", f.lease.lease_id, "state.json")), { code: "ENOENT" });
    if (mutation !== "accept") {
      const other = { ...f.lease, lease_id: `lease_${"f".repeat(32)}` };
      await assert.rejects(f.protocol.createOffer(f.registration.worker_id, other, f.work), /capacity/);
    }
  });
}

for (const change of ["rotate", "revoke"] as const) test(`an artifact upload cannot publish after worker credentials ${change}`, async t => {
  const f = await fixture(t); await f.accept();
  const body = Buffer.from("generation-bound result"), digest = sha256Bytes(body), entered = deferred(), resume = deferred();
  const upload = f.protocol.uploadArtifact({ workerId: f.registration.worker_id, leaseId: f.lease.lease_id, generation: 1, epoch: 1,
    digest, expectedSize: body.length, body: (async function* () { yield body.subarray(0, 5); entered.resolve(); await resume.promise; yield body.subarray(5); })() });
  const rejected = assert.rejects(upload, error => ["worker_generation_mismatch", "worker_revoked", "worker_unavailable"].includes((error as { code: string }).code));
  void rejected.catch(() => {});
  try {
    await entered.promise;
    if (change === "rotate") {
      const fresh = await f.registry.register(f.registration);
      await f.registry.heartbeat(f.registration.worker_id, { schema_version: "1", generation: fresh.worker.generation,
        health: "healthy", allocated: f.zero, active_leases: [], sent_at: new Date().toISOString() });
    } else await f.registry.revoke(f.registration.worker_id);
  } finally { resume.resolve(); }
  await rejected;
  const directory = path.dirname(f.protocol.artifactPath(f.registration.worker_id, f.lease.lease_id, digest));
  assert.deepEqual(await readdir(directory), [], "a fenced stream must not leave a published receipt, blob or temporary body");
  assert.equal((await f.protocol.getOffer(f.registration.worker_id, f.offer.offer_id))!.state, "accepted");
});

test("dispatch cannot publish an offer for a generation rotated after input validation", async t => {
  const f = await fixture(t); await f.protocol.withdrawUnacceptedOffer(f.registration.worker_id, f.offer.offer_id);
  const entered = deferred(), resume = deferred();
  f.registry.beforePublication = async () => { entered.resolve(); await resume.promise; };
  const lease = { ...f.lease, lease_id: `lease_${"f".repeat(32)}` };
  const pending = f.protocol.createOffer(f.registration.worker_id, lease, f.work);
  const rejected = assert.rejects(pending, error => (error as { code?: string }).code === "worker_generation_mismatch"); void rejected.catch(() => {});
  try { await entered.promise; await f.registry.register(f.registration); } finally { resume.resolve(); }
  await rejected;
  assert.equal(await f.protocol.findOfferForLease(f.registration.worker_id, lease.lease_id), null);
  assert.equal((await f.protocol.createOffer(f.registration.worker_id, lease, f.work)).generation, 2);
});

test("recovery fences a replaced worker immediately while retaining the original reservation", async t => {
  const f = await fixture(t); await f.accept(); await f.registry.register(f.registration);
  const lease = { ...f.lease, state: "running" as const, accepted_at: new Date().toISOString() };
  const evalDirectory = path.join(statePaths(f.root).evals, lease.eval_id);
  await atomicWriteJSON(path.join(evalDirectory, "leases", `${lease.lease_id}.json`), lease);
  // A new generation reporting the old lease directly to the registry is not
  // proof that the old worker reconnected. The normal HTTP handler rejects it.
  await f.registry.heartbeat(f.registration.worker_id, { schema_version: "1", generation: 2, health: "healthy",
    allocated: f.resources, active_leases: [{ lease_id: lease.lease_id, epoch: lease.epoch }], sent_at: new Date().toISOString() });
  const began = Date.now();
  const recovered = await recoverRemoteWorkerEvalLeases({ root: f.root, evalId: lease.eval_id as import("../src/domain/index.js").EvalId,
    evalDirectory, leases: [lease], registry: f.registry, protocol: f.protocol, pollIntervalMs: 5, releaseTimeoutMs: 50, reconnectTimeoutMs: 15000 });
  assert.equal(recovered.status, "ambiguous"); assert.equal(recovered.code, "worker_generation_mismatch");
  assert.ok(Date.now() - began < 10000, "a replaced generation must not enter the offline reconnect grace period");
  const current = (await readExecutionLeases(evalDirectory))[0]!;
  assert.equal(current.state, "lost"); assert.equal(current.epoch, lease.epoch + 1);
  assert.deepEqual(current.resource_epochs, [lease.epoch]); assert.equal(current.release_confirmation, undefined);
  assert.equal((await f.protocol.getOffer(f.registration.worker_id, f.offer.offer_id))!.state, "accepted");
  await assert.rejects(f.protocol.createOffer(f.registration.worker_id, { ...f.lease, lease_id: `lease_${"f".repeat(32)}` }, f.work), /capacity/);
});

test("authenticated HTTP uploads lose publication authority after admin credential rotation without blocking heartbeats", async t => {
  const f = await fixture(t); await f.accept();
  const server = new DaemonServer({ root: f.root, port: 0, maxConcurrent: 1, logger: () => {} });
  f.cleanups.push(() => server.close()); await server.start();
  const baseUrl = `http://127.0.0.1:${server.port}`, body = Buffer.from("an in-flight authenticated artifact"), digest = sha256Bytes(body);
  const directory = path.dirname(f.protocol.artifactPath(f.registration.worker_id, f.lease.lease_id, digest));
  let upload!: http.ClientRequest;
  const response = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    upload = http.request(`${baseUrl}/v1/workers/${f.registration.worker_id}/leases/${f.lease.lease_id}/artifacts/${digest}?generation=1&epoch=1`, {
      method: "PUT", headers: { authorization: `Bearer ${f.registered.token}`, "content-length": body.length },
    }, incoming => { let text = ""; incoming.on("data", chunk => { text += chunk; }); incoming.once("end", () => resolve({ status: incoming.statusCode, body: text })); incoming.once("error", reject); });
    upload.once("error", reject); upload.write(body.subarray(0, 5));
  });
  void response.catch(() => {}); f.cleanups.push(async () => { upload.destroy(); });
  const deadline = Date.now() + 10000;
  while (!(await readdir(directory).catch(() => [])).some(name => name.endsWith(".tmp"))) {
    assert.ok(Date.now() < deadline, "authenticated upload did not enter its streaming stage"); await delay(10);
  }
  const registration = f.registration as import("../src/domain/index.js").RemoteWorkerRegistrationV1;
  const fresh = await RemoteWorkerHttpClient.register({ baseUrl, adminToken: (await readFile(statePaths(f.root).token, "utf8")).trim(), registration });
  assert.equal(fresh.generation, 2);
  await new RemoteWorkerHttpClient({ baseUrl, credential: fresh }).heartbeat(f.zero, []);
  upload.end(body.subarray(5));
  const result = await response;
  assert.notEqual(result.status, 201); assert.equal(JSON.parse(result.body).error.code, "worker_generation_mismatch");
  assert.deepEqual(await readdir(directory), []);
  assert.equal((await f.protocol.getOffer(f.registration.worker_id, f.offer.offer_id))!.state, "accepted");
});

test("a slow request authenticated by the old bearer cannot claim the next generation in its body", async t => {
  const f = await fixture(t), authenticated = deferred(); f.registry.onAuthenticated = authenticated.resolve;
  const server = http.createServer((request, response) => {
    handleWorkerProtocolRoute({ request, response, url: new URL(request.url!, "http://localhost"), registry: f.registry, protocol: f.protocol, adminToken: "a".repeat(64) })
      .then(handled => { if (!handled) { response.writeHead(404); response.end(); } })
      .catch(error => { response.writeHead(409, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { code: error.code } })); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  f.cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as import("node:net").AddressInfo).port;
  const body = Buffer.from(JSON.stringify({ schema_version: "1", generation: 2, health: "unavailable", allocated: f.zero, active_leases: [], sent_at: new Date().toISOString() }));
  let request!: http.ClientRequest;
  const response = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    request = http.request(`http://127.0.0.1:${port}/v1/workers/${f.registration.worker_id}/heartbeat`, {
      method: "POST", headers: { authorization: `Bearer ${f.registered.token}`, "content-length": body.length },
    }, incoming => { let value = ""; incoming.on("data", chunk => { value += chunk; }); incoming.once("end", () => resolve({ status: incoming.statusCode, body: value })); incoming.once("error", reject); });
    request.once("error", reject); request.write(body.subarray(0, 5));
  });
  void response.catch(() => {}); f.cleanups.push(async () => { request.destroy(); });
  await authenticated.promise; await f.registry.register(f.registration);
  request.end(body.subarray(5));
  const result = await response; assert.equal(result.status, 409); assert.equal(JSON.parse(result.body).error.code, "worker_generation_mismatch");
  const current = await f.registry.get(f.registration.worker_id); assert.equal(current!.generation, 2); assert.equal(current!.worker.status, "ready");
});
