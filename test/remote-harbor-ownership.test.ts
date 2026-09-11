import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import type { RemoteWorkOfferV1, RemoteWorkerExecutionAdmissionV2 } from "../src/domain/index.js";
import { atomicWriteJSON, readJSON, sha256JSON, captureProcessIdentity, runCommand } from "../src/foundation/index.js";
import { beginRemoteHarborOffer, cleanRemoteHarborOffer, prepareRemoteHarborOffer, remoteHarborProcessHooks, settleRemoteHarborOffer, cleanPreviousRemoteHarborGeneration } from "../src/workers/remote-harbor-ownership.js";
import { observeRemoteWorkerHost } from "../src/workers/remote-worker-host.js";
import { dockerOwnershipLabelMap, dockerResourceOwnership } from "../src/evals/index.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-owner-")); t.after(() => rm(root, { recursive: true, force: true }));
  const engine = path.join(root, "engine.json"), calls = path.join(root, "docker-calls.jsonl"), residual = path.join(root, "residual");
  await atomicWriteJSON(engine, { ID: "engine-original" });
  const dockerExecutable = path.join(root, "docker");
  await writeFile(dockerExecutable, `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
if (args[0] === 'info') process.stdout.write(fs.readFileSync(${JSON.stringify(engine)}));
if (args.includes('ls') && args.some(arg=>arg.startsWith('label=io.hitch.lease-id=')) && fs.existsSync(${JSON.stringify(residual)})) console.log('resource-still-present');
`, { mode: 0o755 });
  const resources = { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
  const work = { schema_version: "1" as const, work_id: `work_${"b".repeat(32)}`, eval_id: `eval_${"c".repeat(32)}`, backend: "harbor" as const,
    logical_attempt: 1, task_ids: ["one"], slots: [`slot_${"d".repeat(32)}`], opaque_membership: false, requested_parallelism: 1, reservation: resources, provider: "remote-docker" };
  const lease = { schema_version: "1" as const, lease_id: `lease_${"e".repeat(32)}`, work_id: work.work_id, eval_id: work.eval_id,
    worker_id: "worker_owner", provider: work.provider, collision_domain_id: "docker:owner", reservation: resources,
    state: "offered" as const, epoch: 1, resource_epochs: [1], issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() };
  const offer = { schema_version: "1", offer_id: `offer_${"f".repeat(32)}`, generation: 1, worker_id: lease.worker_id,
    nonce: "a".repeat(32), lease, work, state: "offered", issued_at: lease.issued_at, expires_at: lease.expires_at } as RemoteWorkOfferV1;
  const options = { root, dockerExecutable };
  const directory = path.join(root, "evals", work.eval_id);
  const journal = path.join(directory, "remote-work", work.work_id, "epoch-000001", "worker-execution.json");
  const leaseFile = path.join(directory, "leases", `${lease.lease_id}.json`);
  const settle = async () => { await prepareRemoteHarborOffer(options, offer); await beginRemoteHarborOffer(options, offer); await settleRemoteHarborOffer(options, offer); };
  return { root, engine, calls, residual, offer, options, journal, leaseFile, settle };
}

test("missing ownership is not a resource release proof", async t => {
  const f = await fixture(t);
  await assert.rejects(cleanRemoteHarborOffer(f.options, f.offer), /ownership record is missing/);
  await assert.rejects(readFile(f.calls), { code: "ENOENT" });
});

