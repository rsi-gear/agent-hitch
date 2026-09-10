import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DaemonServer } from "../src/daemon/index.js";
import { LocalInferenceManager, RemoteWorkerHttpClient } from "../src/control-plane/index.js";
import { SGLangServiceSupervisor } from "../src/inference/index.js";
import type { SGLangRecoveryClaim } from "../src/inference/index.js";
import { atomicWriteJSON, delay, readJSON, statePaths } from "../src/foundation/index.js";
import { managedRecoveryFixture } from "../test-support/managed-service-recovery.js";

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!await check()) { assert.ok(Date.now() < deadline, "recovered owner did not reconcile"); await delay(20); }
}

test("recovered model gateway retains its private route and canonical run, then retires the original owner", async t => {
  const f = await managedRecoveryFixture(t);
  assert.equal((await f.generate()).status, 200); await f.crash();
  const manager = await f.resume();
  assert.equal((await f.generate()).status, 200);
  const restored = (await manager.list())[0]!;
  assert.equal(restored.service_id, f.record.service_id); assert.equal(restored.epoch, f.record.epoch);
  assert.deepEqual(restored.service_handle, f.record.service_handle);
  assert.deepEqual(f.calls.slice(0, 2), ["attach", "route"]); assert.equal(f.calls.some(call => /start|flush|POST/.test(call)), false);
  await f.verifyOriginal();
  await f.worker.complete(f.accepted, "failed", []);
  await eventually(async () => (await manager.list())[0]!.lease_owner_ids.length === 0);
  await assert.rejects(f.generate());
  assert.equal((await fetch(new URL("models", f.modelLease.binding.base_url), { headers: { authorization: `Bearer ${f.modelLease.credential}` } })).status, 401);
});

test("resumed eval takes over the recovered lease once and preserves its original execution evidence", async t => {
  const f = await managedRecoveryFixture(t); await f.crash(); const manager = await f.resume();
  await assert.rejects(manager.acquire({ ...f.input, evidence_owner: { kind: "eval", eval_id: `eval_${"0".repeat(32)}` } }), /original service/);
  const lease = await manager.acquire(f.input);
  assert.equal(lease.service_id, f.record.service_id); assert.equal(lease.service_epoch, f.record.epoch);
  assert.deepEqual(lease.binding, f.modelLease.binding); assert.equal(lease.credential, f.modelLease.credential);
  await f.worker.complete(f.accepted, "failed", []); await delay(30);
  assert.deepEqual((await manager.list())[0]!.lease_owner_ids, [f.runId]);
  await lease.release(); await lease.release();
  assert.deepEqual((await manager.list())[0]!.lease_owner_ids, []); await f.verifyOriginal();
});

test("reacquiring the same managed service preserves original evidence and rejects altered source files", async t => {
  const f = await managedRecoveryFixture(t);
  await f.modelLease.release();
  const lease = await f.original.acquire(f.input); await f.verifyOriginal(); await lease.release();
  const directory = path.join(f.sourceDirectory, "inference");
  for (const name of ["execution.json", "lock.json", "model.manifest.json", "runtime.manifest.json"]) {
    const file = path.join(directory, name), original = await readFile(file);
    const altered = { ...JSON.parse(original.toString()), ...(name === "execution.json" ? { prepared_at: "invalid-time" } : { changed: true }) };
    await atomicWriteJSON(file, altered);
    await assert.rejects(f.original.acquire(f.input), /original managed inference .* evidence changed/);
    assert.deepEqual(await readJSON(file), altered, "failed acquisition must not replace the original evidence");
    assert.deepEqual((await f.original.list())[0]!.lease_owner_ids, []);
    await writeFile(file, original);
  }
  const next = await f.original.acquire(f.input); await next.release(); await f.verifyOriginal();
});

