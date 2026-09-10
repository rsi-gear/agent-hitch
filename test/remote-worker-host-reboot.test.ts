import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { RemoteWorkerCleanupReceiptV3, RemoteWorkerHostIdentityV1 } from "../src/domain/index.js";
import { RemoteWorkerHttpClient, RemoteWorkerRunner } from "../src/control-plane/index.js";
import { assertRemoteLeaseRelease, markExecutionLeaseLost, readExecutionLeases } from "../src/evals/index.js";
import { atomicWriteJSON, sha256JSON, statePaths } from "../src/foundation/index.js";
import { workerAdmissionFixture } from "../test-support/worker-admission.js";

const host: RemoteWorkerHostIdentityV1 = { schema_version: "1", platform: "linux", host_id: sha256JSON("original-host"), boot_id: sha256JSON("original-boot") };
async function fixture(t: test.TestContext) {
  const f = await workerAdmissionFixture(t, { hostIdentity: structuredClone(host) });
  const offer = await f.client.accept(f.offer, f.ownership, f.receipt.sent_at);
  await f.client.authorizeProcess(offer, f.ownership, f.executionProcess);
  const evalDirectory = path.join(statePaths(f.root).evals, f.lease.eval_id), leaseFile = path.join(evalDirectory, "leases", `${f.lease.lease_id}.json`);
  await atomicWriteJSON(leaseFile, { ...f.lease, state: "running", accepted_at: offer.accepted_at });
  const lost = await markExecutionLeaseLost({ evalDirectory, leaseId: f.lease.lease_id, expectedEpoch: 1 });
  const next = await f.registry.register(f.registration);
  const credential = { schema_version: "1" as const, worker_id: offer.worker_id, generation: next.worker.generation, token: next.token };
  const client = new RemoteWorkerHttpClient({ baseUrl: f.baseUrl, credential });
  const challenge = (await client.cleanupChallenge(offer)).challenge!;
  assert.equal(challenge.admission.ownership.schema_version, "3");
  const receipt: RemoteWorkerCleanupReceiptV3 = { schema_version: "3", challenge, observed_at: new Date().toISOString(),
    observation: { ownership: challenge.admission.ownership, execution_process: challenge.admission.execution_process,
      host_identity: { ...host, boot_id: sha256JSON("current-boot") }, worker_status: "previous-boot", docker_resources_empty: true } };
  const offerFile = path.join(statePaths(f.root).workerProtocol, "workers", offer.worker_id, "offers", `${offer.offer_id}.json`);
  return { ...f, offer, evalDirectory, leaseFile, lost, credential, client, receipt, offerFile };
}

test("authenticated reboot cleanup releases only the original epoch and preserves its admission and offer", async t => {
  const f = await fixture(t), original = await readFile(f.offerFile), admission = await f.admission();
  await f.client.commitCleanup(f.offer, f.receipt); await f.client.commitCleanup(f.offer, f.receipt);
  const released = (await readExecutionLeases(f.evalDirectory))[0]!;
  assert.equal(released.state, "released"); assert.equal(released.epoch, 2); assert.deepEqual(released.resource_epochs, [1]);
  assert.deepEqual(released.release_confirmation, assertRemoteLeaseRelease(released, f.offer, f.receipt));
  assert.equal(released.release_confirmation?.receipt_digest, sha256JSON(f.receipt));
  assert.deepEqual(await f.admission(), admission); assert.deepEqual(await readFile(f.offerFile), original);
  assert.deepEqual(await f.protocol.listOffers(f.offer.worker_id, 2), []);
  const another = await f.protocol.createOffer(f.offer.worker_id, { ...f.lease, lease_id: `lease_${"f".repeat(32)}` }, f.offer.work);
  assert.equal(another.generation, 2);
});

test("reboot claims reject a different host, unchanged boot, rewritten ownership, live-process claims and residual resources", async t => {
  const f = await fixture(t);
  for (const change of [
    (r: RemoteWorkerCleanupReceiptV3) => { r.observation.host_identity.host_id = sha256JSON("other host"); },
    (r: RemoteWorkerCleanupReceiptV3) => { r.observation.host_identity.boot_id = host.boot_id; },
    (r: RemoteWorkerCleanupReceiptV3) => { r.observation.host_identity.platform = "darwin"; },
    (r: RemoteWorkerCleanupReceiptV3) => { r.observation.ownership.host_identity.host_id = sha256JSON("rewritten original host"); },
    (r: RemoteWorkerCleanupReceiptV3) => { r.observation.execution_process!.pid++; },
    (r: RemoteWorkerCleanupReceiptV3) => { Object.assign(r.observation, { worker_status: "terminal" }); },
    (r: RemoteWorkerCleanupReceiptV3) => { Object.assign(r.observation, { docker_resources_empty: false }); },
    (r: RemoteWorkerCleanupReceiptV3) => { Object.assign(r.observation, { process_group_empty: true }); },
    (r: RemoteWorkerCleanupReceiptV3) => { Object.assign(r, { schema_version: "2" }); },
  ]) {
    const receipt = structuredClone(f.receipt); change(receipt);
    await assert.rejects(f.protocol.generationCleanup.commit(f.offer.worker_id, f.offer.offer_id, 2, receipt));
  }
  assert.equal(await f.protocol.generationCleanup.read(f.offer), null);
  assert.deepEqual((await readExecutionLeases(f.evalDirectory))[0], f.lost);
  await assert.rejects(f.protocol.createOffer(f.offer.worker_id, { ...f.lease, lease_id: `lease_${"f".repeat(32)}` }, f.offer.work), /capacity/);
});

