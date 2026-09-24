import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Sha256 } from "../domain/index.js";
import { syncDirectory } from "../foundation/index.js";
import { canonical, compare, hash, natural, parseStrictJson, parseTree, portablePath, sha, type Resource, type TreeManifest } from "./protocol.js";

export interface ResourceLimits { maxObjectBytes: number; maxTotalBytes: number; maxFiles: number; minFreeBytes: number; maxViewBytes: number }
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = { maxObjectBytes: 1024 ** 3, maxTotalBytes: 8 * 1024 ** 3, maxFiles: 100_000, minFreeBytes: 64 * 1024 ** 2, maxViewBytes: 512 * 1024 ** 2 };
export function limits(input: Partial<ResourceLimits> = {}): ResourceLimits {
  if (Object.keys(input).some(k => !Object.keys(DEFAULT_RESOURCE_LIMITS).includes(k))) throw new TypeError("unknown resource budget");
  const value = { ...DEFAULT_RESOURCE_LIMITS, ...input }; Object.values(value).forEach(natural); return value;
}
const signature = (s: Stats) => [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs].join(":");
export class ObjectStore {
  readonly directory: string;
  constructor(readonly root: string, readonly budget = DEFAULT_RESOURCE_LIMITS) { this.directory = path.join(root, "store", "benchmark-resources"); }
  objectPath(digest: Sha256): string { return path.join(this.directory, "objects", "sha256", sha(digest).slice(7)); }
  async verify(digest: Sha256, expectedSize?: number, file = this.objectPath(digest)): Promise<number> {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > this.budget.maxObjectBytes || expectedSize !== undefined && info.size !== expectedSize) throw new Error("resource object type or size mismatch");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (signature(await handle.stat()) !== signature(info)) throw new Error("resource object changed while opening");
      const h = createHash("sha256"); let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) { size += chunk.length; if (size > this.budget.maxObjectBytes) throw new Error("resource object byte budget exceeded"); h.update(chunk); }
      if (`sha256:${h.digest("hex")}` !== digest || size !== info.size || signature(await handle.stat()) !== signature(info) || signature(await lstat(file)) !== signature(info)) throw new Error("resource object digest mismatch or concurrent modification");
      return size;
    } finally { await handle.close(); }
  }
  async readTree(digest: Sha256): Promise<TreeManifest> {
    const size = await this.verify(digest);
    if (size > 16 * 1024 ** 2) throw new Error("tree manifest byte budget exceeded");
    const text = await readFile(this.objectPath(digest), "utf8"), tree = parseTree(parseStrictJson(text));
    if (hash(text) !== digest || text !== canonical(tree)) throw new Error("non-canonical tree manifest");
    if (tree.entries.length > this.budget.maxFiles) throw new Error("tree file budget exceeded");
    return tree;
  }
  async publish(staged: string, digest: Sha256, size: number, protect: (digest: Sha256) => Promise<void>): Promise<boolean> {
    await protect(digest); // Durable producer lease precedes first visibility.
    const destination = this.objectPath(digest); await mkdir(path.dirname(destination), { recursive: true });
    const existing = await lstat(destination).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return undefined; });
    if (existing) { await this.verify(digest, size); await rm(staged); return false; }
    const quarantined = path.join(this.directory, "quarantine", digest.slice(7));
    if (await lstat(quarantined).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return undefined; })) {
      await this.verify(digest, size, quarantined); await rename(quarantined, destination); await syncDirectory(path.dirname(destination));
      await rm(path.join(this.directory, "quarantine-index", `${digest.slice(7)}.json`), { force: true }); await rm(staged); return false;
    }
    // All publishers and GC hold the store lock. An existing empty/corrupt object
    // is never overwritten and shared files are never hardlinked into workspaces.
    const handle = await open(staged, "r"); try { await handle.sync(); } finally { await handle.close(); }
    await rename(staged, destination); await syncDirectory(path.dirname(destination)); await this.verify(digest, size); return true;
  }
  async importFile(source: string, staging: string, protect: (digest: Sha256) => Promise<void>, signal?: AbortSignal): Promise<{ resource: Extract<Resource, { kind: "blob" }>; storedBytes: number }> {
    signal?.throwIfAborted();
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new TypeError("resource import requires a regular file");
    if (info.size > this.budget.maxObjectBytes || info.size > this.budget.maxTotalBytes) throw new Error("resource object byte budget exceeded");
    const space = await statfs(staging, { bigint: true });
    if (space.bsize * space.bavail < BigInt(info.size + this.budget.minFreeBytes)) throw new Error("resource import free-space reserve exceeded");
    const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW), file = path.join(staging, randomUUID());
    try {
      if (signature(await input.stat()) !== signature(info)) throw new Error("resource source changed");
      const output = await open(file, "wx", 0o600), digest = createHash("sha256"); let size = 0;
      try {
        for await (const chunk of input.createReadStream({ autoClose: false })) {
          signal?.throwIfAborted(); size += chunk.length;
          if (size > this.budget.maxObjectBytes || size > info.size) throw new Error("resource source grew past byte budget");
          digest.update(chunk); await output.writeFile(chunk);
        }
        await output.sync();
      } finally { await output.close(); }
      if (size !== info.size || signature(await input.stat()) !== signature(info) || signature(await lstat(source)) !== signature(info)) throw new Error("resource source changed during import");
      const resource = { kind: "blob" as const, digest: `sha256:${digest.digest("hex")}` as Sha256, size };
      signal?.throwIfAborted();
      return { resource, storedBytes: await this.publish(file, resource.digest, size, protect) ? size : 0 };
    } finally { await input.close(); await rm(file, { force: true }); }
  }
  async importTree(source: string, staging: string, protect: (digest: Sha256) => Promise<void>, signal?: AbortSignal): Promise<{ resource: Extract<Resource, { kind: "tree" }>; logicalBytes: number; storedBytes: number }> {
    const snapshot: Array<{ name: string; file: string; info: Stats }> = []; let logicalBytes = 0, storedBytes = 0;
    const visit = async (file: string, name: string): Promise<void> => {
      signal?.throwIfAborted(); const info = await lstat(file);
      if (!info.isFile() && !info.isDirectory()) throw new TypeError("resource import refuses links and special files");
      if (name) portablePath(name); snapshot.push({ name, file, info });
      if (snapshot.length > this.budget.maxFiles + 1) throw new Error("resource file budget exceeded");
      if (info.isFile()) { logicalBytes += info.size; if (info.size > this.budget.maxObjectBytes || logicalBytes > this.budget.maxTotalBytes) throw new Error("resource total byte budget exceeded"); }
      else for (const child of (await readdir(file)).sort(compare)) await visit(path.join(file, child), name ? `${name}/${child}` : child);
    };
    await visit(source, ""); if (!snapshot[0]?.info.isDirectory()) throw new TypeError("tree source must be a directory");
    // Validate shape, Unicode and case collisions before publishing any content.
    const skeleton: TreeManifest = { protocol: "hitch-tree@1", entries: snapshot.filter(e => e.name).map<TreeManifest["entries"][number]>(e => e.info.isDirectory()
      ? { path: e.name, kind: "directory" } : { path: e.name, kind: "file", digest: `sha256:${"0".repeat(64)}`, size: e.info.size, executable: Boolean(e.info.mode & 0o111) }).sort((a, b) => compare(a.path, b.path)) };
    parseTree(skeleton);
    const entries: TreeManifest["entries"] = [];
    for (const e of snapshot) {
      if (signature(await lstat(e.file)) !== signature(e.info)) throw new Error("resource source path changed");
      if (!e.name) continue;
      if (e.info.isDirectory()) entries.push({ path: e.name, kind: "directory" });
      else { const imported = await this.importFile(e.file, staging, protect, signal); storedBytes += imported.storedBytes; entries.push({ path: e.name, kind: "file", digest: imported.resource.digest, size: imported.resource.size, executable: Boolean(e.info.mode & 0o111) }); }
    }
    for (const e of snapshot) if (signature(await lstat(e.file)) !== signature(e.info)) throw new Error("resource source changed during tree import");
    const tree = parseTree({ protocol: "hitch-tree@1", entries: entries.sort((a, b) => compare(a.path, b.path)) }), text = canonical(tree), manifestDigest = hash(text), file = path.join(staging, randomUUID());
    if (Buffer.byteLength(text) > Math.min(this.budget.maxObjectBytes, 16 * 1024 ** 2)) throw new Error("tree manifest byte budget exceeded");
    await writeFile(file, text, { flag: "wx", mode: 0o600 });
    storedBytes += await this.publish(file, manifestDigest, Buffer.byteLength(text), protect) ? Buffer.byteLength(text) : 0;
    return { resource: { kind: "tree", format: "hitch-tree@1", manifestDigest }, logicalBytes, storedBytes };
  }
}
