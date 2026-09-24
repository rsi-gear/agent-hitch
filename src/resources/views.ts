import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { durableWriteJSON } from "../foundation/index.js";
import { canonical, hash, object, parseStrictJson, parseTree, type TreeManifest } from "./protocol.js";
import { ResourceStore } from "./store.js";
import type { ResourceTask } from "./tasks.js";

const names = (directory: string): Promise<string[]> => readdir(directory).catch(e => { if (e.code !== "ENOENT") throw e; return [] });
async function verifyView(store: ResourceStore, directory: string, tree: TreeManifest): Promise<void> {
  const expected = new Map(tree.entries.map(e => [e.path, e]));
  const visit = async (dir: string, prefix = ""): Promise<void> => {
    if (!(await lstat(dir)).isDirectory()) throw new Error("descriptor view is not a directory");
    for (const name of await readdir(dir)) {
      const rel = prefix ? `${prefix}/${name}` : name, entry = expected.get(rel); if (!entry) throw new Error("descriptor view contains extra content"); expected.delete(rel);
      const file = path.join(dir, name), info = await lstat(file);
      if (entry.kind === "directory") await visit(file, rel);
      else if (!info.isFile() || Boolean(info.mode & 0o111) !== entry.executable || await store.objects.verify(entry.digest, entry.size, file) !== entry.size) throw new Error("descriptor view changed");
    }
  };
  await visit(directory); if (expected.size) throw new Error("descriptor view incomplete");
}
/** Bounded cache of small descriptors. Large external bindings never enter it. */
export async function resourceDescriptorDirectory(store: ResourceStore, task: ResourceTask): Promise<string> {
  return store.locked(async () => {
    const key = task.sourceTree.manifestDigest.slice(7), ref = path.join(store.directory, "descriptor-views", key), isolated = path.join(store.directory, "view-quarantine", key), tree = await store.objects.readTree(task.sourceTree.manifestDigest);
    const size = tree.entries.reduce((n, e) => n + (e.kind === "file" ? e.size : 0), 0);
    if (size > 32 * 1024 ** 2) throw new Error("task descriptor exceeds 32 MiB; declare large inputs as resources");
    if (await lstat(ref).catch(e => { if (e.code !== "ENOENT") throw e; return undefined; })) { await verifyView(store, ref, tree); return ref; }
    if (await lstat(isolated).catch(e => { if (e.code !== "ENOENT") throw e; return undefined; })) { await verifyView(store, isolated, tree); await mkdir(path.dirname(ref), { recursive: true }); await rename(isolated, ref); await rm(path.join(store.directory, "view-quarantine-index", `${key}.json`), { force: true }); return ref; }
    let cached = 0;
    const measure = async (dir: string): Promise<void> => { for (const name of await names(dir)) { const file = path.join(dir, name), info = await lstat(file); if (info.isDirectory()) await measure(file); else if (info.isFile()) cached += info.size; else throw new Error("unsafe descriptor cache entry"); } };
    await measure(path.dirname(ref)); await measure(path.dirname(isolated));
    if (cached + size > store.objects.budget.maxViewBytes) throw new Error("descriptor view cache budget exceeded; inspect and release unused roots before explicit GC");
    const temp = `${ref}.${randomUUID()}.tmp`; await mkdir(temp, { recursive: true, mode: 0o700 });
    try {
      const space = await statfs(temp, { bigint: true }); if (space.bsize * space.bavail < BigInt(size + store.objects.budget.minFreeBytes)) throw new Error("descriptor view free-space reserve exceeded");
      for (const entry of tree.entries) { const target = path.join(temp, entry.path); if (entry.kind === "directory") await mkdir(target); else { await store.objects.verify(entry.digest, entry.size); await copyFile(store.objects.objectPath(entry.digest), target, constants.COPYFILE_EXCL); await chmod(target, entry.executable ? 0o755 : 0o644); } }
      await verifyView(store, temp, tree); await rename(temp, ref); return ref;
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
}
/** Caller holds the same store lock used by view creation and root acquisition. */
export async function planViewGc(store: ResourceStore, marked: ReadonlyMap<string, unknown>, graceMs: number) {
  const active = path.join(store.directory, "descriptor-views"), quarantine = path.join(store.directory, "view-quarantine"), index = path.join(store.directory, "view-quarantine-index");
  const isolated = new Map<string, { tree: TreeManifest; at: number }>(), eligible = new Map<string, TreeManifest>();
  for (const key of await names(quarantine)) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("unknown quarantined descriptor view");
    const record = object(parseStrictJson(await readFile(path.join(index, `${key}.json`), "utf8")), ["protocol", "tree", "at"]), tree = parseTree(record.tree);
    if (record.protocol !== "hitch-view-quarantine@1" || hash(canonical(tree)) !== `sha256:${key}` || !Number.isSafeInteger(record.at)) throw new Error("invalid descriptor quarantine identity");
    await verifyView(store, path.join(quarantine, key), tree); isolated.set(key, { tree, at: record.at as number });
  }
  for (const key of await names(active)) {
    if (!/^[a-f0-9]{64}$/.test(key)) continue; // Interrupted private staging is retained for explicit recovery.
    const tree = await store.objects.readTree(`sha256:${key}`); await verifyView(store, path.join(active, key), tree);
    if (!marked.has(`sha256:${key}`)) eligible.set(key, tree);
  }
  return async () => {
    for (const [key, record] of isolated) {
      if (marked.has(`sha256:${key}`)) { await mkdir(active, { recursive: true }); await rename(path.join(quarantine, key), path.join(active, key)); await rm(path.join(index, `${key}.json`)); }
      else if (Date.now() - record.at >= graceMs) { await rm(path.join(quarantine, key), { recursive: true }); await rm(path.join(index, `${key}.json`)); }
    }
    for (const [key, tree] of eligible) { await mkdir(quarantine, { recursive: true }); await durableWriteJSON(path.join(index, `${key}.json`), { protocol: "hitch-view-quarantine@1", tree, at: Date.now() }); await rename(path.join(active, key), path.join(quarantine, key)); }
    return { quarantined: [...eligible.keys()] };
  };
}
