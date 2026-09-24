import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Sha256 } from "../domain/index.js";
import { durableWriteJSON as atomicWriteJSON, removeResourceImageFence, withEnvironmentImageReferenceLock, withFileLock, writeResourceImageFence } from "../foundation/index.js";
import { ObjectStore, limits, type ResourceLimits } from "./object-store.js";
import { canonical, hash, identity, natural, object, parseResourceLock, parseStrictJson, sha, type Resource, type TaskResourceLock } from "./protocol.js";
import type { ImageImportBudget, ImageImportUsage } from "./oci-layer-validation.js";

export interface ResourceImageProvider {
  readonly protocol: "hitch-oci-provider@1";
  resolve(resource: Extract<Resource, { kind: "oci-image" }>, signal?: AbortSignal): Promise<{ imageId: Sha256; configDigest: Sha256; manifestDigest: Sha256; platform: string; reference: string }>;
  exportArchive?(resource: Extract<Resource, { kind: "oci-image" }>, destination: string, signal?: AbortSignal, budget?: { maxBytes: number; minFreeBytes: number }): Promise<void>;
  validateArchive?(resource: Extract<Resource, { kind: "oci-image" }>, source: string, signal?: AbortSignal, budget?: ImageImportBudget): Promise<ImageImportUsage>;
  importArchive?(resource: Extract<Resource, { kind: "oci-image" }>, source: string, signal?: AbortSignal, budget?: ImageImportBudget): Promise<void>;
}
export interface ResourceClosure {
  protocol: "hitch-resource-closure@1";
  resources: TaskResourceLock["resources"];
  objectDigests: Sha256[];
  images: Array<{ resource: string; imageId: Sha256; configDigest: Sha256; manifestDigest: Sha256; platform: string; reference: string }>;
  digest: Sha256;
  logicalBytes: number;
}
export interface ResourceLease {
  protocol: "hitch-resource-lease@1";
  id: string;
  owner: string;
  purpose: "import" | "preflight" | "execution" | "export";
  state: "active" | "unknown" | "released";
  objectDigests: Sha256[];
  imageIds: Sha256[];
  createdAt: string;
}
export interface ResourceRoot {
  protocol: "hitch-resource-root@1";
  owner: string;
  generation: number;
  state: "active" | "released";
  purpose: string;
  lock: TaskResourceLock;
  closure: ResourceClosure;
}
export class ResourceStore {
  private readonly admissionImages = new AsyncLocalStorage<Map<string, Awaited<ReturnType<ResourceImageProvider["resolve"]>>>>();
  readonly objects: ObjectStore;
  readonly directory: string;
  constructor(readonly root: string, readonly options: { limits?: Partial<ResourceLimits>; images?: ResourceImageProvider } = {}) {
    if (options.images && options.images.protocol !== "hitch-oci-provider@1") throw new TypeError("unsupported OCI provider protocol");
    this.objects = new ObjectStore(path.resolve(root), limits(options.limits)); this.directory = this.objects.directory;
  }
  admission<T>(operation: () => Promise<T>): Promise<T> { return this.admissionImages.run(new Map(), operation); }
  async locked<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    if (!(await lstat(this.directory)).isDirectory()) throw new Error("resource store must be a directory");
    return withFileLock(path.join(this.root, "locks", "benchmark-resources"), "global", operation, { signal, timeoutCode: "resource_store_locked" });
  }
  async importImageArchive(lease: ResourceLease, resource: Extract<Resource, { kind: "oci-image" }>, source: string, signal?: AbortSignal): Promise<void> {
    await this.locked(() => withEnvironmentImageReferenceLock(this.root, async () => {
      if (!this.options.images?.importArchive) throw new Error("OCI archive import unsupported");
      await writeResourceImageFence(this.root, { protocol: "hitch-resource-image-fence@1", owner: `lease:${lease.id}`, state: "preparing", imageIds: lease.imageIds });
      await this.options.images.importArchive(resource, source, signal, { maxExpandedBytes: this.objects.budget.maxTotalBytes, maxFiles: this.objects.budget.maxFiles });
      const resolved = await this.options.images.resolve(resource, signal);
      lease.imageIds = [...new Set([...lease.imageIds, resolved.imageId])].sort(); await atomicWriteJSON(this.recordPath("leases", lease.id), lease);
      await writeResourceImageFence(this.root, { protocol: "hitch-resource-image-fence@1", owner: `lease:${lease.id}`, state: "active", imageIds: lease.imageIds });
    }), signal);
  }
  recordPath(kind: "roots" | "leases" | "transactions", key: string): string { return path.join(this.directory, kind, `${hash(key).slice(7)}.json`); }
  async readRecord<T>(kind: "roots" | "leases" | "transactions", key: string): Promise<T | undefined> {
    try { const file = this.recordPath(kind, key); if (!(await lstat(file)).isFile()) throw new TypeError("resource record must be a regular file"); return parseStrictJson(await readFile(file, "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async records<T>(kind: "roots" | "leases" | "transactions"): Promise<T[]> {
    const dir = path.join(this.directory, kind);
    const files = await readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return []; });
    return Promise.all(files.map(async file => {
      if (!/^[a-f0-9]{64}\.json$/.test(file) || !(await lstat(path.join(dir, file))).isFile()) throw new TypeError("invalid resource record filename");
      const value = parseStrictJson(await readFile(path.join(dir, file), "utf8")) as Record<string, unknown>;
      const key = kind === "roots" ? value.owner : value.id;
      if (typeof key !== "string" || file !== `${hash(key).slice(7)}.json`) throw new TypeError("resource record address mismatch");
      return value as T;
    }));
  }
  async beginLease(owner: string, purpose: ResourceLease["purpose"]): Promise<ResourceLease> {
    validateOwner(owner);
    const lease: ResourceLease = { protocol: "hitch-resource-lease@1", id: randomUUID(), owner, purpose, state: "active", objectDigests: [], imageIds: [], createdAt: new Date().toISOString() };
    await atomicWriteJSON(this.recordPath("leases", lease.id), lease); return lease;
  }
  async protect(lease: ResourceLease, digest: Sha256): Promise<void> {
    if (!lease.objectDigests.includes(digest)) { lease.objectDigests.push(digest); lease.objectDigests.sort(); await atomicWriteJSON(this.recordPath("leases", lease.id), lease); }
  }
  async import(source: string, kind: "blob" | "tree", owner: string, signal?: AbortSignal): Promise<{ resource: Resource; leaseId: string; logicalBytes: number; storedBytes: number }> {
    return this.locked(async () => {
      const lease = await this.beginLease(owner, "import"), staging = path.join(this.directory, "staging", lease.id);
      await atomicWriteJSON(this.recordPath("transactions", lease.id), { protocol: "hitch-resource-transaction@1", id: lease.id, owner, state: "importing" });
      await mkdir(staging, { recursive: true });
      try {
        const result = kind === "blob" ? await this.objects.importFile(source, staging, d => this.protect(lease, d), signal)
          : await this.objects.importTree(source, staging, d => this.protect(lease, d), signal);
        await atomicWriteJSON(this.recordPath("transactions", lease.id), { protocol: "hitch-resource-transaction@1", id: lease.id, owner, state: "imported", resource: result.resource });
        return { ...result, leaseId: lease.id, logicalBytes: "logicalBytes" in result ? result.logicalBytes : result.resource.size };
      } catch (error) {
        lease.state = "released"; await atomicWriteJSON(this.recordPath("leases", lease.id), lease);
        await atomicWriteJSON(this.recordPath("transactions", lease.id), { protocol: "hitch-resource-transaction@1", id: lease.id, owner, state: "failed" }); throw error;
      } finally { await rm(staging, { recursive: true, force: true }); }
    }, signal);
  }
  /** Caller holds the store lock; no content trust is cached across admissions. */
  async closure(lock: TaskResourceLock, lease: ResourceLease, signal?: AbortSignal): Promise<ResourceClosure> {
    const parsed = parseResourceLock(lock), objectDigests = new Set<Sha256>(), images: ResourceClosure["images"] = []; let logicalBytes = 0, files = 0;
    for (const resource of Object.values(parsed.resources)) {
      signal?.throwIfAborted();
      if (resource.kind === "oci-image") continue;
      const digest = resource.kind === "blob" ? resource.digest : resource.manifestDigest;
      await this.protect(lease, digest); await restoreObject(this, digest);
      await this.objects.verify(digest, resource.kind === "blob" ? resource.size : undefined); objectDigests.add(digest);
      if (resource.kind === "blob") { logicalBytes += resource.size; files++; }
      else {
        const tree = await this.objects.readTree(digest); files += tree.entries.length;
        for (const entry of tree.entries) if (entry.kind === "file") {
          await this.protect(lease, entry.digest); await restoreObject(this, entry.digest); await this.objects.verify(entry.digest, entry.size); objectDigests.add(entry.digest); logicalBytes += entry.size;
        }
      }
      if (logicalBytes > this.objects.budget.maxTotalBytes || files > this.objects.budget.maxFiles) throw new Error("resource closure budget exceeded");
    }
    const oci = Object.entries(parsed.resources).filter((entry): entry is [string, Extract<Resource, { kind: "oci-image" }>] => entry[1].kind === "oci-image");
    if (oci.length) {
      if (!this.options.images) throw new Error("OCI resource provider unavailable");
      await withEnvironmentImageReferenceLock(this.root, async () => {
        await writeResourceImageFence(this.root, { protocol: "hitch-resource-image-fence@1", owner: `lease:${lease.id}`, state: "preparing", imageIds: lease.imageIds });
        const resolved = this.admissionImages.getStore() ?? new Map<string, Awaited<ReturnType<ResourceImageProvider["resolve"]>>>();
        for (const [id, resource] of oci) {
          const key = canonical(resource), value = resolved.get(key) ?? await this.options.images!.resolve(resource, signal); resolved.set(key, value);
          if (sha(value.manifestDigest) !== resource.manifestDigest || value.platform !== resource.platform || !value.reference.endsWith(`@${resource.manifestDigest}`)) throw new Error("OCI resource identity mismatch");
          sha(value.configDigest); sha(value.imageId); images.push({ resource: id, ...value });
        }
        lease.imageIds = [...new Set(images.map(i => i.imageId))].sort(); await atomicWriteJSON(this.recordPath("leases", lease.id), lease);
        await writeResourceImageFence(this.root, { protocol: "hitch-resource-image-fence@1", owner: `lease:${lease.id}`, state: "active", imageIds: lease.imageIds });
      });
    }
    const content = { protocol: "hitch-resource-closure@1" as const, resources: parsed.resources, objectDigests: [...objectDigests].sort() };
    // Locations and local provider IDs are evidence, not closure identity.
    return { ...content, images, logicalBytes, digest: identity(content.protocol, content) };
  }
  async acquire(owner: string, lock: unknown, purpose: ResourceLease["purpose"] = "preflight", signal?: AbortSignal): Promise<{ lease: ResourceLease; closure: ResourceClosure }> {
    const parsed = parseResourceLock(lock);
    return this.locked(async () => { const lease = await this.beginLease(owner, purpose); return { lease, closure: await this.closure(parsed, lease, signal) }; }, signal);
  }
  async pin(input: { owner: string; generation: number; purpose: string; lock: unknown }, signal?: AbortSignal): Promise<ResourceRoot> {
    validateOwner(input.owner); generation(input.generation); validateOwner(input.purpose); const lock = parseResourceLock(input.lock);
    return this.locked(async () => {
      const previous = await this.readRecord<ResourceRoot>("roots", input.owner);
      if (previous) {
        validateRoot(previous);
        if (previous.owner !== input.owner) throw new Error("resource owner address mismatch");
        if (previous.generation > input.generation || previous.generation === input.generation && previous.state === "released") throw new Error("resource owner generation has been released or superseded");
        if (previous.state === "active" && (previous.generation !== input.generation || canonical(previous.lock) !== canonical(lock) || previous.purpose !== input.purpose)) throw new Error("active owner generation cannot be replaced");
      }
      const lease = await this.beginLease(input.owner, "preflight"), closure = await this.closure(lock, lease, signal);
      const record: ResourceRoot = { protocol: "hitch-resource-root@1", owner: input.owner, generation: input.generation, purpose: input.purpose, state: "active", lock, closure };
      await withEnvironmentImageReferenceLock(this.root, async () => {
        await writeResourceImageFence(this.root, { protocol: "hitch-resource-image-fence@1", owner: `root:${input.owner}:${input.generation}`, state: "active", imageIds: lease.imageIds });
        await atomicWriteJSON(this.recordPath("roots", input.owner), record);
      });
      await this.finishLeaseLocked(lease); return record;
    }, signal);
  }
  async release(owner: string, expectedGeneration: number): Promise<void> {
    validateOwner(owner); generation(expectedGeneration);
    await this.locked(async () => {
      const record = await this.readRecord<ResourceRoot>("roots", owner); if (!record) throw new Error("resource owner is missing"); validateRoot(record);
      if (record.owner !== owner) throw new Error("resource owner address mismatch");
      if (record.generation !== expectedGeneration) throw new Error("stale resource owner generation");
      // Persist tombstone first. An interrupted release may retain an extra image fence.
      record.state = "released"; await atomicWriteJSON(this.recordPath("roots", owner), record);
      await withEnvironmentImageReferenceLock(this.root, () => removeResourceImageFence(this.root, `root:${owner}:${expectedGeneration}`));
    });
  }
  async finishLease(id: string, confirmation: "ended" | "unknown"): Promise<void> {
    if (!["ended", "unknown"].includes(confirmation)) throw new TypeError("explicit lease end or unknown confirmation required");
    await this.locked(async () => {
      const lease = await this.readRecord<ResourceLease>("leases", id); if (!lease) throw new Error("resource lease missing"); validateLease(lease);
      if (lease.id !== id) throw new Error("resource lease address mismatch");
      if (confirmation === "unknown") { if (lease.state !== "released") { lease.state = "unknown"; await atomicWriteJSON(this.recordPath("leases", id), lease); } }
      else {
        // The same lock excludes a live importer. Only its UUID staging is
        // owned here; unfamiliar directories and execution workspaces remain.
        if (lease.purpose === "import") {
          const staging = path.join(this.directory, "staging", id);
          const info = await lstat(staging).catch(e => { if (e.code !== "ENOENT") throw e; return undefined; });
          if (info && !info.isDirectory()) throw new Error("unsafe import staging ownership");
          await rm(staging, { recursive: true, force: true });
          const transaction = await this.readRecord<{ protocol: string; id: string; owner: string }>("transactions", id);
          if (transaction) {
            if (transaction.protocol !== "hitch-resource-transaction@1" || transaction.id !== id || transaction.owner !== lease.owner) throw new Error("import transaction ownership mismatch");
            await atomicWriteJSON(this.recordPath("transactions", id), { ...transaction, state: "ended" });
          }
        }
        await this.finishLeaseLocked(lease);
      }
    });
  }
  async finishLeaseLocked(lease: ResourceLease): Promise<void> {
    lease.state = "released"; await atomicWriteJSON(this.recordPath("leases", lease.id), lease);
    await withEnvironmentImageReferenceLock(this.root, () => removeResourceImageFence(this.root, `lease:${lease.id}`));
  }
}
export function validateOwner(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 512 || /[\x00-\x1f]/.test(value)) throw new TypeError("invalid resource owner or purpose");
}
function generation(value: unknown): void { if (natural(value) < 1) throw new TypeError("resource generation must be positive"); }
export function validateLease(value: ResourceLease): void {
  object(value, ["protocol", "id", "owner", "purpose", "state", "objectDigests", "imageIds", "createdAt"]);
  if (value.protocol !== "hitch-resource-lease@1" || !/^[0-9a-f-]{36}$/.test(value.id) || !["import", "preflight", "execution", "export"].includes(value.purpose) || !["active", "unknown", "released"].includes(value.state) || !Number.isFinite(Date.parse(value.createdAt))) throw new TypeError("invalid resource lease");
  validateOwner(value.owner); if (!Array.isArray(value.objectDigests) || !Array.isArray(value.imageIds)) throw new TypeError("invalid lease closure"); value.objectDigests.forEach(sha); value.imageIds.forEach(sha);
}
export function validateRoot(value: ResourceRoot): void {
  object(value, ["protocol", "owner", "generation", "purpose", "state", "lock", "closure"]);
  if (value.protocol !== "hitch-resource-root@1" || !["active", "released"].includes(value.state)) throw new TypeError("invalid resource root");
  validateOwner(value.owner); validateOwner(value.purpose); generation(value.generation); parseResourceLock(value.lock);
  const c = value.closure; object(c, ["protocol", "resources", "objectDigests", "images", "digest", "logicalBytes"]);
  if (c.protocol !== "hitch-resource-closure@1" || canonical(c.resources) !== canonical(value.lock.resources) || !Array.isArray(c.objectDigests) || !Array.isArray(c.images)
    || identity(c.protocol, { protocol: c.protocol, resources: c.resources, objectDigests: c.objectDigests }) !== c.digest) throw new TypeError("invalid root closure");
  c.objectDigests.forEach(sha); natural(c.logicalBytes);
  const expected = Object.entries(value.lock.resources).filter(([, r]) => r.kind === "oci-image").map(([id]) => id).sort();
  if (canonical(c.images.map(i => i.resource).sort()) !== canonical(expected)) throw new TypeError("root OCI closure is incomplete");
  for (const image of c.images) {
    object(image, ["resource", "imageId", "configDigest", "manifestDigest", "platform", "reference"]);
    const resource = value.lock.resources[image.resource];
    if (resource?.kind !== "oci-image" || image.manifestDigest !== resource.manifestDigest || image.platform !== resource.platform || typeof image.reference !== "string" || !image.reference.endsWith(`@${resource.manifestDigest}`)) throw new TypeError("invalid root OCI identity");
    sha(image.imageId); sha(image.configDigest);
  }
}
export async function restoreObject(store: ResourceStore, digest: Sha256): Promise<void> {
  const { rename } = await import("node:fs/promises");
  const objectFile = store.objects.objectPath(digest), quarantined = path.join(store.directory, "quarantine", digest.slice(7));
  try { await lstat(objectFile); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    await mkdir(path.dirname(objectFile), { recursive: true });
    await store.objects.verify(digest, undefined, quarantined);
    await rename(quarantined, objectFile); // Missing content fails; never pins a dangling ref.
    await rm(path.join(store.directory, "quarantine-index", `${digest.slice(7)}.json`), { force: true });
  }
}