test("rerun gateways use their own owner and cancellation authority even when the source eval is terminal", async t => {
  const f = await managedRecoveryFixture(t, { rerun: true });
  await atomicWriteJSON(path.join(f.evalDirectory, "control.json"), { ...f.control, state: "succeeded" });
  await f.crash(); const manager = await f.resume(); assert.equal((await f.generate()).status, 200);
  await atomicWriteJSON(path.join(f.sourceDirectory, "cancellation.json"), { schema_version: "1", eval_id: f.control.eval_id, rerun_id: f.rerunId });
  await eventually(async () => (await manager.list())[0]!.lease_owner_ids.length === 0); await assert.rejects(f.generate());
});

test("expired, revoked and replaced worker generations cannot acquire the old model owner", async t => {
  const f = await managedRecoveryFixture(t); await f.crash();
  const file = path.join(f.evalDirectory, "leases", `${f.lease.current().lease_id}.json`), original = await readJSON<Record<string, unknown>>(file);
  await atomicWriteJSON(file, { ...original, expires_at: new Date(Date.now() - 1).toISOString() });
  assert.deepEqual(await f.recovery.select([f.record]), []); await atomicWriteJSON(file, original);
  await f.registry.revoke(f.registration.worker_id); assert.deepEqual(await f.recovery.select([f.record]), []);
  await f.registry.register(f.registration); assert.deepEqual(await f.recovery.select([f.record]), []);
  assert.deepEqual(f.calls, []);
});

test("missing gateway receipts and tampered private credentials refuse recovery before touching the engine", async t => {
  const f = await managedRecoveryFixture(t); await f.crash();
  const routeFile = path.join(statePaths(f.root).workerProtocol, "model-routes", f.lease.current().lease_id, "route.json");
  const route = await readJSON<{ target: { credential: string } }>(routeFile);
  await atomicWriteJSON(routeFile, { ...route, target: { ...route.target, credential: "0".repeat(64) } });
  await assert.rejects(f.recovery.select([f.record]), /gateway receipt/); await atomicWriteJSON(routeFile, route);
  const directory = path.join(f.serviceDirectory, "gateways");
  for (const file of await readdir(directory)) await rm(path.join(directory, file));
  await assert.rejects(f.recovery.select([f.record]), /gateway receipt/); assert.deepEqual(f.calls, []);
});

test("daemon startup restores the original managed route for an authenticated active worker", async t => {
  const f = await managedRecoveryFixture(t); await f.crash(); await f.prepareDaemonPeer(500);
  // The execution and CUDA observations are fixtures. This tests the actual
  // daemon startup/HTTP path; it does not execute Harbor or import an assessment.
  const events: unknown[] = [];
  const daemon = new DaemonServer({ root: f.root, port: 0, maxConcurrent: 1, discoverHarnesses: async () => [], logger: (type, fields) => events.push({ type, fields }) });
  const startup = daemon.start();
  f.cleanups.push(async () => { await startup.catch(() => {}); await daemon.close(); });
  await eventually(async () => (await readFile(f.peerCalls, "utf8").catch(() => "")).includes("inference.attach"));
  const worker = new RemoteWorkerHttpClient({ baseUrl: `http://127.0.0.1:${daemon.port}`, credential: f.credential });
  let delivered = false;
  const generating = f.generate(worker); void generating.then(() => { delivered = true; }, () => { delivered = true; });
  await delay(30); assert.equal(delivered, false, "managed requests wait while the gateway is being restored");
  const [, response] = await Promise.all([startup, generating]); assert.equal(response.status, 200);
  assert.equal((await worker.relayModel(f.accepted, f.canonicalRun, "bind", null, f.signal)).status, 200);
  await assert.rejects(worker.relayModel(f.accepted, `run_${"0".repeat(32)}`, "bind", null, f.signal));
  assert.ok((await readFile(f.peerCalls, "utf8")).includes("inference.attach"));
  assert.equal((await readFile(f.peerCalls, "utf8")).includes("inference.start"), false);
  assert.equal(JSON.stringify(events).includes(f.modelLease.credential), false); await f.verifyOriginal();
});