for (const state of ["alive", "dead", "changed-process", "released-residual"] as const) test(`cross-generation cleanup observes original ownership and physical state: ${state}`, async t => {
  const f = await fixture(t), initialOwnership = await prepareRemoteHarborOffer(f.options, f.offer);
  await beginRemoteHarborOffer(f.options, f.offer); await settleRemoteHarborOffer(f.options, f.offer);
  const original = spawn(process.execPath, ["-e", "process.send('ready'); setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = once(original, "exit"); await once(original, "message");
  t.after(async () => { if (original.exitCode === null && original.signalCode === null) original.kill("SIGKILL"); await exited; });
  const owner = await captureProcessIdentity(original.pid!); assert.ok(owner);
  const ownership = { ...initialOwnership, worker_process: owner };
  const offer = { ...f.offer, state: "accepted" as const, accepted_at: new Date().toISOString(), accept_receipt_digest: sha256JSON("accepted") };
  const admission: RemoteWorkerExecutionAdmissionV2 = { schema_version: "2", offer_id: offer.offer_id, worker_id: offer.worker_id, generation: offer.generation,
    lease_id: offer.lease.lease_id, execution_epoch: offer.lease.epoch, accepted_at: offer.accepted_at, ownership, ownership_digest: sha256JSON(ownership), execution_process: null };
  await atomicWriteJSON(f.journal, { ...await readJSON<object>(f.journal), owner,
    ...(state === "changed-process" ? { process: await captureProcessIdentity(process.pid) } : {}),
    ...(state === "released-residual" ? { phase: "released" } : {}) });
  if (state !== "alive") { original.kill("SIGTERM"); await exited; }
  if (state === "released-residual") await writeFile(f.residual, "owned-resource-remains");
  if (state === "dead") {
    const proof = await cleanPreviousRemoteHarborGeneration(f.options, offer, admission);
    assert.equal(proof.worker_status, "terminal"); assert.equal(proof.process_group_empty, true); assert.equal(proof.docker_resources_empty, true);
    assert.equal((await readJSON<{ phase: string }>(f.journal)).phase, "released");
  } else {
    await assert.rejects(cleanPreviousRemoteHarborGeneration(f.options, offer, admission));
    if (state !== "released-residual") assert.equal((await readJSON<{ state: string }>(f.leaseFile)).state, "running");
  }
});

test("admission is idempotent before execution and prevents duplicate execution", async t => {
  const f = await fixture(t); await prepareRemoteHarborOffer(f.options, f.offer);
  const original = await readFile(f.journal); await prepareRemoteHarborOffer(f.options, f.offer);
  assert.deepEqual(await readFile(f.journal), original);
  await beginRemoteHarborOffer(f.options, f.offer);
  await assert.rejects(beginRemoteHarborOffer(f.options, f.offer), /cannot execute twice/);
  await assert.rejects(prepareRemoteHarborOffer(f.options, f.offer), /cannot execute twice/);
  await assert.rejects(cleanRemoteHarborOffer(f.options, f.offer), /original worker is still running/);
  assert.equal((await readJSON<{ state: string }>(f.leaseFile)).state, "running");
  await settleRemoteHarborOffer(f.options, f.offer); await cleanRemoteHarborOffer(f.options, f.offer);
  assert.equal((await readJSON<{ phase: string }>(f.journal)).phase, "released");
});

test("failure after acceptance but before executor entry can release its prepared ownership", async t => {
  const f = await fixture(t); await prepareRemoteHarborOffer(f.options, f.offer);
  await cleanRemoteHarborOffer(f.options, f.offer);
  await assert.rejects(beginRemoteHarborOffer(f.options, f.offer), /cannot execute twice/);
  assert.equal((await readJSON<{ phase: string }>(f.journal)).phase, "released");
});

for (const mutation of ["generation", "nonce", "lease", "root", "engine", "boot"] as const) {
  test(`cleanup refuses changed ${mutation} ownership before releasing its local lease`, async t => {
    const f = await fixture(t); await f.settle(); let options = f.options, offer = f.offer;
    if (mutation === "generation") offer = { ...offer, generation: 2 };
    if (mutation === "nonce") offer = { ...offer, nonce: "b".repeat(32) };
    if (mutation === "lease") offer = { ...offer, lease: { ...offer.lease, epoch: 2 } };
    if (mutation === "engine") await atomicWriteJSON(f.engine, { ID: "engine-other" });
    if (mutation === "boot") await atomicWriteJSON(f.journal, { ...await readJSON<object>(f.journal), boot_digest: `sha256:${"0".repeat(64)}` });
    if (mutation === "root") { const alias = `${f.root}-alias`; await symlink(f.root, alias); t.after(() => rm(alias)); options = { ...options, root: alias }; }
    await assert.rejects(cleanRemoteHarborOffer(options, offer));
    assert.equal((await readJSON<{ state: string }>(f.leaseFile)).state, "running");
    assert.equal((await readJSON<{ phase: string }>(f.journal)).phase, "settled");
  });
}

test("post-cleanup resource observation prevents acknowledgement and can be retried", async t => {
  const f = await fixture(t); await f.settle(); await writeFile(f.residual, "remaining");
  await assert.rejects(cleanRemoteHarborOffer(f.options, f.offer), /remain after cleanup/);
  assert.equal((await readJSON<{ phase: string }>(f.journal)).phase, "cleaning");
  await rm(f.residual); await cleanRemoteHarborOffer(f.options, f.offer);
  assert.equal((await readJSON<{ phase: string }>(f.journal)).phase, "released");
});

test("a Harbor process that refuses termination keeps the lease reserved", async t => {
  const f = await fixture(t); await prepareRemoteHarborOffer(f.options, f.offer); await beginRemoteHarborOffer(f.options, f.offer);
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); process.send('ready'); setInterval(()=>{},1000)"],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = once(child, "exit"); t.after(async () => { child.kill("SIGKILL"); await exited; });
  await once(child, "message"); child.disconnect();
  await remoteHarborProcessHooks(f.options, f.offer).onProcessStarted(child.pid!); await settleRemoteHarborOffer(f.options, f.offer);
  await assert.rejects(cleanRemoteHarborOffer(f.options, f.offer), /process group has not stopped/);
  assert.equal((await readJSON<{ state: string }>(f.leaseFile)).state, "running");
  child.kill("SIGKILL"); await exited;
  await cleanRemoteHarborOffer(f.options, f.offer);
  assert.equal((await readJSON<{ phase: string }>(f.journal)).phase, "released");
});

test("new ownership records a stable host and separate boot identity before work starts", async t => {
  const f = await fixture(t), first = await observeRemoteWorkerHost(), second = await observeRemoteWorkerHost();
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first).sort(), ["boot_id", "host_id", "platform", "schema_version"]);
  assert.match(first.host_id, /^sha256:[a-f0-9]{64}$/); assert.match(first.boot_id, /^sha256:[a-f0-9]{64}$/);
  const ownership = await prepareRemoteHarborOffer(f.options, f.offer);
  assert.equal(ownership.schema_version, "3"); assert.deepEqual(ownership.host_identity, first);
  assert.equal(ownership.boot_digest, sha256JSON(first));
  assert.equal((await readJSON<{ schema_version: string }>(f.journal)).schema_version, "2");
});

