import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ResourceStore, auditResources, canonical, hash, parseResourceLock, parseStrictJson, parseTree, type Resource, type TaskResourceLock } from "../src/resources/index.js";

const lockFor = (resources: Record<string, Resource>): TaskResourceLock => ({ protocol: "hitch-resource-lock@1", resources, bindings: [], requiredCapabilities: [] });
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hitch-resources-")); t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); await mkdir(path.join(source, "empty"), { recursive: true });
  await writeFile(path.join(source, "program"), "echo fixture\n", { mode: 0o755 }); await writeFile(path.join(source, "data"), "same content");
  return { root, source, store: new ResourceStore(path.join(root, "hitch"), { limits: { minFreeBytes: 0 } }) };
}

test("resource lock rejects unknown fields, duplicate IDs, collisions and invalid role/use combinations", () => {
  const resource: Resource = { kind: "blob", digest: hash("hello"), size: 5 }, base = lockFor({ input: resource });
  assert.deepEqual(parseResourceLock(base), base);
  assert.throws(() => parseStrictJson('{"resources":{"a":1,"a":2}}'), /duplicate/);
  assert.throws(() => parseResourceLock({ ...base, surprise: true }), /unknown/);
  const binding = { resource: "input", consumer: { role: "candidate" }, use: "input-file", target: "data", executable: false, access: "private-copy" };
  for (const change of [{ target: "../escape" }, { target: "/absolute" }, { target: "c:\\escape" }, { consumer: { role: "service" } }, { use: "input-tree" }, { access: "write-shared" }]) assert.throws(() => parseResourceLock({ ...base, bindings: [{ ...binding, ...change }] }));
  assert.throws(() => parseResourceLock({ ...base, bindings: [binding, { ...binding, target: "DATA/x" }] }), /conflicting/);
  assert.throws(() => parseTree({ protocol: "hitch-tree@1", entries: [{ path: "a", kind: "directory", resource: "cycle" }] }), /unknown/);
  assert.throws(() => parseTree({ protocol: "hitch-tree@1", entries: [{ path: "A", kind: "directory" }, { path: "a", kind: "directory" }] }), /collide/);
  assert.throws(() => parseTree({ protocol: "hitch-tree@1", entries: [{ path: "e\u0301", kind: "directory" }] }), /portable/);
});

test("two imports deduplicate bytes and preserve modes/empty directories; roots survive independent release", async t => {
  const { source, store } = await fixture(t);
  const a = await store.import(source, "tree", "producer-a"), b = await store.import(source, "tree", "producer-b");
  assert.deepEqual(a.resource, b.resource); assert.equal(b.storedBytes, 0); assert.equal((await readdir(path.join(store.directory, "objects/sha256"))).length, 3);
  assert.equal(a.resource.kind, "tree"); if (a.resource.kind !== "tree") return;
  const tree = await store.objects.readTree(a.resource.manifestDigest);
  assert.deepEqual(tree.entries.find(e => e.path === "empty"), { path: "empty", kind: "directory" });
  assert.equal((tree.entries.find(e => e.path === "program") as { executable: boolean }).executable, true);
  for (const owner of ["experiment-one", "experiment-two"]) await store.pin({ owner, generation: 1, purpose: "frozen-batch", lock: lockFor({ runtime: a.resource }) });
  await store.finishLease(a.leaseId, "ended"); await store.finishLease(b.leaseId, "ended");
  await store.release("experiment-one", 1);
  assert.equal((await auditResources(store)).eligible.length, 0);
  await assert.rejects(store.pin({ owner: "experiment-one", generation: 1, purpose: "frozen-batch", lock: lockFor({ runtime: a.resource }) }), /released/);
  await store.pin({ owner: "experiment-one", generation: 2, purpose: "frozen-batch", lock: lockFor({ runtime: a.resource }) });
  await assert.rejects(store.release("experiment-one", 1), /stale/);
  const root = await store.readRecord("roots", "experiment-two"); assert.ok(root);
});

test("unknown execution leases protect content; quarantine acquisition restores before pin", async t => {
  const { source, store } = await fixture(t), imported = await store.import(path.join(source, "data"), "blob", "producer");
  await store.finishLease(imported.leaseId, "ended");
  const active = await store.acquire("remote-work", lockFor({ data: imported.resource }), "execution");
  await store.finishLease(active.lease.id, "unknown"); assert.equal((await auditResources(store, { apply: true, graceMs: 0 })).eligible.length, 0);
  await store.finishLease(active.lease.id, "ended");
  assert.equal((await auditResources(store, { apply: true, graceMs: 0 })).quarantined.length, 1);
  await store.pin({ owner: "resurrected", generation: 1, purpose: "replay", lock: lockFor({ data: imported.resource }) });
  assert.equal((await auditResources(store, { apply: true, graceMs: 0 })).deleted.length, 0);
});

test("corrupt cached objects and missing durable closure fail closed", async t => {
  const { source, store } = await fixture(t), imported = await store.import(path.join(source, "data"), "blob", "producer");
  await store.pin({ owner: "kept", generation: 1, purpose: "replay", lock: lockFor({ data: imported.resource }) });
  assert.equal(imported.resource.kind, "blob"); if (imported.resource.kind !== "blob") return;
  await writeFile(store.objects.objectPath(imported.resource.digest), "corruption");
  await assert.rejects(store.import(path.join(source, "data"), "blob", "again"), /mismatch/);
  await assert.rejects(auditResources(store, { apply: true }), /mismatch/);
});

test("import rejects source links, special shapes and budget overflow without escaping staging", async t => {
  const { source, store, root } = await fixture(t); await symlink(root, path.join(source, "escape"));
  await assert.rejects(store.import(source, "tree", "producer"), /links/); await rm(path.join(source, "escape"));
  const limited = new ResourceStore(path.join(root, "small"), { limits: { maxTotalBytes: 1, minFreeBytes: 0 } });
  await assert.rejects(limited.import(source, "tree", "producer"), /budget/);
  assert.equal(canonical(parseStrictJson('{"b":2,"a":1}')), '{"a":1,"b":2}');
});
