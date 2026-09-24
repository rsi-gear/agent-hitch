import { copyFile, lstat, mkdir, readFile, readdir, statfs } from "node:fs/promises";
import path from "node:path";
import type { ExecutionEvidenceV1 } from "../domain/index.js";
import { canonical, identity, natural, object, parseStrictJson, sha } from "./protocol.js";
import { fileClosure } from "./gc.js";
import { ResourceStore } from "./store.js";
import { parseResourceTask, preflightResourceTask, taskClosureLock, type ResourcePlan, type ResourceTask } from "./tasks.js";

const MAX_PROOF_BYTES = 32 * 1024 ** 2;
export interface ResourceProofObject { digest: `sha256:${string}`; size: number }

/** Only newly derived descriptor bytes travel back with the result. Input data
 * already exists at the controller and must not be re-embedded in its envelope. */
export async function exportResourceResultProof(store: ResourceStore, plan: ResourcePlan, allDigests: `sha256:${string}`[], directory: string): Promise<ResourceProofObject[]> {
  const source = new Set(await fileClosure(store, Object.values(taskClosureLock(plan.task).resources)));
  const proof: ResourceProofObject[] = []; let total = 0;
  for (const digest of allDigests.filter(d => !source.has(d)).sort()) {
    const size = await store.objects.verify(digest); total += size;
    if (total > MAX_PROOF_BYTES) throw new Error("resource result proof byte budget exceeded");
    proof.push({ digest, size });
  }
  const output = path.join(directory, "resource-proof"); await mkdir(output);
  const space = await statfs(output, { bigint: true });
  if (space.bavail * space.bsize < BigInt(total) + BigInt(store.objects.budget.minFreeBytes)) throw new Error("resource result proof free-space reserve exceeded");
  for (const item of proof) await copyFile(store.objects.objectPath(item.digest), path.join(output, item.digest.slice(7)));
  return proof;
}

/** Restore/pin the worker's materialization proof before publishing its result.
 * The original task is selected by controller admission, never by the worker. */
export async function retainResourceResult(input: { store: ResourceStore; directory: string; task: ResourceTask; runId: string; execution: ExecutionEvidenceV1; requireObserved: boolean }): Promise<void> {
  if (!/^run_[a-f0-9]{32}$/.test(input.runId)) throw new Error("invalid resource result run identity");
  const file = path.join(input.directory, "resource.execution.json"), info = await lstat(file);
  if (!info.isFile() || info.size > 16 * 1024 ** 2) throw new Error("resource result evidence missing or oversized");
  const value = object(parseStrictJson(await readFile(file, "utf8")), ["protocol", "plan", "materialized_task_digest", "materializedTree", "images", "observed", "materialization", "proofObjects"]);
  const plan = object(value.plan, ["protocol", "resolver", "backend", "platform", "task", "digest"]);
  const task = parseResourceTask(plan.task), owner = `run:${input.runId}`;
  if (value.protocol !== "hitch-resource-execution@1" || canonical(task) !== canonical(input.task)) throw new Error("remote resource result task differs from admission");
  const checked = await preflightResourceTask(input.store, input.task, { owner: `${owner}:admission`, generation: 1, platform: String(plan.platform) });
  if (canonical(plan) !== canonical(checked.plan)) throw new Error("remote resource result plan differs from admission");
  const tree = object(value.materializedTree, ["kind", "format", "manifestDigest"]);
  if (tree.kind !== "tree" || tree.format !== "hitch-tree@1" || value.materialized_task_digest !== identity("hitch-materialized-task@1", tree)) throw new Error("remote materialization proof identity mismatch");
  const materializedTree = { kind: "tree" as const, format: "hitch-tree@1" as const, manifestDigest: sha(tree.manifestDigest) };
  if (!Array.isArray(value.images) || !Array.isArray(value.observed) || !Array.isArray(value.proofObjects)) throw new Error("incomplete resource result evidence");
  const images = value.images.map(item => {
    const image = object(item, ["resource", "imageId", "configDigest", "manifestDigest", "platform", "reference"]);
    const expected = checked.closure.images.find(i => i.resource === image.resource);
    if (!expected || image.configDigest !== expected.configDigest || image.manifestDigest !== expected.manifestDigest || image.platform !== expected.platform) throw new Error("remote result OCI base differs from admission");
    return image;
  });
  if (canonical(images.map(i => i.resource).sort()) !== canonical(checked.closure.images.map(i => i.resource).sort())) throw new Error("incomplete resource result OCI closure");
  const observed = value.observed.map(item => object(item, ["consumer", "configDigest", "platform", "baseConfigs"]));
  if (input.requireObserved) for (const binding of task.lock.bindings.filter(b => b.use === "environment-image")) {
    const expected = checked.closure.images.find(i => i.resource === binding.resource)!;
    if (!observed.some(o => canonical(o.consumer) === canonical(binding.consumer) && o.platform === checked.plan.platform
      && Array.isArray(o.baseConfigs) && o.baseConfigs.includes(expected.configDigest)
      && input.execution.observed.containers.some(c => c.image_config_digest === o.configDigest))) throw new Error("remote result lacks observed resource role evidence");
  }
  const proof = value.proofObjects.map(item => { const v = object(item, ["digest", "size"]); return { digest: sha(v.digest), size: natural(v.size) }; });
  if (proof.length > input.store.objects.budget.maxFiles || proof.reduce((n, p) => n + p.size, 0) > MAX_PROOF_BYTES
    || canonical(proof.map(p => p.digest)) !== canonical([...new Set(proof.map(p => p.digest))].sort())) throw new Error("resource proof inventory or budget invalid");
  const proofDirectory = path.join(input.directory, "resource-proof");
  if (!(await lstat(proofDirectory)).isDirectory() || canonical((await readdir(proofDirectory)).sort()) !== canonical(proof.map(p => p.digest.slice(7)))) throw new Error("resource proof file inventory mismatch");
  for (const item of proof) await input.store.objects.verify(item.digest, item.size, path.join(proofDirectory, item.digest.slice(7)));
  const leases: string[] = [];
  for (const item of proof) {
    const imported = await input.store.import(path.join(proofDirectory, item.digest.slice(7)), "blob", `${owner}:proof`); leases.push(imported.leaseId);
    if (imported.resource.kind !== "blob" || imported.resource.digest !== item.digest) throw new Error("resource proof changed during import");
  }
  const source = taskClosureLock(task);
  const root = await input.store.pin({ owner, generation: 1, purpose: "sealed-run", lock: { ...source, resources: { ...source.resources, "hitch-materialized-task": materializedTree } } });
  const base = new Set(checked.closure.objectDigests), actualDelta = root.closure.objectDigests.filter(d => !base.has(d)).sort();
  if (canonical(actualDelta) !== canonical(proof.map(p => p.digest))) throw new Error("resource proof has missing or extraneous objects");
  for (const lease of leases) await input.store.finishLease(lease, "ended");
}
