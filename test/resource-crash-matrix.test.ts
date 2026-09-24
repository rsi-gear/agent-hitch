import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ResourceStore, auditResources, type ResourceRoot } from "../src/resources/index.js";
import { resourceImageReferences } from "../src/foundation/index.js";
import { FixtureImageProvider, fixtureImage } from "../test-support/resource-fixture.js";
const matrix: Array<[string, string]> = [
  ...["lease-created", "lease-protected", "image-preparing", "image-active", "root-fence", "root-published", "lease-ended"].map(point => ["pin", point] as [string, string]),
  ...["lease-created", "lease-protected", "image-preparing", "image-active"].map(point => ["acquire", point] as [string, string]),
  ...["quarantine-index", "quarantine-moved", "quarantine-deleted"].map(point => ["gc", point] as [string, string]),
  ...["lease-protected", "quarantine-restored"].map(point => ["restore", point] as [string, string]),
];
for (const [operation, point] of matrix) for (const phase of ["before", "after"]) {
  test(`SIGKILL ${operation} ${phase} ${point}: concurrent GC cannot strand a durable root`, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hitch-resource-crash-matrix-")); t.after(() => rm(directory, { recursive: true, force: true }));
    const root = path.join(directory, "host"), store = new ResourceStore(root, { images: new FixtureImageProvider(), limits: { minFreeBytes: 0 } });
    const input = path.join(directory, "input"); await mkdir(input); await writeFile(path.join(input, "a"), "shared first"); await writeFile(path.join(input, "b"), "shared second");
    const imported = await store.import(input, "tree", "producer"), lock = { protocol: "hitch-resource-lock@1", resources: { input: imported.resource, base: fixtureImage }, bindings: [], requiredCapabilities: [] };
    const anchor = await store.pin({ owner: "anchor", generation: 1, purpose: "history", lock }); await store.finishLease(imported.leaseId, "ended");
    // GC gets separate unreferenced content, while the independent anchor must
    // remain intact through every failed operation and every recovery attempt.
    const garbage = path.join(directory, "unused"); await writeFile(garbage, "unreferenced");
    const unused = await store.import(garbage, "blob", "unused"); await store.finishLease(unused.leaseId, "ended");
    let targetLock = lock;
    if (operation === "restore") targetLock = { ...lock, resources: { extra: unused.resource, ...lock.resources } } as typeof lock;
    if (point === "quarantine-deleted" || operation === "restore") await auditResources(store, { apply: true, graceMs: 0 });
    const fixture = path.join(directory, "lock.json"); await writeFile(fixture, JSON.stringify(targetLock));
    const child = spawn(process.execPath, [fileURLToPath(new URL("../test-support/resource-crash-child.js", import.meta.url)), root, fixture, operation, point, phase], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", (_code, signal) => signal === "SIGKILL" ? resolve() : reject(new Error(stderr))); });
    // Attach rejection immediately so a missing fault point never becomes an
    // unhandled rejection while waiting for the IPC event.
    void exited.catch(() => {}); t.after(() => child.kill("SIGKILL"));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fault point timeout: ${stderr}`)), 10_000);
      child.once("message", () => { clearTimeout(timer); resolve(); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`fault point not reached: ${stderr}`)); });
    });
    const competingGc = auditResources(store, { apply: true, graceMs: 0 }).then(value => ({ value }), error => ({ error }));
    child.kill("SIGKILL"); await exited; const swept = await competingGc;
    // A process may die with an unpublished JSON temp or half-finished restore.
    // Failing closed is safe; it must not silently remove another owner's bytes.
    if ("error" in swept) assert.match(String(swept.error), /record filename|quarantine|missing content/);
    for (const digest of anchor.closure.objectDigests) await store.objects.verify(digest);
    const durable = await store.readRecord<ResourceRoot>("roots", "crashed");
    if (durable?.state === "active") for (const digest of durable.closure.objectDigests) await store.objects.verify(digest);
    try { assert.ok((await resourceImageReferences(root)).has(anchor.closure.images[0]!.imageId)); }
    catch (error) { assert.match(String(error), /acquisition is incomplete|reference file/); }
    // Restart with the same owner/generation. Existing roots are verified, and
    // quarantined content needed by a restore is brought back under the lock.
    if (operation === "pin") {
      const recovered = await store.pin({ owner: "crashed", generation: 1, purpose: "history", lock });
      assert.equal(recovered.closure.digest, anchor.closure.digest);
    } else if (operation === "restore") {
      const recovered = await store.acquire("crashed-recovery", targetLock, "execution");
      for (const digest of recovered.closure.objectDigests) await store.objects.verify(digest);
    }
    assert.equal((await store.readRecord<ResourceRoot>("roots", "anchor"))!.closure.digest, anchor.closure.digest);
  });
}