test("chat completions keep the locked budget and reject response-only or conflicting parameters", async t => {
  const f = await managedRecoveryFixture(t);
  const payload = { messages: [{ role: "user", content: "hello" }], max_tokens: 4 };
  assert.equal((await f.worker.relayModel(f.accepted, f.canonicalRun, "generate", { payload }, f.signal)).status, 200);
  assert.deepEqual(f.bodies[0]!.messages, payload.messages); assert.equal(f.bodies[0]!.max_tokens, 4);
  assert.equal(f.bodies[0]!.n, 1); assert.equal(f.bodies[0]!.seed, f.prepared.lock.generation.seed);
  assert.equal(f.bodies[0]!.max_output_tokens, undefined); assert.equal(f.bodies[0]!.truncation, undefined);
  for (const extra of [{ max_output_tokens: 4 }, { seed: f.prepared.lock.generation.seed + 1 }, { n: 2 }, { max_completion_tokens: 4 },
    { messages: [] }, { stream_options: { hidden: true } }, { temperature: 99 }]) {
    await assert.rejects(f.worker.relayModel(f.accepted, f.canonicalRun, "generate", { payload: { ...payload, ...extra } }, f.signal));
  }
  assert.equal(f.bodies.length, 1);
});

test("an offline worker retains its unexpired model owner, then rejoins or expires without reallocation", async t => {
  const f = await managedRecoveryFixture(t, { heartbeatTtlMs: 1_000 }); await f.crash(); await delay(1_050);
  const manager = await f.resume();
  assert.equal(await (await f.recovery.select([f.record]))[0]!.state(), "waiting");
  await delay(25); assert.deepEqual((await manager.list())[0]!.lease_owner_ids, [f.runId]);
  await assert.rejects(f.generate());
  await f.registry.heartbeat(f.registration.worker_id, { schema_version: "1", generation: f.credential.generation, health: "healthy",
    allocated: f.registration.capacity.total, active_leases: [{ lease_id: f.lease.current().lease_id, epoch: f.lease.current().epoch }], sent_at: new Date().toISOString() });
  assert.equal((await f.generate()).status, 200); assert.equal(f.calls.includes("start"), false);
  const file = path.join(f.evalDirectory, "leases", `${f.lease.current().lease_id}.json`);
  await atomicWriteJSON(file, { ...await readJSON<Record<string, unknown>>(file), expires_at: new Date(Date.now() - 1).toISOString() });
  await eventually(async () => (await manager.list())[0]!.lease_owner_ids.length === 0);
  await assert.rejects(f.generate());
});

test("a resumed acquisition waits for an in-flight recovered owner release before registering again", async t => {
  const f = await managedRecoveryFixture(t); await f.crash();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  class DelayedRelease extends SGLangServiceSupervisor {
    override async recover(claims: readonly SGLangRecoveryClaim[] = []) {
      const restored = await super.recover(claims);
      for (const service of restored) for (const lease of service.owners.values()) {
        const original = lease.release;
        lease.release = async () => { entered(); await gate; await original(); };
      }
      return restored;
    }
  }
  const manager = new LocalInferenceManager({ root: f.root, recovery: f.recovery, recoveryPollIntervalMs: 10,
    supervisor: new DelayedRelease({ root: f.root, launcher: f.launcher }), preflight: async () => f.prepared });
  f.cleanups.push(async () => { release(); await manager.close(); }); await manager.initialize();
  await f.worker.complete(f.accepted, "failed", []); await started;
  let acquired = false;
  const pending = manager.acquire(f.input).then(lease => { acquired = true; return lease; });
  await delay(25); assert.equal(acquired, false); release();
  const lease = await pending;
  assert.equal(lease.service_id, f.record.service_id); assert.notEqual(lease.credential, f.modelLease.credential);
  assert.equal(f.calls.includes("start"), false); await lease.release();
});