async function rebootFixture(t: test.TestContext) {
  const f = await fixture(t), current = await prepareRemoteHarborOffer(f.options, f.offer);
  assert.equal(current.schema_version, "3");
  // A live process deliberately reuses the recorded old supervisor PID. Reboot
  // cleanup must neither inspect this process group nor signal it.
  const child = spawn(process.execPath, ["-e", "process.send('ready'); setInterval(()=>{},1000)"],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = once(child, "exit"); await once(child, "message"); child.disconnect();
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  const supervisor = await captureProcessIdentity(child.pid!); assert.ok(supervisor);
  const host = { ...current.host_identity, boot_id: sha256JSON("fixture previous boot") };
  const ownership = { ...current, host_identity: host, boot_digest: sha256JSON(host) };
  const original = await readJSON<Record<string, unknown>>(f.journal);
  await atomicWriteJSON(f.journal, { ...original, host_identity: host, boot_digest: ownership.boot_digest, process: supervisor, phase: "executing" });
  const offer = { ...f.offer, state: "accepted" as const, accepted_at: new Date().toISOString(), accept_receipt_digest: sha256JSON("accepted") };
  const admission: RemoteWorkerExecutionAdmissionV2 = { schema_version: "2", offer_id: offer.offer_id, worker_id: offer.worker_id, generation: offer.generation,
    lease_id: offer.lease.lease_id, execution_epoch: offer.lease.epoch, accepted_at: offer.accepted_at, ownership, ownership_digest: sha256JSON(ownership), execution_process: supervisor };
  return { ...f, current, ownership, offer, admission, child };
}

for (const generation of ["same", "new"] as const) test(`host reboot cleanup leaves reused PIDs alone in the ${generation} worker generation`, async t => {
  const f = await rebootFixture(t);
  await assert.rejects(beginRemoteHarborOffer(f.options, f.offer), /differs/);
  await assert.rejects(prepareRemoteHarborOffer(f.options, f.offer), /differs/);
  const before = await readJSON<Record<string, unknown>>(f.journal);
  if (generation === "same") await cleanRemoteHarborOffer(f.options, f.offer);
  else {
    const proof = await cleanPreviousRemoteHarborGeneration(f.options, f.offer, f.admission);
    assert.equal(proof.worker_status, "previous-boot"); assert.deepEqual(proof.host_identity, f.current.host_identity);
    assert.deepEqual(proof.ownership, f.ownership); assert.deepEqual(proof.execution_process, f.admission.execution_process);
    assert.equal("process_group_empty" in proof, false, "old PID groups are not observed after reboot");
  }
  assert.equal(f.child.exitCode, null); assert.equal(f.child.signalCode, null); process.kill(f.child.pid!, 0);
  assert.deepEqual(await readJSON(f.journal), { ...before, phase: "released" });
  assert.equal((await readJSON<{ state: string }>(f.leaseFile)).state, "released");
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
  assert.equal(calls.filter(args => args.includes("ls") && args.some(arg => arg.startsWith("label=io.hitch.lease-id="))).length, 3);
});

for (const changed of ["host", "engine", "legacy", "supervisor"] as const) test(`reboot cleanup rejects ${changed} drift without releasing the original lease`, async t => {
  const f = await rebootFixture(t);
  const record = await readJSON<Record<string, unknown>>(f.journal);
  if (changed === "host") {
    f.ownership.host_identity.host_id = sha256JSON("another host"); f.ownership.boot_digest = sha256JSON(f.ownership.host_identity);
    await atomicWriteJSON(f.journal, { ...record, host_identity: f.ownership.host_identity, boot_digest: f.ownership.boot_digest });
    f.admission.ownership_digest = sha256JSON(f.ownership);
  }
  if (changed === "engine") await atomicWriteJSON(f.engine, { ID: "another-engine" });
  if (changed === "legacy") {
    delete record.host_identity; await atomicWriteJSON(f.journal, { ...record, schema_version: "1" });
  }
  if (changed === "supervisor") f.admission.execution_process = { ...f.admission.execution_process!, pid: f.child.pid! + 1 };
  await assert.rejects(cleanPreviousRemoteHarborGeneration(f.options, f.offer, f.admission));
  assert.equal((await readJSON<{ state: string }>(f.leaseFile)).state, "running");
  assert.equal(f.child.exitCode, null); assert.equal(f.child.signalCode, null);
});

test("reboot cleanup reobserves residual Docker resources and retries without changing original host ownership", async t => {
  const f = await rebootFixture(t), before = await readJSON<Record<string, unknown>>(f.journal);
  await writeFile(f.residual, "remaining");
  await assert.rejects(cleanPreviousRemoteHarborGeneration(f.options, f.offer, f.admission), /remain after cleanup/);
  assert.deepEqual(await readJSON(f.journal), { ...before, phase: "cleaning" });
  await rm(f.residual);
  const proof = await cleanPreviousRemoteHarborGeneration(f.options, f.offer, f.admission);
  assert.equal(proof.worker_status, "previous-boot"); assert.deepEqual(proof.ownership, f.ownership);
  assert.deepEqual(await readJSON(f.journal), { ...before, phase: "released" });
  assert.equal(f.child.exitCode, null); assert.equal(f.child.signalCode, null);
});

test("legacy same-boot ownership remains readable and is never upgraded implicitly", async t => {
  const f = await fixture(t); await f.settle();
  const boot = process.platform === "linux" ? (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
    : (await runCommand("/usr/sbin/sysctl", ["-n", "kern.boottime"], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } })).stdout.trim();
  const original = await readJSON<Record<string, unknown>>(f.journal); delete original.host_identity;
  const record = { ...original, schema_version: "1", boot_digest: sha256JSON({ host: hostname(), platform: process.platform, boot }) };
  await atomicWriteJSON(f.journal, record); await cleanRemoteHarborOffer(f.options, f.offer);
  assert.deepEqual(await readJSON(f.journal), { ...record, phase: "released" });
});

