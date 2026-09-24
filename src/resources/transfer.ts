import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";
import type { Sha256 } from "../domain/index.js";
import { canonical, identity, natural, object, parseResource, sha, type Resource } from "./protocol.js";
import { ResourceStore } from "./store.js";
import { parseResourceSelection, preflightResourceTask, type ResourceSelection } from "./tasks.js";

export interface ResourceDelivery {
  protocol: "hitch-resource-delivery@1";
  selection: ResourceSelection;
  objects: Array<{ digest: Sha256; size: number }>;
  images: Array<{ resource: Extract<Resource, { kind: "oci-image" }>; reference: string; configDigest: Sha256 }>;
  plans: Array<{ taskId: string; digest: Sha256 }>;
  digest: Sha256;
}
export function parseResourceDelivery(value: unknown): ResourceDelivery {
  const raw = object(value, ["protocol", "selection", "objects", "images", "plans", "digest"]);
  if (raw.protocol !== "hitch-resource-delivery@1" || !Array.isArray(raw.objects) || !Array.isArray(raw.images) || !Array.isArray(raw.plans)) throw new TypeError("invalid resource delivery");
  const selection = parseResourceSelection(raw.selection);
  const objects = raw.objects.map(v => { const o = object(v, ["digest", "size"]); return { digest: sha(o.digest), size: natural(o.size) }; });
  if (canonical(objects.map(o => o.digest)) !== canonical([...new Set(objects.map(o => o.digest))].sort())) throw new TypeError("delivery objects must be sorted and unique");
  const images = raw.images.map(item => {
    const i = object(item, ["resource", "reference", "configDigest"]), resource = parseResource(i.resource);
    if (resource.kind !== "oci-image" || typeof i.reference !== "string" || !i.reference.endsWith(`@${resource.manifestDigest}`) || /[\s\0]/.test(i.reference)) throw new TypeError("invalid delivery image");
    return { resource, reference: i.reference, configDigest: sha(i.configDigest) };
  });
  const expectedImages = [...new Set(selection.tasks.flatMap(task => Object.values(task.lock.resources)
    .filter(resource => resource.kind === "oci-image").map(resource => canonical(resource))))].sort((a, b) => a.localeCompare(b));
  if (canonical(images.map(image => canonical(image.resource))) !== canonical(expectedImages)) throw new TypeError("delivery images must exactly match the sorted unique selection closure");
  const plans = raw.plans.map(v => { const p = object(v, ["taskId", "digest"]); if (typeof p.taskId !== "string") throw new TypeError("invalid delivery plan"); return { taskId: p.taskId, digest: sha(p.digest) }; });
  if (canonical(plans.map(p => p.taskId)) !== canonical(selection.tasks.map(t => t.task_id))) throw new TypeError("delivery plans do not match selection");
  const { digest, ...body } = raw;
  if (sha(digest) !== identity(raw.protocol, body)) throw new TypeError("resource delivery digest mismatch");
  return raw as unknown as ResourceDelivery;
}
export async function createResourceDelivery(store: ResourceStore, selection: ResourceSelection, owner: string, generation: number, signal?: AbortSignal): Promise<ResourceDelivery> {
  return store.admission(() => assembleResourceDelivery(store, selection, owner, generation, signal));
}
async function assembleResourceDelivery(store: ResourceStore, selection: ResourceSelection, owner: string, generation: number, signal?: AbortSignal): Promise<ResourceDelivery> {
  selection = parseResourceSelection(selection);
  const objects = new Map<Sha256, number>(), images = new Map<string, ResourceDelivery["images"][number]>(), plans: ResourceDelivery["plans"] = [];
  for (const task of selection.tasks) {
    const checked = await preflightResourceTask(store, task, { owner: `${owner}:${task.task_id}`, generation, platform: selection.manifest.execution.platform, ...(signal ? { signal } : {}) });
    plans.push({ taskId: task.task_id, digest: checked.plan.digest });
    for (const digest of checked.closure.objectDigests) objects.set(digest, await store.objects.verify(digest));
    for (const image of checked.closure.images) {
      const resource = task.lock.resources[image.resource];
      if (resource?.kind !== "oci-image") throw new Error("delivery image not declared");
      images.set(canonical(resource), { resource, reference: image.reference, configDigest: image.configDigest });
    }
  }
  const body = { protocol: "hitch-resource-delivery@1" as const, selection, objects: [...objects].sort(([a], [b]) => a.localeCompare(b)).map(([digest, size]) => ({ digest, size })), images: [...images].sort(([a], [b]) => a.localeCompare(b)).map(([, i]) => i), plans };
  return parseResourceDelivery({ ...body, digest: identity(body.protocol, body) });
}
export type ResourceObjectReader = (object: ResourceDelivery["objects"][number], signal?: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;

function interruptible<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

async function* boundedRead(reader: ResourceObjectReader, item: ResourceDelivery["objects"][number], signal: AbortSignal): AsyncIterable<Uint8Array> {
  const opened = Promise.resolve().then(() => { signal.throwIfAborted(); return reader(item, signal); }).then(stream => stream[Symbol.asyncIterator]());
  let finished = false;
  try {
    const iterator = await interruptible(opened, signal);
    while (true) {
      signal.throwIfAborted();
      const next = await interruptible(Promise.resolve(iterator.next()), signal);
      if (next.done) { finished = true; return; }
      yield next.value;
    }
  } finally {
    // Close late readers too, but never let uncooperative stream cleanup retain the store lock.
    if (!finished) void opened.then(iterator => iterator.return?.()).catch(() => {});
  }
}

/** One bounded object stream at a time. Existing bytes are verified, never overwritten. */
export async function receiveResourceDelivery(store: ResourceStore, value: unknown, reader: ResourceObjectReader, owner: string, generation: number, signal?: AbortSignal): Promise<{ leaseId: string; transferredBytes: number; missingObjects: number }> {
  const delivery = parseResourceDelivery(value), limits = store.objects.budget;
  if (delivery.objects.length > limits.maxFiles || delivery.objects.some(o => o.size > limits.maxObjectBytes) || delivery.objects.reduce((n, o) => n + o.size, 0) > limits.maxTotalBytes) throw new Error("resource transfer budget exceeded");
  const received = await store.locked(async () => {
    const lease = await store.beginLease(owner, "import"), staging = path.join(store.directory, "staging", lease.id); let transferredBytes = 0, missingObjects = 0;
    await mkdir(staging, { recursive: true });
    try {
      for (const item of delivery.objects) {
        signal?.throwIfAborted(); await store.protect(lease, item.digest);
        const target = store.objects.objectPath(item.digest), existing = await lstat(target).catch(e => { if (e.code !== "ENOENT") throw e; return undefined; });
        if (existing) { await store.objects.verify(item.digest, item.size); continue; }
        const quarantine = path.join(store.directory, "quarantine", item.digest.slice(7));
        if (await lstat(quarantine).catch(e => { if (e.code !== "ENOENT") throw e; return undefined; })) {
          await store.objects.verify(item.digest, item.size, quarantine); await mkdir(path.dirname(target), { recursive: true }); await rename(quarantine, target); await rm(path.join(store.directory, "quarantine-index", `${item.digest.slice(7)}.json`), { force: true }); continue;
        }
        const space = await statfs(staging, { bigint: true }); if (space.bsize * space.bavail < BigInt(item.size + limits.minFreeBytes)) throw new Error("resource transfer free-space reserve exceeded");
        const file = path.join(staging, randomUUID()), output = await open(file, "wx", 0o600); let size = 0;
        const timeout = AbortSignal.timeout(120_000), bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try { for await (const chunk of boundedRead(reader, item, bounded)) { bounded.throwIfAborted(); size += chunk.byteLength; if (size > item.size) throw new Error("resource transfer exceeds declared size"); await output.writeFile(chunk); } bounded.throwIfAborted(); await output.sync(); }
        finally { await output.close(); }
        if (size !== item.size) throw new Error("resource transfer is truncated");
        await store.objects.verify(item.digest, item.size, file); signal?.throwIfAborted();
        await store.objects.publish(file, item.digest, item.size, d => store.protect(lease, d)); missingObjects++; transferredBytes += size;
      }
      return { leaseId: lease.id, transferredBytes, missingObjects };
    } finally { await rm(staging, { recursive: true, force: true }); }
  }, signal);
  // Producer protection survives failures until an operator confirms recovery.
  const expected = new Set<Sha256>();
  for (const task of delivery.selection.tasks) {
    const checked = await preflightResourceTask(store, task, { owner: `${owner}:${task.task_id}`, generation, platform: delivery.selection.manifest.execution.platform, ...(signal ? { signal } : {}) });
    if (checked.plan.digest !== delivery.plans.find(p => p.taskId === task.task_id)?.digest) throw new Error("remote resource plan changed");
    checked.closure.objectDigests.forEach(d => expected.add(d));
    for (const i of checked.closure.images) if (!delivery.images.some(e => e.resource.manifestDigest === i.manifestDigest && e.resource.platform === i.platform && e.configDigest === i.configDigest)) throw new Error("remote OCI config changed");
  }
  if (canonical([...expected].sort()) !== canonical(delivery.objects.map(o => o.digest))) throw new Error("delivery contains an incomplete or extraneous closure");
  await store.finishLease(received.leaseId, "ended"); return received;
}
