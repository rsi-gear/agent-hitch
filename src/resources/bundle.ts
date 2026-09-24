import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, statfs } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { durableWriteJSON as atomicWriteJSON } from "../foundation/index.js";
import { canonical, identity, natural, object, parseStrictJson, sha } from "./protocol.js";
import { ResourceStore } from "./store.js";
import { createResourceDelivery, parseResourceDelivery, receiveResourceDelivery, type ResourceDelivery } from "./transfer.js";
import { parseResourceSelection, type ResourceSelection } from "./tasks.js";

interface BundleIndex {
  protocol: "hitch-resource-bundle@1";
  delivery: ResourceDelivery;
  archives: Array<{ manifestDigest: string; digest: `sha256:${string}`; size: number }>;
  digest: string;
}
export async function exportResourceBundle(store: ResourceStore, selection: ResourceSelection, destination: string, owner: string, signal?: AbortSignal): Promise<BundleIndex> {
  destination = path.resolve(destination);
  if (await lstat(destination).catch(e => { if (e.code !== "ENOENT") throw e; return undefined; })) throw new Error("bundle output already exists");
  const delivery = await createResourceDelivery(store, selection, owner, 1, signal), temp = `${destination}.${randomUUID()}.tmp`, archives: BundleIndex["archives"] = [];
  await mkdir(path.join(temp, "objects"), { recursive: true, mode: 0o700 }); await mkdir(path.join(temp, "oci"));
  try {
    let total = 0;
    for (const item of delivery.objects) {
      signal?.throwIfAborted(); total += item.size;
      if (total > store.objects.budget.maxTotalBytes) throw new Error("bundle export budget exceeded");
      await store.objects.verify(item.digest, item.size); const file = path.join(temp, "objects", item.digest.slice(7));
      const space = await statfs(temp, { bigint: true });
      if (space.bavail * space.bsize < BigInt(item.size) + BigInt(store.objects.budget.minFreeBytes)) throw new Error("bundle export free-space reserve exceeded");
      await copyFile(store.objects.objectPath(item.digest), file); await store.objects.verify(item.digest, item.size, file);
    }
    for (const image of delivery.images) {
      if (!store.options.images?.exportArchive) throw new Error("OCI provider does not support offline export");
      const file = path.join(temp, "oci", image.resource.manifestDigest.slice(7));
      await store.options.images.exportArchive(image.resource, file, signal, { maxBytes: Math.min(store.objects.budget.maxObjectBytes, store.objects.budget.maxTotalBytes - total), minFreeBytes: store.objects.budget.minFreeBytes });
      const info = await lstat(file); if (!info.isFile() || info.size > store.objects.budget.maxObjectBytes) throw new Error("OCI archive object budget exceeded");
      const hash = createHash("sha256"); let size = 0;
      for await (const chunk of createReadStream(file)) { signal?.throwIfAborted(); size += chunk.length; if (size > store.objects.budget.maxObjectBytes) throw new Error("OCI archive object budget exceeded"); hash.update(chunk); }
      const digest = sha(`sha256:${hash.digest("hex")}`); await store.objects.verify(digest, size, file);
      total += size; if (total > store.objects.budget.maxTotalBytes) throw new Error("bundle export budget exceeded");
      archives.push({ manifestDigest: image.resource.manifestDigest, digest, size });
    }
    const body = { protocol: "hitch-resource-bundle@1" as const, delivery, archives }, index = { ...body, digest: identity(body.protocol, body) };
    await atomicWriteJSON(path.join(temp, "index.json"), index); signal?.throwIfAborted(); await rename(temp, destination); return index;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
/** A directory bundle has no archive paths to extract. OCI archives go only to the OCI provider. */
export async function importResourceBundle(store: ResourceStore, directory: string, owner: string, signal?: AbortSignal): Promise<{ selection: ResourceSelection; transferredBytes: number; missingObjects: number }> {
  const indexFile = path.join(directory, "index.json");
  if (!(await lstat(directory)).isDirectory() || !(await lstat(indexFile)).isFile() || (await lstat(indexFile)).size > 16 * 1024 ** 2) throw new Error("invalid resource bundle");
  const raw = object(parseStrictJson(await readFile(indexFile, "utf8")), ["protocol", "delivery", "archives", "digest"]), { digest, ...body } = raw;
  if (raw.protocol !== "hitch-resource-bundle@1" || digest !== identity(raw.protocol, body) || !Array.isArray(raw.archives)) throw new Error("invalid resource bundle index");
  const delivery = parseResourceDelivery(raw.delivery), archives = raw.archives.map(a => {
    const entry = object(a, ["manifestDigest", "digest", "size"]); sha(entry.manifestDigest); sha(entry.digest);
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) throw new TypeError("invalid OCI archive size");
    return entry as unknown as BundleIndex["archives"][number];
  });
  if (canonical(archives.map(a => a.manifestDigest).sort()) !== canonical(delivery.images.map(i => i.resource.manifestDigest).sort())) throw new Error("offline image archives are incomplete or duplicate");
  for (const sub of ["objects", "oci"]) if (!(await lstat(path.join(directory, sub))).isDirectory()) throw new Error("bundle paths must be directories without links");
  if (canonical((await readdir(path.join(directory, "objects"))).sort()) !== canonical(delivery.objects.map(o => o.digest.slice(7)).sort()) || canonical((await readdir(path.join(directory, "oci"))).sort()) !== canonical(archives.map(a => a.manifestDigest.slice(7)).sort())) throw new Error("bundle object inventory mismatch");
  const total = delivery.objects.reduce((n, o) => n + o.size, 0) + archives.reduce((n, a) => n + a.size, 0);
  if (total > store.objects.budget.maxTotalBytes) throw new Error("offline bundle total byte budget exceeded");
  // Verify the entire bundle before any provider mutation.
  for (const item of delivery.objects) await store.objects.verify(item.digest, item.size, path.join(directory, "objects", item.digest.slice(7)));
  for (const item of archives) await store.objects.verify(item.digest, item.size, path.join(directory, "oci", item.manifestDigest.slice(7)));
  let expandedBytes = 0, imageFiles = 0;
  for (const archive of archives) {
    if (!store.options.images?.validateArchive) throw new Error("OCI provider does not support bounded offline validation");
    const usage = await store.options.images.validateArchive(delivery.images.find(i => i.resource.manifestDigest === archive.manifestDigest)!.resource, path.join(directory, "oci", archive.manifestDigest.slice(7)), signal,
      { maxExpandedBytes: store.objects.budget.maxTotalBytes - expandedBytes, maxFiles: store.objects.budget.maxFiles - imageFiles });
    expandedBytes += natural(usage.expandedBytes); imageFiles += natural(usage.files);
    if (expandedBytes > store.objects.budget.maxTotalBytes || imageFiles > store.objects.budget.maxFiles) throw new Error("offline OCI expanded budget exceeded");
  }
  const lease = await store.locked(() => store.beginLease(owner, "import"));
  for (const archive of archives) {
    if (!store.options.images?.importArchive) throw new Error("OCI provider does not support cache-only offline import");
    await store.importImageArchive(lease, delivery.images.find(i => i.resource.manifestDigest === archive.manifestDigest)!.resource, path.join(directory, "oci", archive.manifestDigest.slice(7)), signal);
  }
  const result = await receiveResourceDelivery(store, delivery, async item => createReadStream(path.join(directory, "objects", item.digest.slice(7))), owner, 1, signal);
  await store.finishLease(lease.id, "ended"); return { selection: parseResourceSelection(delivery.selection), transferredBytes: result.transferredBytes, missingObjects: result.missingObjects };
}