test("a legacy admitted execution cannot be upgraded retrospectively to claim a reboot", async t => {
  const f = await workerAdmissionFixture(t), offer = await f.accept(), original = await f.admission();
  const ownership = { ...f.ownership, schema_version: "3" as const, host_identity: host, boot_digest: sha256JSON(host) };
  await assert.rejects(f.client.accept(offer, ownership, f.receipt.sent_at));
  assert.deepEqual(await f.admission(), original);
  await f.registry.register(f.registration);
  const challenge = (await f.protocol.generationCleanup.challenge(offer.worker_id, offer.offer_id, 2)).challenge!;
  await assert.rejects(f.protocol.generationCleanup.commit(offer.worker_id, offer.offer_id, 2, { schema_version: "3", challenge,
    observed_at: new Date().toISOString(), observation: { ownership: f.ownership, execution_process: null,
      host_identity: { ...host, boot_id: sha256JSON("current boot") }, worker_status: "previous-boot", docker_resources_empty: true } }));
  assert.equal(await f.protocol.generationCleanup.read(offer), null);
});

test("background worker publishes the reboot receipt version and replays a lost acknowledgement without executing a candidate", async t => {
  const f = await fixture(t); let cleanups = 0, commits = 0; const bodies: string[] = [];
  const client = new RemoteWorkerHttpClient({ baseUrl: f.baseUrl, credential: f.credential, request: async (url, init) => {
    const commit = String(url).endsWith("/cleanup"); if (commit) { commits++; bodies.push(String(init?.body)); }
    const response = await fetch(url, init);
    if (commit && response.ok && commits === 1) { await response.arrayBuffer(); throw new Error("fixture lost reboot acknowledgement"); }
    return response;
  } });
  const stop = new AbortController(); t.after(() => stop.abort());
  const runner = new RemoteWorkerRunner({ client, capacity: f.registration.capacity.allocatable, once: true, signal: stop.signal,
    pollIntervalMs: 50, heartbeatIntervalMs: 50, retryIntervalMs: 50,
    execute: async () => { assert.fail("previous-boot candidates must never be repeated"); },
    releasePreviousGeneration: async () => { cleanups++; return f.receipt.observation; } });
  await runner.run();
  assert.equal(cleanups, 1); assert.equal(commits, 2); assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[0]!).receipt.schema_version, "3");
  const proof = await f.protocol.generationCleanup.read(f.offer); assert.equal(proof?.schema_version, "3");
  assert.equal((await readExecutionLeases(f.evalDirectory))[0]!.release_confirmation?.receipt_digest, sha256JSON(proof));
});

test("reboot cleanup cannot close a lease that has executed a later resource epoch", async t => {
  const f = await fixture(t), reissued = { ...f.lost, epoch: 3, resource_epochs: [1, 2] };
  await atomicWriteJSON(f.leaseFile, reissued);
  await assert.rejects(f.client.commitCleanup(f.offer, f.receipt));
  assert.deepEqual((await readExecutionLeases(f.evalDirectory))[0], reissued);
});

test("published schemas preserve same-boot receipts and require the distinct reboot observation", async t => {
  const f = await fixture(t);
  const ajv = new Ajv2020({ strict: false, validateFormats: false, loadSchema: async uri => {
    assert.equal(new URL(uri).origin, "https://agent-hitch.local");
    return JSON.parse(await readFile(new URL(`../../docs/schemas/${path.basename(new URL(uri).pathname)}`, import.meta.url), "utf8"));
  } });
  const receipt = await ajv.compileAsync({ $ref: "https://agent-hitch.local/schemas/remote-worker-generation-cleanup.schema.json" });
  const admission = await ajv.compileAsync({ $ref: "https://agent-hitch.local/schemas/remote-worker-execution-admission.schema.json" });
  assert.equal(receipt(f.receipt), true, ajv.errorsText(receipt.errors));
  assert.equal(admission(f.receipt.challenge.admission), true, ajv.errorsText(admission.errors));
  assert.equal(receipt({ ...f.receipt, schema_version: "2" }), false);
  assert.equal(receipt({ ...f.receipt, observation: { ...f.receipt.observation, process_group_empty: true } }), false);
  const legacyOwnership = { ...f.receipt.observation.ownership, schema_version: "2" }; delete (legacyOwnership as { host_identity?: unknown }).host_identity;
  assert.equal(receipt({ ...f.receipt, observation: { ...f.receipt.observation, ownership: legacyOwnership } }), false);
  assert.equal(receipt({ ...f.receipt, challenge: { ...f.receipt.challenge, admission: { ...f.receipt.challenge.admission, ownership: legacyOwnership } } }), false);
});
