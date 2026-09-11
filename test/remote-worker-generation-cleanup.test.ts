import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { RemoteWorkerHttpClient, RemoteWorkerRunner, recoverRemoteWorkerEvalLeases } from "../src/control-plane/index.js";
import type { EvalId, RemoteWorkerCleanupReceiptV2 } from "../src/domain/index.js";
import { assertRemoteLeaseRelease, heartbeatExecutionLease, markExecutionLeaseLost, readExecutionLeases } from "../src/evals/index.js";
import { atomicWriteJSON, delay, readJSON, sha256JSON, statePaths } from "../src/foundation/index.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { workerAdmissionFixture } from "../test-support/worker-admission.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: test.TestContext, complete = false) {
  const f = await workerAdmissionFixture(t), accepted = await f.accept(); await f.authorize();
  if (complete) {
    const { accepted: _, ...receipt } = f.receipt;
    await f.protocol.completeOffer(accepted.worker_id, { ...receipt, lease_id: f.lease.lease_id, epoch: 1, status: "failed", artifacts: [] });
  }
  const offer = (await f.protocol.getOffer(accepted.worker_id, accepted.offer_id))!;
  const evalDirectory = path.join(statePaths(f.root).evals, f.lease.eval_id), leaseFile = path.join(evalDirectory, "leases", `${f.lease.lease_id}.json`);
  await atomicWriteJSON(leaseFile, { ...f.lease, state: "running", accepted_at: accepted.accepted_at });
  const lost = await markExecutionLeaseLost({ evalDirectory, leaseId: f.lease.lease_id, expectedEpoch: 1 });
  const next = await f.registry.register(f.registration);
  const credential = { schema_version: "1" as const, worker_id: offer.worker_id, generation: next.worker.generation, token: next.token };
  const client = new RemoteWorkerHttpClient({ baseUrl: f.baseUrl, credential });
  const challenge = (await client.cleanupChallenge(offer)).challenge!;
  const receipt: RemoteWorkerCleanupReceiptV2 = { schema_version: "2", challenge, observed_at: new Date().toISOString(),
    observation: { ownership: f.ownership, execution_process: f.executionProcess, worker_status: "terminal", process_group_empty: true, docker_resources_empty: true } };
  const offerFile = path.join(statePaths(f.root).workerProtocol, "workers", offer.worker_id, "offers", `${offer.offer_id}.json`);
  return { ...f, offer, evalDirectory, leaseFile, lost, credential, client, challenge, receipt, offerFile };
}

for (const complete of [false, true]) test(`new generation cleanup reconciles original ${complete ? "completed" : "interrupted"} work without a synthetic v1 release`, async t => {
  const f = await fixture(t, complete), original = await readFile(f.offerFile);
  await f.client.commitCleanup(f.offer, f.receipt); await f.client.commitCleanup(f.offer, f.receipt);
  const released = (await readExecutionLeases(f.evalDirectory))[0]!;
  assert.equal(released.state, "released"); assert.equal(released.epoch, 2); assert.deepEqual(released.resource_epochs, [1]);
  assert.equal(released.release_confirmation?.schema_version, "3");
  assert.deepEqual(assertRemoteLeaseRelease(released, f.offer, f.receipt), released.release_confirmation);
  await assert.rejects(heartbeatExecutionLease({ evalDirectory: f.evalDirectory, leaseId: f.lease.lease_id, expectedEpoch: 2 }));
  assert.throws(() => assertRemoteLeaseRelease(released, f.offer));
  assert.deepEqual(await readFile(f.offerFile), original);
  assert.equal((await f.protocol.listOffers(f.offer.worker_id, 2)).length, 0);
  const recovered = await recoverRemoteWorkerEvalLeases({ root: f.root, evalId: f.lease.eval_id as EvalId, evalDirectory: f.evalDirectory,
    leases: [released], registry: f.registry, protocol: f.protocol, cancelRequested: true, pollIntervalMs: 5, releaseTimeoutMs: 50 });
  assert.equal(recovered.status, "resumable");
  assert.deepEqual(await readFile(f.offerFile), original);
  const another = await f.protocol.createOffer(f.offer.worker_id, { ...f.lease, lease_id: `lease_${"f".repeat(32)}` }, f.offer.work);
  assert.equal(another.generation, 2, "only the independent physical receipt frees this old reservation");
  const third = await f.registry.register(f.registration);
  const latest = new RemoteWorkerHttpClient({ baseUrl: f.baseUrl, credential: { ...f.credential, generation: 3, token: third.token } });
  assert.deepEqual((await latest.cleanupChallenge(f.offer)).receipt, f.receipt, "an acknowledged physical fact survives another credential rotation");
});

