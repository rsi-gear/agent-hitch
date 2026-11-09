import type { Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { openContainedRegularFile } from "../foundation/index.js";
import { canonical, compare, hash, identity, parseResourceLock, parseStrictJson, parseTree, portablePath, type TreeEntry } from "./protocol.js";
import { parseResourceDataset, type ResourceDataset, type ResourceTask } from "./tasks.js";

/** Pure source verification: this never resolves images or grants execution. */
export async function verifyResourceDatasetSource(directory: string, manifest?: unknown): Promise<ResourceDataset> {
  const root = await realpath(directory);
  if (manifest === undefined) {
    const file = await openContainedRegularFile(root, "benchmark.adapter.json", 16 * 1024 * 1024);
    try { manifest = parseStrictJson((await file.handle.readFile()).toString("utf8")); await file.assertUnchanged(); }
    finally { await file.handle.close(); }
  }
  const parsed = parseResourceDataset(manifest);
  await membership(root, parsed.tasks.map(task => task.task_id));
  for (const task of parsed.tasks) {
    const actual = await sourceTask(root, task);
    if (canonical(actual) !== canonical(task)) throw new TypeError(`local task descriptor changed since sealing: ${task.task_id}`);
  }
  return parsed;
}

/** Derive source identities while retaining the original immutable resource closure.
 * Lock changes require full resource sealing; this API cannot authorize new resources.
 */
export async function deriveResourceDatasetSource(directory: string, originalManifest: unknown, taskIds?: readonly string[]): Promise<ResourceDataset> {
  const original = parseResourceDataset(originalManifest), root = await realpath(directory);
  const ids = [...(taskIds ?? original.tasks.map(task => task.task_id))].sort(compare);
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !original.tasks.some(task => task.task_id === id))) throw new TypeError("invalid derived resource task selection");
  await membership(root, ids);
  const tasks: ResourceTask[] = [];
  for (const id of ids) tasks.push(await sourceTask(root, original.tasks.find(task => task.task_id === id)!));
  const { dataset_digest: _digest, tasks: _tasks, ...metadata } = original;
  const body = { ...metadata, tasks };
  return parseResourceDataset({ ...body, dataset_digest: identity("hitch-resource-dataset@3", body) });
}

async function membership(root: string, ids: readonly string[]): Promise<void> {
  const actual: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() && ids.includes(entry.name)) throw new TypeError("resource task source is a symlink");
    if (!entry.isDirectory()) continue;
    const descriptor = await lstat(path.join(root, entry.name, "task.toml")).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return undefined; });
    if (descriptor) actual.push(entry.name);
  }
  if (canonical(actual.sort(compare)) !== canonical([...ids].sort(compare))) throw new TypeError("resource source task membership mismatch");
}

async function sourceTask(root: string, original: ResourceTask): Promise<ResourceTask> {
  const directory = path.join(root, original.task_id), before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new TypeError("unsafe resource task directory");
  const entries: TreeEntry[] = [], snapshot: Array<{ file: string; stats: Stats }> = [{ file: directory, stats: before }]; let size = 0, lock: unknown;
  const visit = async (relative: string): Promise<void> => {
    portablePath(relative);
    if (entries.length >= 100000) throw new TypeError("resource source entry limit exceeded");
    const file = path.join(directory, relative), info = await lstat(file);
    snapshot.push({ file, stats: info });
    if (info.isSymbolicLink()) throw new TypeError("resource source symlinks are forbidden");
    if (info.isDirectory()) {
      entries.push({ path: relative, kind: "directory" });
      for (const name of (await readdir(file)).sort(compare)) await visit(`${relative}/${name}`);
      const after = await lstat(file);
      if (after.dev !== info.dev || after.ino !== info.ino || after.mtimeMs !== info.mtimeMs) throw new TypeError("resource source directory changed while reading");
    } else {
      const safe = await openContainedRegularFile(directory, relative, 32 * 1024 * 1024);
      try {
        size += safe.size;
        if (size > 32 * 1024 * 1024) throw new TypeError("task descriptor exceeds 32 MiB; declare large inputs as resources");
        const bytes = await safe.handle.readFile(), stats = await safe.handle.stat(); await safe.assertUnchanged();
        entries.push({ path: relative, kind: "file", digest: hash(bytes), size: bytes.length, executable: Boolean(stats.mode & 0o111) });
        if (relative === "resource.lock.json") lock = parseStrictJson(bytes.toString("utf8"));
      } finally { await safe.handle.close(); }
    }
  };
  for (const name of (await readdir(directory)).sort(compare)) await visit(name);
  const after = await lstat(directory);
  if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) throw new TypeError("resource task changed while reading");
  if (canonical(parseResourceLock(lock)) !== canonical(original.lock)) throw new TypeError("resource lock changed; full resource sealing is required");
  const signature = (s: Stats) => [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs].join(":");
  for (const entry of snapshot) if (signature(await lstat(entry.file)) !== signature(entry.stats)) throw new TypeError("resource source changed while reading");
  const tree = parseTree({ protocol: "hitch-tree@1", entries: entries.sort((a, b) => compare(a.path, b.path)) });
  const sourceTree = { kind: "tree" as const, format: "hitch-tree@1" as const, manifestDigest: hash(canonical(tree)) };
  const source_task_digest = identity("hitch-source-task@1", sourceTree), resource_closure_digest = original.resource_closure_digest;
  return { ...original, sourceTree, source_task_digest, task_digest: identity("hitch-task@2", { source_task_digest, resource_closure_digest }) };
}
