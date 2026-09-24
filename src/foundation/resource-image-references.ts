import { durableWriteJSON as atomicWriteJSON } from "./durable-json.js";
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Sha256 } from "../domain/index.js";
import { readJSON } from "./fs.js";
import { sha256JSON } from "./hash.js";

export interface ResourceImageFence {
  protocol: "hitch-resource-image-fence@1";
  owner: string;
  state: "preparing" | "active";
  imageIds: Sha256[];
}
const directory = (root: string) => path.join(root, "store", "resource-image-references");
/** Caller holds withEnvironmentImageReferenceLock, including the provider call.
 * Preparing records survive a crash and stop GC until explicitly reconciled. */
export async function writeResourceImageFence(root: string, fence: ResourceImageFence): Promise<void> {
  validate(fence);
  await atomicWriteJSON(path.join(directory(root), `${sha256JSON(fence.owner).slice(7)}.json`), fence);
}
export async function removeResourceImageFence(root: string, owner: string): Promise<void> {
  await rm(path.join(directory(root), `${sha256JSON(owner).slice(7)}.json`), { force: true });
}
export async function resourceImageReferences(root: string): Promise<Map<Sha256, Set<string>>> {
  const result = new Map<Sha256, Set<string>>();
  let entries: string[];
  try { entries = await readdir(directory(root)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
  for (const file of entries) {
    if (!/^[a-f0-9]{64}\.json$/.test(file) || !(await lstat(path.join(directory(root), file))).isFile()) throw new TypeError("invalid resource image reference file");
    const fence = await readJSON<ResourceImageFence>(path.join(directory(root), file)); validate(fence);
    if (`${sha256JSON(fence.owner).slice(7)}.json` !== file) throw new TypeError("resource image reference address mismatch");
    if (fence.state === "preparing") throw new Error("resource image acquisition is incomplete; retain images until recovery");
    for (const id of fence.imageIds) { const reasons = result.get(id) ?? new Set<string>(); reasons.add(`resource-owner:${fence.owner}`); result.set(id, reasons); }
  }
  return result;
}
function validate(fence: ResourceImageFence): void {
  if (!fence || Object.keys(fence).some(k => !["protocol", "owner", "state", "imageIds"].includes(k))
    || fence.protocol !== "hitch-resource-image-fence@1" || typeof fence.owner !== "string" || !fence.owner
    || !["preparing", "active"].includes(fence.state) || !Array.isArray(fence.imageIds)
    || fence.imageIds.some(id => typeof id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(id))
    || new Set(fence.imageIds).size !== fence.imageIds.length) throw new TypeError("invalid resource image fence");
}
