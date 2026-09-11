import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RemoteExecutionObservationCoordinator, RemoteWorkerRegistry } from "../src/control-plane/index.js";
import { parseExecutionObservationReceipt } from "../src/control-plane/execution-observation-contract.js";
import { sha256JSON } from "../src/foundation/index.js";
import { observationReceipt, observationRegistration, waitObservation } from "../test-support/execution-observation.js";

async function setup(t: import("node:test").TestContext, timeoutMs = 5000) {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-observation-"));
  const registry = new RemoteWorkerRegistry({ root }); await registry.initialize();
  const registered = await registry.register(observationRegistration());
  const coordinator = new RemoteExecutionObservationCoordinator({ registry, instanceId: "a".repeat(32), timeoutMs });
  t.after(async () => { coordinator.close(); await rm(root, { recursive: true, force: true }); });
  const begin = (nonce = "b".repeat(32), signal = new AbortController().signal) => {
    const pending = coordinator.observe("remote-observed", nonce, signal); void pending.catch(() => {}); return pending;
  };
  const poll = (generation = 1) => waitObservation(() => coordinator.poll("worker_observed", generation));
  return { registry, registered, coordinator, begin, poll };
}

test("fresh worker observations reject mismatched challenges and do not reuse a previous receipt", async t => {
  const f = await setup(t), pending = f.begin(), challenge = await f.poll();
  await assert.rejects(f.begin(), { code: "execution_observation_busy" });
  for (const change of [{ nonce: "c".repeat(32) }, { request_id: "d".repeat(32) }, { daemon_instance_id: "e".repeat(32) }]) {
    await assert.rejects(f.coordinator.submit("worker_observed", observationReceipt({ ...challenge, ...change })), { code: "execution_observation_mismatch" });
  }
  const receipt = observationReceipt(challenge);
  await assert.rejects(f.coordinator.submit("worker_other", receipt), { code: "execution_observation_mismatch" });
  await f.coordinator.submit("worker_observed", receipt);
  assert.deepEqual(await pending, receipt);
  assert.equal(await f.coordinator.poll("worker_observed", 1), null);
  await assert.rejects(f.coordinator.submit("worker_observed", receipt), { code: "execution_observation_mismatch" });
  const second = f.begin(), next = await f.poll();
  assert.equal(next.nonce, challenge.nonce); assert.notEqual(next.request_id, challenge.request_id);
  await assert.rejects(f.coordinator.submit("worker_observed", receipt), { code: "execution_observation_mismatch" });
  await f.coordinator.submit("worker_observed", observationReceipt(next)); await second;
});

test("worker generation rotation and revocation fence observations independently of work leases", async t => {
  const f = await setup(t), pending = f.begin(), old = await f.poll();
  const rotated = await f.registry.register(observationRegistration());
  assert.equal(await f.registry.authenticate("worker_observed", f.registered.token), false);
  await assert.rejects(f.coordinator.submit("worker_observed", observationReceipt(old)), { code: "worker_generation_mismatch" });
  assert.equal(await f.coordinator.poll("worker_observed", rotated.worker.generation), null);
  await assert.rejects(pending, { code: "worker_generation_mismatch" });
  const nextPending = f.begin(), next = await f.poll(2);
  await assert.rejects(f.coordinator.poll("worker_observed", 1), { code: "worker_generation_mismatch" });
  await f.coordinator.submit("worker_observed", observationReceipt(next)); await nextPending;
  await f.registry.revoke("worker_observed");
  await assert.rejects(f.coordinator.submit("worker_observed", observationReceipt(next)), { code: "worker_revoked" });
  await assert.rejects(f.begin(), { code: "execution_provider_unavailable" });
});

test("deadlines, requester disconnect and daemon restart discard pending observations", async t => {
  const f = await setup(t, 150), pending = f.begin(), challenge = await f.poll();
  await assert.rejects(pending, { code: "execution_observation_timeout" });
  await assert.rejects(f.coordinator.submit("worker_observed", observationReceipt(challenge)), { code: "execution_observation_mismatch" });
  const abort = new AbortController(), cancelled = f.begin("c".repeat(32), abort.signal), cancelChallenge = await f.poll();
  abort.abort(); await assert.rejects(cancelled, { code: "execution_observation_cancelled" });
  await assert.rejects(f.coordinator.submit("worker_observed", observationReceipt(cancelChallenge)), { code: "execution_observation_mismatch" });
  const closed = f.begin(); await f.poll(); f.coordinator.close();
  await assert.rejects(closed, { code: "execution_observation_closed" });
  const restarted = new RemoteExecutionObservationCoordinator({ registry: f.registry, instanceId: "d".repeat(32) });
  t.after(() => restarted.close());
  await assert.rejects(restarted.submit("worker_observed", observationReceipt(challenge)), { code: "execution_observation_mismatch" });
  assert.equal(await restarted.poll("worker_observed", 1), null);
});

test("old worker registrations remain readable but cannot provide fresh environment evidence", async t => {
  const f = await setup(t), old = observationRegistration(); delete old.features.execution_observation;
  const saved = await f.registry.register(old);
  assert.equal(sha256JSON(saved.worker.provider_status.features), sha256JSON(old.features));
  assert.equal(Object.hasOwn(saved.worker.provider_status.features, "execution_observation"), false);
  await assert.rejects(f.begin(), { code: "execution_observation_unsupported" });
  await assert.rejects(f.registry.register({ ...old, features: { ...old.features, execution_observation: "1" } }), /features are invalid/);
});

test("worker observation receipts enforce environment integrity and reject extra private fields", async t => {
  const f = await setup(t), pending = f.begin(), challenge = await f.poll();
  const receipt = observationReceipt(challenge);
  assert.throws(() => parseExecutionObservationReceipt({ ...receipt, environment_digest: sha256JSON("another") }), /observation contract/);
  const environment = { ...receipt.environment, credentials: { PRIVATE_KEY: "must-not-cross-boundary" } };
  assert.throws(() => parseExecutionObservationReceipt({ ...receipt, environment, environment_digest: sha256JSON(environment) }), /observation fields/);
  const changed = structuredClone(receipt); changed.runtime.startup.runtime_id = sha256JSON("old-payload");
  assert.throws(() => parseExecutionObservationReceipt(changed), /observation contract/);
  changed.runtime.unchanged = false;
  await f.coordinator.submit("worker_observed", changed);
  assert.equal((await pending).runtime.unchanged, false, "drift is returned as evidence so admission can reject it");
});
