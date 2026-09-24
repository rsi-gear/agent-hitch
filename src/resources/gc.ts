import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Sha256 } from "../domain/index.js";
import { durableWriteJSON as atomicWriteJSON, readJSON } from "../foundation/index.js";
import { canonical, natural, object, type Resource } from "./protocol.js";
import { ResourceStore, validateLease, validateRoot, type ResourceLease, type ResourceRoot } from "./store.js";
import { planViewGc } from "./views.js";

export interface ResourceGcReport {
  protocol: "hitch-resource-gc@1";
  dryRun: boolean;
  objects: number;
  logicalBytes: number;
  retained: Array<{ digest: Sha256; reasons: string[] }>;
  eligible: Sha256[];
  quarantined: Sha256[];
  deleted: Sha256[];
}
export async function auditResources(store: ResourceStore, options: { apply?: boolean; graceMs?: number; signal?: AbortSignal } = {}): Promise<ResourceGcReport> {
  const graceMs = options.graceMs ?? 24 * 60 * 60 * 1000; natural(graceMs);
  return store.locked(async () => {
    const roots = await store.records<ResourceRoot>("roots"), leases = await store.records<ResourceLease>("leases"), marked = new Map<Sha256, Set<string>>();
    const mark = (digest: Sha256, reason: string) => { const reasons = marked.get(digest) ?? new Set<string>(); reasons.add(reason); marked.set(digest, reasons); };
    for (const root of roots) {
      validateRoot(root); if (root.state !== "active") continue;
      const actual = await fileClosure(store, Object.values(root.lock.resources));
      if (canonical(actual) !== canonical(root.closure.objectDigests)) throw new Error("durable resource closure is incomplete; GC stopped");
      for (const digest of actual) mark(digest, `owner:${root.owner}:${root.generation}`);
    }
    for (const lease of leases) {
      validateLease(lease); if (lease.state === "released") continue;
      // No PID or expiry test: unknown remote execution keeps its protection.
      for (const digest of lease.objectDigests) mark(digest, `${lease.state}-lease:${lease.id}`);
    }
    const report: ResourceGcReport = { protocol: "hitch-resource-gc@1", dryRun: !options.apply, objects: 0, logicalBytes: 0, retained: [], eligible: [], quarantined: [], deleted: [] };
    const directory = path.join(store.directory, "objects", "sha256"), quarantine = path.join(store.directory, "quarantine");
    const names = async (dir: string): Promise<string[]> => readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return []; });
    // Verify every present object before any mutation. A partial producer may
    // protect its next not-yet-published digest; active roots may never do so.
    const files = await names(directory), quarantined = await names(quarantine);
    for (const name of [...files, ...quarantined]) if (!/^[a-f0-9]{64}$/.test(name)) throw new Error("unknown object store entry; GC stopped");
    const quarantineTimes = new Map<string, number>();
    for (const name of quarantined) {
      const digest = `sha256:${name}` as Sha256;
      if (files.includes(name) || marked.has(digest)) throw new Error("duplicate or referenced quarantine object; GC stopped");
      const index = object(await readJSON(path.join(store.directory, "quarantine-index", `${name}.json`)), ["protocol", "digest", "quarantinedAt"]);
      if (index.protocol !== "hitch-resource-quarantine@1" || index.digest !== digest || !Number.isSafeInteger(index.quarantinedAt) || (index.quarantinedAt as number) < 0) throw new Error("invalid quarantine record; GC stopped");
      await store.objects.verify(digest, undefined, path.join(quarantine, name));
      quarantineTimes.set(name, index.quarantinedAt as number);
    }
    for (const lease of leases) if (lease.state !== "released" && lease.purpose !== "import") {
      for (const digest of lease.objectDigests) if (!files.includes(digest.slice(7))) throw new Error("active resource lease has missing content; GC stopped");
    }
    for (const name of files) { options.signal?.throwIfAborted(); report.logicalBytes += await store.objects.verify(`sha256:${name}`); report.objects++; }
    const collectViews = await planViewGc(store, marked, graceMs);
    if (options.apply) await collectViews();
    for (const name of files) {
      const digest = `sha256:${name}` as Sha256, reasons = marked.get(digest);
      if (reasons) { report.retained.push({ digest, reasons: [...reasons].sort() }); continue; }
      report.eligible.push(digest); if (!options.apply) continue;
      options.signal?.throwIfAborted(); await mkdir(quarantine, { recursive: true });
      await atomicWriteJSON(path.join(store.directory, "quarantine-index", `${name}.json`), { protocol: "hitch-resource-quarantine@1", digest, quarantinedAt: Date.now() });
      await rename(path.join(directory, name), path.join(quarantine, name)); report.quarantined.push(digest);
    }
    for (const name of quarantined) {
      const digest = `sha256:${name}` as Sha256;
      if (marked.has(digest)) throw new Error("referenced object is quarantined; acquire must restore it before GC");
      if (!options.apply || Date.now() - quarantineTimes.get(name)! < graceMs) continue;
      options.signal?.throwIfAborted(); await rm(path.join(quarantine, name)); await rm(path.join(store.directory, "quarantine-index", `${name}.json`)); report.deleted.push(digest);
    }
    return report;
  }, options.signal);
}
export async function fileClosure(store: ResourceStore, resources: Resource[]): Promise<Sha256[]> {
  const found = new Set<Sha256>(); let bytes = 0, files = 0;
  for (const resource of resources) {
    if (resource.kind === "oci-image") continue;
    const digest = resource.kind === "blob" ? resource.digest : resource.manifestDigest;
    await store.objects.verify(digest, resource.kind === "blob" ? resource.size : undefined); found.add(digest);
    if (resource.kind === "tree") {
      const tree = await store.objects.readTree(digest); files += tree.entries.length;
      for (const entry of tree.entries) if (entry.kind === "file") { await store.objects.verify(entry.digest, entry.size); found.add(entry.digest); bytes += entry.size; }
    } else { bytes += resource.size; files++; }
    if (bytes > store.objects.budget.maxTotalBytes || files > store.objects.budget.maxFiles) throw new Error("resource closure budget exceeded");
  }
  return [...found].sort();
}
