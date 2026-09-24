import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { auditResources, ResourceStore, type ResourceLease } from "../src/resources/index.js";
import { resourceImageReferences } from "../src/foundation/index.js";
import { FixtureImageProvider, fixtureImage } from "../test-support/resource-fixture.js";
const moduleUrl = new URL("../src/resources/index.js", import.meta.url).href;
async function setup(t: TestContext) { const dir = await mkdtemp(path.join(os.tmpdir(), "hitch-resource-recovery-")); t.after(() => rm(dir, { recursive: true, force: true })); const source = path.join(dir, "source"); await mkdir(source); await writeFile(path.join(source, "a"), "first"); await writeFile(path.join(source, "b"), "second"); return { dir, source, root: path.join(dir, "hitch") }; }
const prefix = `import {ResourceStore} from ${JSON.stringify(moduleUrl)}; const [root,source,owner]=process.argv.slice(1); const store=new ResourceStore(root,{limits:{minFreeBytes:0}});`;
function child(code: string, args: string[]) {
  const processChild = spawn(process.execPath, ["--input-type=module", "-e", prefix + code, ...args], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = ""; processChild.stderr!.on("data", c => { stderr += c; });
  const done = new Promise<void>((resolve, reject) => { processChild.on("error", reject); processChild.on("exit", (code, signal) => code === 0 || signal === "SIGKILL" ? resolve() : reject(new Error(stderr))); });
  return { processChild, done };
}
test("two publishers and GC share one authority; independent owner release cannot strand a root", async t => {
  const { root, source } = await setup(t), code = `const imported=await store.import(source,"tree",owner); await store.pin({owner,generation:1,purpose:"experiment",lock:{protocol:"hitch-resource-lock@1",resources:{input:imported.resource},bindings:[],requiredCapabilities:[]}}); await store.finishLease(imported.leaseId,"ended");`;
  const a = child(code, [root, source, "one"]), b = child(code, [root, source, "two"]), store = new ResourceStore(root, { limits: { minFreeBytes: 0 } });
  await Promise.all([a.done, b.done, auditResources(store, { apply: true, graceMs: 0 })]);
  await store.release("one", 1); const report = await auditResources(store, { apply: true, graceMs: 0 }); assert.equal(report.eligible.length, 0); assert.equal(report.retained.length, 3);
  const two = await store.readRecord<{ closure: { objectDigests: `sha256:${string}`[] } }>("roots", "two"); for (const digest of two!.closure.objectDigests) await store.objects.verify(digest);
});
test("SIGKILL between first publication and pin retains the producer prefix until explicit end", async t => {
  const { root, source } = await setup(t);
  const crashed = child(`const original=store.objects.publish.bind(store.objects); store.objects.publish=async (...args)=>{const result=await original(...args); process.send({published:true}); setInterval(()=>{},1000); await new Promise(()=>{}); return result;}; await store.import(source,"tree",owner);`, [root, source, "crash"]);
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { crashed.processChild.kill("SIGKILL"); reject(new Error("child did not reach publication")); }, 15000); crashed.processChild.once("message", () => { clearTimeout(timer); resolve(); }); });
  crashed.processChild.kill("SIGKILL"); await crashed.done;
  const store = new ResourceStore(root, { limits: { minFreeBytes: 0 } }), leases = await store.records<ResourceLease>("leases");
  assert.equal(leases.length, 1); assert.equal((await auditResources(store, { apply: true, graceMs: 0 })).eligible.length, 0);
  await store.finishLease(leases[0]!.id, "unknown"); assert.equal((await auditResources(store, { apply: true, graceMs: 0 })).eligible.length, 0);
  await store.finishLease(leases[0]!.id, "ended"); assert.equal((await auditResources(store, { apply: true, graceMs: 0 })).quarantined.length, 1);
  assert.equal((await readdir(path.join(store.directory, "staging"))).length, 0);
  assert.equal((await auditResources(store, { apply: true, graceMs: 0 })).deleted.length, 1);
});
test("OCI roots and unknown leases remain visible to existing image GC", async t => {
  const { root } = await setup(t), images = new FixtureImageProvider(), store = new ResourceStore(root, { images });
  const lock = { protocol: "hitch-resource-lock@1", resources: { image: fixtureImage }, bindings: [], requiredCapabilities: [] };
  await store.pin({ owner: "image-owner", generation: 1, purpose: "history", lock }); const acquired = await store.acquire("remote", lock, "execution");
  assert.equal((await resourceImageReferences(root)).size, 1);
  await store.release("image-owner", 1); await store.finishLease(acquired.lease.id, "unknown"); assert.equal((await resourceImageReferences(root)).size, 1);
  await store.finishLease(acquired.lease.id, "ended"); assert.equal((await resourceImageReferences(root)).size, 0);
});
test("invalid quarantine metadata prevents every deletion in the sweep", async t => {
  const { root, source } = await setup(t), store = new ResourceStore(root, { limits: { minFreeBytes: 0 } });
  const imported = await store.import(path.join(source, "a"), "blob", "unused"); await store.finishLease(imported.leaseId, "ended");
  const report = await auditResources(store, { apply: true, graceMs: 0 }); const digest = report.quarantined[0]!;
  await writeFile(path.join(store.directory, "quarantine-index", `${digest.slice(7)}.json`), "{}");
  const next = await store.import(path.join(source, "b"), "blob", "other"); await store.finishLease(next.leaseId, "ended");
  await assert.rejects(auditResources(store, { apply: true, graceMs: 0 }), /quarantine/);
  assert.equal((await readdir(path.join(store.directory, "objects/sha256"))).length, 1); assert.equal((await readdir(path.join(store.directory, "quarantine"))).length, 1);
});