test("reboot cleanup deletes the original Docker resource classes and retains another lease", async t => {
  const f = await rebootFixture(t), labels = dockerOwnershipLabelMap(dockerResourceOwnership(f.root, f.offer.lease, "one"));
  const stateFile = path.join(f.root, "docker-state.json");
  const foreign = { id: "another-lease", kind: "container", labels: { ...labels, "io.hitch.lease-id": `lease_${"1".repeat(32)}` } };
  await atomicWriteJSON(stateFile, [...["container", "network", "volume"].map(kind => ({ id: `old-${kind}`, kind, labels })), foreign]);
  await writeFile(f.options.dockerExecutable, `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(f.calls)}, JSON.stringify(args)+'\\n');
if (args[0] === 'info') { process.stdout.write(fs.readFileSync(${JSON.stringify(f.engine)})); process.exit(0); }
const stateFile = ${JSON.stringify(stateFile)}, state = JSON.parse(fs.readFileSync(stateFile));
const [kind, operation] = args;
if (operation === 'ls') {
  const filters = args.filter(arg=>arg.startsWith('label=')).map(arg=>arg.slice(6).split('='));
  process.stdout.write(state.filter(item=>item.kind===kind && filters.every(([key,value])=>item.labels[key]===value)).map(item=>item.id).join('\\n'));
} else if (operation === 'inspect') {
  const item = state.find(item=>item.id===args[2] && item.kind===kind); if (!item) process.exit(1);
  console.log(JSON.stringify([kind==='container'?{Id:item.id,Config:{Labels:item.labels}}:kind==='volume'?{Name:item.id,Labels:item.labels}:{Id:item.id,Labels:item.labels}]));
} else if (operation === 'rm') {
  fs.writeFileSync(stateFile, JSON.stringify(state.filter(item=>!(item.kind===kind && item.id===args.at(-1)))));
} else process.exit(1);
`, { mode: 0o755 });
  const proof = await cleanPreviousRemoteHarborGeneration(f.options, f.offer, f.admission);
  assert.equal(proof.worker_status, "previous-boot"); assert.equal(proof.docker_resources_empty, true);
  assert.deepEqual(await readJSON(stateFile), [foreign]);
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
  assert.deepEqual(calls.filter(args => args[1] === "rm").map(args => args.at(-1)).sort(), ["old-container", "old-network", "old-volume"]);
  assert.equal(calls.filter(args => args[1] === "inspect" && args[2] === "old-container").length, 2);
  assert.equal(f.child.exitCode, null); assert.equal(f.child.signalCode, null);
});