test("cleanup rejects substituted identities, unproven resources and stale observations", async t => {
  const f = await fixture(t);
  for (const change of [
    (value: RemoteWorkerCleanupReceiptV2) => { value.challenge.nonce = "0".repeat(32); },
    (value: RemoteWorkerCleanupReceiptV2) => { value.challenge.generation = 3; },
    (value: RemoteWorkerCleanupReceiptV2) => { value.observation.ownership.root_digest = sha256JSON("other root"); },
    (value: RemoteWorkerCleanupReceiptV2) => { value.observation.execution_process!.pid++; },
    (value: RemoteWorkerCleanupReceiptV2) => { (value.observation as { worker_status: string }).worker_status = "running"; },
    (value: RemoteWorkerCleanupReceiptV2) => { (value.observation as { docker_resources_empty: boolean }).docker_resources_empty = false; },
    (value: RemoteWorkerCleanupReceiptV2) => { value.observed_at = new Date(Date.parse(value.challenge.expires_at) + 1).toISOString(); },
    (value: RemoteWorkerCleanupReceiptV2) => { value.challenge.admission.execution_epoch++; },
  ]) {
    const receipt = structuredClone(f.receipt); change(receipt);
    await assert.rejects(f.protocol.generationCleanup.commit(f.offer.worker_id, f.offer.offer_id, 2, receipt));
  }
  assert.equal(await f.protocol.generationCleanup.read(f.offer), null);
  assert.deepEqual((await readExecutionLeases(f.evalDirectory))[0], f.lost);
  await assert.rejects(f.protocol.createOffer(f.offer.worker_id, { ...f.lease, lease_id: `lease_${"f".repeat(32)}` }, f.offer.work), /capacity/);
});

test("a generation rotated while cleanup publication waits cannot release the old execution", async t => {
  const f = await fixture(t), entered = deferred(), resume = deferred();
  f.registry.beforePublication = async () => { entered.resolve(); await resume.promise; };
  const pending = f.protocol.generationCleanup.commit(f.offer.worker_id, f.offer.offer_id, 2, f.receipt);
  const rejected = assert.rejects(pending, error => (error as { code?: string }).code === "worker_generation_mismatch"); void rejected.catch(() => {});
  try { await entered.promise; await f.registry.register(f.registration); } finally { resume.resolve(); }
  await rejected;
  assert.equal(await f.protocol.generationCleanup.read(f.offer), null);
  assert.equal((await readExecutionLeases(f.evalDirectory))[0]!.state, "lost");
});

test("durable cleanup repairs a lease publication failure and replays a lost HTTP response", async t => {
  const f = await fixture(t);
  await rm(f.leaseFile); await mkdir(f.leaseFile);
  await assert.rejects(f.client.commitCleanup(f.offer, f.receipt));
  assert.deepEqual(await f.protocol.generationCleanup.read(f.offer), f.receipt);
  await rm(f.leaseFile, { recursive: true }); await atomicWriteJSON(f.leaseFile, f.lost);
  let lost = false;
  const client = new RemoteWorkerHttpClient({ baseUrl: f.baseUrl, credential: f.credential, request: async (url, init) => {
    const response = await fetch(url, init);
    if (!lost && response.ok) { lost = true; await response.arrayBuffer(); throw new Error("reply lost after lease publication"); }
    return response;
  } });
  await assert.rejects(client.cleanupChallenge(f.offer), /reply lost/);
  assert.equal((await readExecutionLeases(f.evalDirectory))[0]!.state, "released");
  assert.deepEqual((await client.cleanupChallenge(f.offer)).receipt, f.receipt);
});

