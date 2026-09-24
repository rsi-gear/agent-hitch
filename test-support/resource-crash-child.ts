// Process-local syscall interception. Production code has no crash-test hooks.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
const [root, fixture, operation, point, phase] = process.argv.slice(2) as [string, string, string, string, string];
const native = { rename: fs.rename, rm: fs.rm, readFile: fs.readFile };
const pause = async () => { process.send?.({ point, phase }); setInterval(() => {}, 1000); await new Promise(() => {}); };
function matches(file: string, value: Record<string, unknown> | undefined, call: string): boolean {
  if (point === "lease-created") return value?.protocol === "hitch-resource-lease@1" && value.state === "active" && Array.isArray(value.objectDigests) && !value.objectDigests.length;
  if (point === "lease-protected") return value?.protocol === "hitch-resource-lease@1" && value.state === "active" && Array.isArray(value.objectDigests) && value.objectDigests.length > 0;
  if (point === "image-preparing") return value?.protocol === "hitch-resource-image-fence@1" && value.state === "preparing";
  if (point === "image-active") return value?.protocol === "hitch-resource-image-fence@1" && value.state === "active" && String(value.owner).startsWith("lease:");
  if (point === "root-fence") return value?.protocol === "hitch-resource-image-fence@1" && String(value.owner).startsWith("root:crashed:");
  if (point === "root-published") return value?.protocol === "hitch-resource-root@1" && value.owner === "crashed";
  if (point === "lease-ended") return value?.protocol === "hitch-resource-lease@1" && value.state === "released";
  if (point === "quarantine-index") return value?.protocol === "hitch-resource-quarantine@1";
  if (point === "quarantine-moved") return call === "rename" && /\/quarantine\/[a-f0-9]{64}$/.test(file);
  if (point === "quarantine-deleted") return call === "rm" && /\/quarantine\/[a-f0-9]{64}$/.test(file);
  if (point === "quarantine-restored") return call === "rename" && /\/objects\/sha256\/[a-f0-9]{64}$/.test(file);
  return false;
}
fs.rename = async (from, to) => {
  let value: Record<string, unknown> | undefined;
  if (String(to).endsWith(".json")) { try { value = JSON.parse(await native.readFile(from, "utf8")); } catch {} }
  const stop = matches(String(to), value, "rename");
  if (stop && phase === "before") await pause();
  await native.rename(from, to);
  if (stop && phase === "after") await pause();
};
fs.rm = async (file, options) => {
  const stop = matches(String(file), undefined, "rm");
  if (stop && phase === "before") await pause();
  await native.rm(file, options);
  if (stop && phase === "after") await pause();
};
syncBuiltinESMExports();
const { ResourceStore, auditResources } = await import("../src/resources/index.js");
const { FixtureImageProvider } = await import("./resource-fixture.js");
const store = new ResourceStore(root, { images: new FixtureImageProvider(), limits: { minFreeBytes: 0 } });
const lock = JSON.parse(await native.readFile(fixture, "utf8"));
if (operation === "pin") await store.pin({ owner: "crashed", generation: 1, purpose: "history", lock });
else if (operation === "acquire" || operation === "restore") await store.acquire("crashed", lock, "execution");
else if (operation === "gc") await auditResources(store, { apply: true, graceMs: 0 });
else throw new Error(`invalid operation ${operation}`);
throw new Error(`crash point not reached: ${point}`);
