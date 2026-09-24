import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { atomicWriteJSON, sha256JSON } from "../foundation/index.js";
import { configuredResourceStore, finishResourceWorkspace, materializeResourceTask, preflightResourceInput, readResourceInput } from "../resources/index.js";
import { buildBenchmarkAdapterManifest, loadBenchmarkAdapterManifest } from "./benchmark-adapter-manifest.js";

/** Explicit conversion creates a new v1 dataset identity and keeps all role contexts. */
export async function exportResourceLegacy(root: string, ref: string, destination: string): Promise<{ destination: string; sourceDigest: string; datasetDigest: string }> {
  const source = await readResourceInput(ref); if (!source) throw new TypeError("legacy export requires a resource dataset/selection");
  const manifest = "schema_version" in source ? source : source.manifest;
  const { store, config } = await configuredResourceStore(root), owner = `legacy-export:${randomUUID()}`;
  const checked = await preflightResourceInput(store, ref, { owner, generation: 1, platform: config.platform }); if (!checked) throw new Error("resource preflight missing");
  destination = path.resolve(destination);
  if (await lstat(destination).catch(e => { if (e.code !== "ENOENT") throw e; return undefined; })) throw new Error("legacy export destination exists");
  const temp = `${destination}.${randomUUID()}.tmp`; await mkdir(temp, { recursive: true, mode: 0o700 });
  const workspaces: string[] = []; let bytes = 0;
  try {
    for (const plan of checked.plans) {
      const workspace = await materializeResourceTask(store, plan, { owner: `${owner}:${plan.task.task_id}`, generation: 1, policy: config.workspace }); workspaces.push(workspace.id);
      bytes += workspace.copiedBytes + workspace.clonedBytes;
      if (bytes > store.objects.budget.maxTotalBytes) throw new Error("legacy export total byte budget exceeded");
      const target = path.join(temp, plan.task.task_id);
      await cp(workspace.taskDirectory, target, { recursive: true, errorOnExist: true, force: false, dereference: false });
      await atomicWriteJSON(path.join(target, "resource-export.provenance.json"), { protocol: "hitch-resource-legacy-export@1", sourceInputDigest: checked.inputDigest, planDigest: plan.digest, materializedTaskDigest: workspace.materialized_task_digest });
      await finishResourceWorkspace(store, workspace.id, { executionEnded: true, resultSealed: true }); workspaces.pop();
    }
    let exported = await buildBenchmarkAdapterManifest({ dataset: temp, benchmark: manifest.benchmark,
      adapter: { ...manifest.adapter, revision: sha256JSON({ protocol: "hitch-resource-legacy-export@1", source: manifest.adapter, input: checked.inputDigest }) },
      scoring: manifest.scoring, taskIds: source.tasks.map(t => t.task_id) });
    if (manifest.raw_metrics) {
      const { dataset_digest: _digest, ...body } = exported; const next = { ...body, raw_metrics: manifest.raw_metrics }; exported = { ...next, dataset_digest: sha256JSON(next) };
    }
    await atomicWriteJSON(path.join(temp, "benchmark.adapter.json"), exported);
    await loadBenchmarkAdapterManifest(temp); await rename(temp, destination);
    return { destination, sourceDigest: checked.inputDigest, datasetDigest: exported.dataset_digest };
  } finally {
    await rm(temp, { recursive: true, force: true });
    for (const id of workspaces) await finishResourceWorkspace(store, id, { executionEnded: true, resultSealed: true });
  }
}
