import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionEvidenceV1 } from "../domain/index.js";
import { durableWriteJSON as atomicWriteJSON, runCommand } from "../foundation/index.js";
import { canonical, identity, parseStrictJson, sha } from "./protocol.js";
import { finishResourceWorkspace, type WorkspaceEvidence } from "./materialize.js";
import { ResourceStore } from "./store.js";
import { parseResourceTask, taskClosureLock } from "./tasks.js";
import { exportResourceResultProof } from "./result-retention.js";

export interface ResourceExecutionEvidence extends WorkspaceEvidence { executionEnded: boolean; resultSealed?: boolean; preflightPlanDigest: string }
export async function readResourceEvidence(file: string): Promise<ResourceExecutionEvidence | undefined> {
  const info = await lstat(file).catch(e => { if (e.code !== "ENOENT") throw e; return undefined; }); if (!info) return undefined;
  if (!info.isFile() || info.size > 16 * 1024 ** 2) throw new Error("invalid resource execution evidence");
  const evidence = parseStrictJson(await readFile(file, "utf8")) as ResourceExecutionEvidence;
  const { digest, ...body } = evidence.plan; parseResourceTask(evidence.plan.task);
  if (evidence.protocol !== "hitch-resource-workspace@1" || digest !== identity("hitch-resource-plan@1", body) || !/^[a-f0-9-]{36}$/.test(evidence.id) || typeof evidence.executionEnded !== "boolean") throw new Error("resource execution evidence identity mismatch");
  sha(evidence.materialized_task_digest);
  if (!evidence.materializedTree || identity("hitch-materialized-task@1", evidence.materializedTree) !== evidence.materialized_task_digest) throw new Error("materialized tree proof missing");
  return evidence;
}
/** Run evidence is sealed before the execution lease can be released. */
export async function sealResourceEvidence(input: { store: ResourceStore; file: string; runDirectory: string; owner: string; taskId: string; execution?: ExecutionEvidenceV1; requireObserved: boolean }): Promise<void> {
  const evidence = await readResourceEvidence(input.file); if (!evidence) return;
  if (evidence.plan.task.task_id !== input.taskId) throw new Error("resource execution task mismatch");
  const observed: Array<{ consumer: unknown; configDigest: string; platform: string; baseConfigs: string[] }> = [];
  const docker = process.env.HITCH_DOCKER_PATH || "docker", cache = new Map<string, Record<string, any>>();
  const inspect = async (digest: string) => {
    sha(digest); let value = cache.get(digest); if (value) return value;
    value = JSON.parse((await runCommand(docker, ["image", "inspect", "--format", "{{json .}}", digest], { timeoutMs: 30_000 })).stdout);
    if (value!.Id !== digest || !Array.isArray(value!.RootFS?.Layers)) throw new Error("observed OCI config identity mismatch"); cache.set(digest, value!); return value!;
  };
  for (const container of input.execution?.observed.containers ?? []) {
    if (!container.image_config_digest) continue;
    const image = await inspect(container.image_config_digest), labels = image.Config?.Labels ?? {};
    if (labels["dev.hitch.resource.plan"] !== evidence.plan.digest) continue;
    const role = labels["dev.hitch.resource.consumer"], consumer = parseStrictJson(role);
    const bindings = evidence.plan.task.lock.bindings.filter(b => canonical(b.consumer) === canonical(consumer) && b.use === "environment-image");
    if (!bindings.length) throw new Error("observed resource consumer is undeclared");
    const platform = `${image.Os}/${image.Architecture}${image.Variant ? `/${image.Variant}` : ""}`;
    if (platform !== evidence.plan.platform) throw new Error("observed resource platform changed");
    const baseConfigs: string[] = [];
    for (const binding of bindings) {
      const expected = evidence.images.find(i => i.resource === binding.resource); if (!expected) throw new Error("OCI base evidence missing");
      const base = await inspect(expected.configDigest);
      if (canonical(image.RootFS.Layers.slice(0, base.RootFS.Layers.length)) !== canonical(base.RootFS.Layers)) throw new Error("observed image does not descend from declared resource base");
      baseConfigs.push(expected.configDigest);
    }
    observed.push({ consumer, configDigest: container.image_config_digest, platform, baseConfigs });
  }
  if (input.requireObserved) for (const binding of evidence.plan.task.lock.bindings.filter(b => b.use === "environment-image")) if (!observed.some(i => canonical(i.consumer) === canonical(binding.consumer))) throw new Error("successful resource trial lacks observed role/image evidence");
  const lock = taskClosureLock(evidence.plan.task);
  if ("hitch-materialized-task" in lock.resources) throw new Error("reserved materialization resource ID");
  const root = await input.store.pin({ owner: input.owner, generation: 1, purpose: "sealed-run", lock: { ...lock, resources: { ...lock.resources, "hitch-materialized-task": evidence.materializedTree! } } });
  const proofObjects = await exportResourceResultProof(input.store, evidence.plan, root.closure.objectDigests, input.runDirectory);
  await atomicWriteJSON(path.join(input.runDirectory, "resource.execution.json"), { protocol: "hitch-resource-execution@1", plan: evidence.plan, materialized_task_digest: evidence.materialized_task_digest, materializedTree: evidence.materializedTree, images: evidence.images, observed, proofObjects, materialization: { clonedBytes: evidence.clonedBytes, copiedBytes: evidence.copiedBytes, fallbackReasons: evidence.fallbackReasons } });
}
export async function confirmResourceResultSealed(file: string): Promise<void> {
  const evidence = await readResourceEvidence(file); if (evidence) await atomicWriteJSON(file, { ...evidence, resultSealed: true });
}
export async function reclaimResourceExecution(store: ResourceStore, file: string, cleanupConfirmed: boolean): Promise<boolean> {
  const evidence = await readResourceEvidence(file); if (!evidence || !cleanupConfirmed || !evidence.executionEnded || !evidence.resultSealed) return false;
  await finishResourceWorkspace(store, evidence.id, { executionEnded: true, resultSealed: true }); return true;
}