test("reissued resource epochs cannot be closed by an original generation cleanup receipt", async t => {
  const f = await fixture(t);
  const reissued = { ...f.lost, state: "lost" as const, epoch: 3, resource_epochs: [1, 2] };
  await atomicWriteJSON(f.leaseFile, reissued);
  await assert.rejects(f.client.commitCleanup(f.offer, f.receipt));
  assert.deepEqual((await readExecutionLeases(f.evalDirectory))[0], reissued);
  await assert.rejects(f.protocol.listOffers(f.offer.worker_id, 2), /receipt/);
});

test("legacy ownership cannot be invented by a newer worker", async t => {
  const f = await workerAdmissionFixture(t);
  await f.protocol.acceptOffer(f.offer.worker_id, f.receipt); await f.registry.register(f.registration);
  await assert.rejects(f.protocol.generationCleanup.challenge(f.offer.worker_id, f.offer.offer_id, 2), /ownership is unavailable/);
  assert.equal(await f.protocol.generationCleanup.read(f.offer), null);
});

test("background generation cleanup keeps heartbeats live and replays a lost commit after the offer disappears", async t => {
  const f = await fixture(t), entered = deferred(), resume = deferred(), stop = new AbortController();
  let lost = false, cleanups = 0, executions = 0, commits = 0; const bodies: string[] = [];
  const client = new RemoteWorkerHttpClient({ baseUrl: f.baseUrl, credential: f.credential, request: async (url, init) => {
    const commit = String(url).endsWith("/cleanup"); if (commit) { commits++; bodies.push(String(init?.body)); }
    const response = await fetch(url, init);
    if (commit && response.ok && !lost) { lost = true; await response.arrayBuffer(); throw new Error("fixture lost cleanup acknowledgement"); }
    return response;
  } });
  const runner = new RemoteWorkerRunner({ client, capacity: f.registration.capacity.allocatable, once: true, signal: stop.signal,
    pollIntervalMs: 50, heartbeatIntervalMs: 50, retryIntervalMs: 50,
    execute: async () => { executions++; return { status: "failed" }; },
    releasePreviousGeneration: async () => { cleanups++; entered.resolve(); await resume.promise; return f.receipt.observation; } });
  const running = runner.run(); void running.catch(() => {});
  t.after(async () => { resume.resolve(); stop.abort(); await running; });
  await entered.promise;
  const before = (await f.registry.get(f.offer.worker_id))!.heartbeat_at;
  await eventually(async () => (await f.registry.get(f.offer.worker_id))!.heartbeat_at !== before);
  assert.equal((await readExecutionLeases(f.evalDirectory))[0]!.state, "lost");
  resume.resolve();
  await eventually(async () => commits === 2);
  await running;
  assert.equal(executions, 0); assert.equal(cleanups, 1); assert.equal(commits, 2); assert.equal(bodies[0], bodies[1]);
  assert.equal((await readExecutionLeases(f.evalDirectory))[0]!.state, "released");
});

test("cleanup schemas distinguish the independent receipt and v3 lease confirmation from old v1 records", async t => {
  const f = await fixture(t);
  const ajv = new Ajv2020({ strict: false, validateFormats: false, loadSchema: async uri => {
    assert.equal(new URL(uri).origin, "https://agent-hitch.local");
    return JSON.parse(await readFile(new URL(`../../docs/schemas/${path.basename(new URL(uri).pathname)}`, import.meta.url), "utf8"));
  } });
  const receipt = await ajv.compileAsync({ $ref: "https://agent-hitch.local/schemas/remote-worker-generation-cleanup.schema.json" });
  const lease = await ajv.compileAsync({ $ref: "https://agent-hitch.local/schemas/execution-lease.schema.json" });
  assert.equal(receipt(f.receipt), true, ajv.errorsText(receipt.errors));
  assert.equal(receipt({ ...f.receipt, observation: { ...f.receipt.observation, docker_resources_empty: false } }), false);
  await f.client.commitCleanup(f.offer, f.receipt);
  const released = (await readExecutionLeases(f.evalDirectory))[0]!;
  assert.equal(lease(released), true, ajv.errorsText(lease.errors));
  assert.equal(lease({ ...released, release_confirmation: { ...released.release_confirmation, cleanup_generation: undefined } }), false);
  assert.equal(lease({ ...released, release_confirmation: { ...released.release_confirmation, schema_version: "2" } }), false);
});

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await check()) { assert.ok(Date.now() < deadline, "generation recovery did not finish"); await delay(10); }
}
