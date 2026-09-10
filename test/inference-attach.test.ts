import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256JSON, statePaths } from "../src/foundation/index.js";
import { ProcessSGLangLauncher, SGLangServiceSupervisor } from "../src/inference/index.js";
import type { SGLangAttachInput } from "../src/inference/index.js";
import { inferenceAttachmentFixture } from "../test-support/inference-attachment.js";

async function fixture(t: test.TestContext) {
  const temporary = await mkdtemp(path.join(tmpdir(), "hitch-attach-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  return inferenceAttachmentFixture(temporary);
}

test("process attachment is replayable, keeps original probe evidence and never warms or flushes the active engine", async t => {
  const f = await fixture(t);
  for (let n = 0; n < 2; n++) {
    const service = await f.launcher.attach(f.attach);
    assert.deepEqual(service.service_handle, f.record.service_handle); assert.deepEqual(service.observation, f.observation);
    assert.equal(JSON.stringify(service.observation).includes("fixture-private"), false);
  }
  assert.deepEqual(f.calls, ["attach", "route", "GET /v1/models", "attach", "route", "GET /v1/models"]);
});

test("attachment snapshots startup evidence before an asynchronous reply", async t => {
  const f = await fixture(t);
  const original = structuredClone(f.observation);
  f.client.attach = async () => {
    Object.assign(f.attach, { observation: undefined });
    f.attach.record.epoch++;
    return structuredClone(f.status);
  };
  const service = await f.launcher.attach(f.attach);
  assert.deepEqual(service.observation, original);
  assert.deepEqual(f.calls, ["route", "GET /v1/models"]);
  f.attach.observation = original;
  f.client.attach = async input => { Object.assign(input, { observation: undefined }); return structuredClone(f.status); };
  await assert.rejects(f.launcher.attach(f.attach), /original protocol\/runtime evidence/);
  assert.equal(f.calls.some(call => /POST|flush/.test(call)), false);
});

test("attachment refuses drift and lost replies without entering startup cleanup", async t => {
  const f = await fixture(t), original = structuredClone(f.status);
  const changes = [
    { state: "stopped" }, { resourcesReleased: true }, { inputDigest: sha256JSON("another-start") }, { handle: null },
    { handle: { ...f.record.service_handle, process: { pid: 42, created_at: 9 } } },
    { runtime: { ...(f.status.runtime as object), pythonVersion: "3.13.0" } },
    { serverInfo: { ...(f.status.serverInfo as object), dtype: "float32" } }, { gpuUuid: "GPU-other" },
    { access: { ...(f.status.access as object), wireModel: "another-model" } },
  ];
  for (const change of changes) {
    Object.assign(f.status, original, change);
    await assert.rejects(f.launcher.attach(f.attach));
  }
  Object.assign(f.status, original);
  f.client.attach = async () => { throw new Error("reply lost"); };
  await assert.rejects(f.launcher.attach(f.attach), /reply lost/);
  assert.equal(f.calls.some(call => /stop|start|prepare|POST|flush/.test(call)), false);
});

test("missing probe evidence, foreign generations and route failures never trigger warmup or stop", async t => {
  const f = await fixture(t);
  for (const input of [
    { ...f.attach, observation: undefined },
    { ...f.attach, observation: { ...f.observation, probe: { ...f.observation.probe, streaming: false } } },
    { ...f.attach, record: { ...f.record, model_node: { ...f.record.model_node, generation: "other-boot" } } },
  ]) await assert.rejects(f.launcher.attach(input as SGLangAttachInput));
  const launcher = new ProcessSGLangLauncher(f.client, async () => Response.json({ data: [{ id: "another-model" }] }));
  await assert.rejects(launcher.attach(f.attach), /another model/);
  f.client.route = async () => { throw new Error("route unavailable"); };
  await assert.rejects(f.launcher.attach(f.attach), /route unavailable/);
  assert.equal(f.calls.some(call => /stop|start|prepare|POST|flush/.test(call)), false);
});

async function priorService(t: test.TestContext) {
  const f = await fixture(t), supervisor = new SGLangServiceSupervisor({ root: f.root, launcher: f.launcher, healthIntervalMs: 60_000 });
  const lease = await supervisor.acquire({ ...f.input, isolationKey: f.record.isolation_key, ownerId: f.record.owner_id });
  const record = (await supervisor.list())[0]!;
  const directory = path.join(statePaths(f.root).inferenceServices, lease.service_id);
  const state = await readFile(path.join(directory, "state.json"));
  const attachment = await readFile(path.join(directory, "attachment.json"));
  // The process peer is a fixture. Restore only the persisted crash boundary
  // after disposing the previous supervisor's timers; no real GPU is involved.
  await supervisor.close(); await writeFile(path.join(directory, "state.json"), state); f.calls.length = 0;
  return { ...f, record, directory, state, attachment, claims: [{ service_id: record.service_id, owner_ids: [record.owner_id] }] };
}

test("supervisor reattaches explicitly claimed live owners with original service/epoch and releasable leases", async t => {
  const f = await priorService(t), supervisor = new SGLangServiceSupervisor({ root: f.root, launcher: f.launcher });
  t.after(() => supervisor.close());
  const [restored] = await supervisor.recover(f.claims); assert.ok(restored);
  assert.equal(restored.record.service_id, f.record.service_id); assert.equal(restored.record.epoch, f.record.epoch);
  assert.equal(restored.lock.inference_id, f.record.inference_id);
  assert.deepEqual(restored.record.service_handle, f.record.service_handle);
  assert.deepEqual(f.calls, ["attach", "route", "GET /v1/models"]);
  assert.deepEqual(await readFile(path.join(f.directory, "attachment.json")), f.attachment);
  await assert.rejects(supervisor.stop(f.record.service_id), /active leases/);
  const lease = restored.owners.get(f.record.owner_id)!; assert.equal(lease.isReady(), true);
  await lease.release(); await lease.release();
  assert.deepEqual((await supervisor.list())[0]!.lease_owner_ids, []);
  await supervisor.stop(f.record.service_id); assert.equal(f.calls.filter(call => call === "stop").length, 1);
  const next = await supervisor.acquire({ ...f.input, isolationKey: f.record.isolation_key, ownerId: f.record.owner_id });
  assert.notEqual(next.service_id, f.record.service_id); assert.equal(next.epoch, f.record.epoch + 1);
});

test("unverified owners and missing/corrupt startup evidence keep the original service untouched", async t => {
  const f = await priorService(t);
  for (const claims of [[{ service_id: f.record.service_id, owner_ids: ["foreign"] }], [...f.claims, ...f.claims]]) {
    const supervisor = new SGLangServiceSupervisor({ root: f.root, launcher: f.launcher });
    await assert.rejects(supervisor.recover(claims), /claims/); await supervisor.close();
  }
  const evidenceFile = path.join(f.directory, "attachment.json");
  for (const kind of ["missing", "corrupt"]) {
    if (kind === "missing") await rm(evidenceFile);
    else { const evidence = JSON.parse(f.attachment.toString()); evidence.attachment.inputs.lock.generation.seed++; await writeFile(evidenceFile, JSON.stringify(evidence)); }
    const supervisor = new SGLangServiceSupervisor({ root: f.root, launcher: f.launcher });
    await assert.rejects(supervisor.recover(f.claims), /startup evidence/);
    await assert.rejects(supervisor.acquire({ ...f.input, isolationKey: f.record.isolation_key, ownerId: f.record.owner_id }), /ambiguous/);
    await supervisor.close();
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(await readFile(path.join(f.directory, "state.json")), f.state);
});

test("unclaimed model-node services retain the legacy drain recovery behavior", async t => {
  const f = await priorService(t), supervisor = new SGLangServiceSupervisor({ root: f.root, launcher: f.launcher });
  await supervisor.recover(); assert.deepEqual(f.calls, ["stop"]);
  assert.equal((await supervisor.list())[0]!.state, "stopped"); await supervisor.close();
});

test("closing during a delayed attachment waits for reconciliation without reviving or stopping prior ownership", async t => {
  const f = await priorService(t);
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const attach = f.client.attach!;
  f.client.attach = async input => { entered(); await gate; return attach(input); };
  const supervisor = new SGLangServiceSupervisor({ root: f.root, launcher: f.launcher });
  const recovering = supervisor.recover(f.claims); await started;
  const rejected = assert.rejects(recovering, /closed before attachment/);
  await assert.rejects(supervisor.recover(f.claims), /unused supervisor/);
  await assert.rejects(supervisor.acquire({ ...f.input, isolationKey: f.record.isolation_key, ownerId: f.record.owner_id }), /still coordinating/);
  let closed = false; const closing = supervisor.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); resume(); await rejected; await closing;
  assert.equal(f.calls.includes("stop"), false); assert.equal(f.calls.includes("start"), false);
  assert.deepEqual(await readFile(path.join(f.directory, "state.json")), f.state);
});
