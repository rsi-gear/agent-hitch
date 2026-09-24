import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DockerRegistryResolver } from "../images/index.js";
import { durableWriteJSON as atomicWriteJSON } from "../foundation/index.js";
import { auditResources } from "./gc.js";
import { materializeResourceTask, finishResourceWorkspace, type WorkspacePolicy } from "./materialize.js";
import { DockerResourceImageProvider } from "./oci-provider.js";
import { localRegistry, type OfflineImageOptions } from "./oci-registry-bundle.js";
import { identity, object, parseStrictJson, resourceId, type Resource } from "./protocol.js";
import { limits, type ResourceLimits } from "./object-store.js";
import { ResourceStore } from "./store.js";
import { exportResourceBundle, importResourceBundle } from "./bundle.js";
import { resourceStorageStats } from "./stats.js";
import { parseResourceDataset, preflightResourceTask, readResourceInput, sealResourceTask, selectResources, RESOURCE_EXECUTION_CAPABILITIES, type ResourcePlan } from "./tasks.js";

export interface ResourceHostConfig {
  protocol: "hitch-resource-host@1";
  transport: Record<string, string>;
  imagePolicy: "registry" | "cache-first" | "cache-only";
  platform: string;
  workspace: WorkspacePolicy;
  limits?: Partial<ResourceLimits>;
  offline?: OfflineImageOptions;
}
export async function configuredResourceStore(root: string): Promise<{ store: ResourceStore; config: ResourceHostConfig }> {
  let config: ResourceHostConfig = { protocol: "hitch-resource-host@1", transport: {}, imagePolicy: "cache-first", platform: "linux/amd64", workspace: {} };
  try { config = parseHostConfig(parseStrictJson(await readFile(path.join(root, "resource-config.json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { store: new ResourceStore(root, { ...(config.limits ? { limits: config.limits } : {}), images: new DockerResourceImageProvider(root, config.transport, new DockerRegistryResolver({ policy: config.imagePolicy }), config.offline, config.imagePolicy, limits(config.limits)) }), config };
}
export interface ResourcePreflight { protocol: "hitch-resource-preflight@1"; inputDigest: string; plans: ResourcePlan[]; planDigest: string }
export async function preflightResourceInput(store: ResourceStore, ref: string, options: { owner: string; generation: number; platform: string; signal?: AbortSignal }): Promise<ResourcePreflight | undefined> {
  return store.admission(() => preflightInput(store, ref, options));
}
async function preflightInput(store: ResourceStore, ref: string, options: { owner: string; generation: number; platform: string; signal?: AbortSignal }): Promise<ResourcePreflight | undefined> {
  const source = await readResourceInput(ref); if (!source) return undefined;
  const execution = "schema_version" in source ? source.execution : source.manifest.execution;
  if (execution.platform !== options.platform) throw new Error("resource execution platform differs from the frozen plan");
  const capabilities = "schema_version" in source ? source.required_capabilities : source.manifest.required_capabilities;
  for (const c of capabilities) if (!RESOURCE_EXECUTION_CAPABILITIES.includes(c)) throw new Error(`unsupported required resource capability: ${c}`);
  const isDirectory = (await lstat(ref)).isDirectory(), plans: ResourcePlan[] = [];
  for (const task of source.tasks) {
    if (isDirectory) {
      const actual = await store.import(path.join(ref, task.task_id), "tree", `${options.owner}:source-check`, options.signal);
      await store.finishLease(actual.leaseId, "ended");
      if (identity("hitch-source-task@1", actual.resource) !== task.source_task_digest) throw new Error("local task descriptor changed since sealing");
    }
    plans.push((await preflightResourceTask(store, task, { ...options, owner: `${options.owner}:${task.task_id}` })).plan);
  }
  const inputDigest = "schema_version" in source ? source.dataset_digest : source.digest;
  return { protocol: "hitch-resource-preflight@1", inputDigest, plans, planDigest: identity("hitch-resource-preflight@1", { inputDigest, plans: plans.map(p => ({ taskId: p.task.task_id, digest: p.digest })) }) };
}
export async function resourceRequest(root: string, operation: string, value: unknown): Promise<unknown> {
  if (operation === "capabilities") return { protocol: "hitch-resources-api@1", capabilities: RESOURCE_EXECUTION_CAPABILITIES, selections: "hitch-resource-selection@1" };
  if (operation === "configure") { const config = parseHostConfig(value); await atomicWriteJSON(path.join(root, "resource-config.json"), config); return config; }
  const { store, config } = await configuredResourceStore(root);
  switch (operation) {
    case "inspect": { object(value, []); return resourceStorageStats(store); }
    case "import": {
      const input = object(value, ["source", "kind", "owner"]);
      if (typeof input.source !== "string" || typeof input.owner !== "string" || input.kind !== "blob" && input.kind !== "tree") throw new TypeError("invalid resource import request");
      return store.import(path.resolve(input.source), input.kind, input.owner);
    }
    case "pin": { const input = object(value, ["owner", "generation", "purpose", "lock"]); return store.pin(input as unknown as Parameters<ResourceStore["pin"]>[0]); }
    case "release": { const input = object(value, ["owner", "generation"]); await store.release(input.owner as string, input.generation as number); return { released: true }; }
    case "lease-end": {
      const input = object(value, ["leaseId", "confirmation"]); if (typeof input.leaseId !== "string" || !["ended", "unknown"].includes(String(input.confirmation))) throw new TypeError("invalid lease confirmation");
      await store.finishLease(input.leaseId, input.confirmation as "ended" | "unknown"); return { acknowledged: true };
    }
    case "audit": { const input = object(value, ["apply", "graceMs"]); if (input.apply !== undefined && typeof input.apply !== "boolean") throw new TypeError("apply must be explicit boolean"); return auditResources(store, input as Parameters<typeof auditResources>[1]); }
    case "bundle-export": {
      const input = object(value, ["ref", "output", "owner"]);
      if (typeof input.ref !== "string" || typeof input.output !== "string" || typeof input.owner !== "string") throw new TypeError("invalid bundle export request");
      const source = await readResourceInput(input.ref); if (!source) throw new Error("resource input required");
      const selection = "schema_version" in source ? selectResources(source, source.tasks.map(t => t.task_id)) : source;
      return exportResourceBundle(store, selection, input.output, input.owner);
    }
    case "bundle-import": {
      const input = object(value, ["directory", "owner", "output"]);
      if (typeof input.directory !== "string" || typeof input.owner !== "string" || typeof input.output !== "string") throw new TypeError("invalid bundle import request");
      if (config.imagePolicy !== "cache-only") throw new Error("offline bundle import requires cache-only image policy");
      const result = await importResourceBundle(store, input.directory, input.owner);
      await writeFile(input.output, JSON.stringify(result.selection), { flag: "wx", mode: 0o600 }); return result;
    }
    case "seal-dataset": {
      const input = object(value, ["directory", "owner", "manifest", "taskIds"]);
      if (typeof input.directory !== "string" || typeof input.owner !== "string" || !Array.isArray(input.taskIds) || input.taskIds.some(id => typeof id !== "string")) throw new TypeError("invalid dataset seal request");
      const directory = input.directory, owner = input.owner, taskIds = input.taskIds as string[];
      return store.admission(async () => {
      const metadata = object(input.manifest, ["benchmark", "adapter", "scoring", "raw_metrics", "required_capabilities", "execution"]);
      const tasks: Awaited<ReturnType<typeof sealResourceTask>>[] = [];
      for (const id of [...taskIds].sort()) { resourceId(id); tasks.push(await sealResourceTask(store, path.join(directory, id), id, `${owner}:${id}`)); }
      const body = { schema_version: "2", kind: "gear-harbor-benchmark", resource_protocol: "hitch-resource-lock@1", ...metadata, tasks };
      const manifest = parseResourceDataset({ ...body, dataset_digest: identity("hitch-resource-dataset@2", body) });
      if (manifest.execution.platform !== config.platform) throw new Error("resource execution platform differs from host");
      for (const capability of manifest.required_capabilities) if (!RESOURCE_EXECUTION_CAPABILITIES.includes(capability)) throw new Error(`unsupported required resource capability: ${capability}`);
      for (const task of tasks) await preflightResourceTask(store, task, { owner: `${owner}:admission:${task.task_id}`, generation: 1, platform: config.platform });
      await writeFile(path.join(directory, "benchmark.adapter.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return manifest;
      });
    }
    case "seal-task": {
      const input = object(value, ["directory", "taskId", "owner"]);
      if ([input.directory, input.taskId, input.owner].some(v => typeof v !== "string")) throw new TypeError("invalid task seal request");
      return sealResourceTask(store, input.directory as string, input.taskId as string, input.owner as string);
    }
    case "preflight": {
      const input = object(value, ["ref", "owner", "generation", "platform"]);
      if (typeof input.ref !== "string" || typeof input.owner !== "string") throw new TypeError("invalid preflight request");
      return preflightResourceInput(store, input.ref, { owner: input.owner, generation: input.generation as number, platform: input.platform as string ?? config.platform });
    }
    case "selection": {
      const input = object(value, ["manifest", "taskIds", "output"]), selection = selectResources(parseResourceDataset(input.manifest), input.taskIds as string[]);
      if (input.output !== undefined) { if (typeof input.output !== "string") throw new TypeError("invalid selection output"); await writeFile(input.output, `${JSON.stringify(selection)}\n`, { flag: "wx" }); }
      return selection;
    }
    case "materialize": {
      const input = object(value, ["plan", "owner", "generation"]);
      return materializeResourceTask(store, input.plan as ResourcePlan, { owner: input.owner as string, generation: input.generation as number, policy: config.workspace });
    }
    case "workspace-end": {
      const input = object(value, ["id", "executionEnded", "resultSealed"]);
      await finishResourceWorkspace(store, input.id as string, input as unknown as { executionEnded: true; resultSealed: true }); return { removed: true };
    }
    default: throw new TypeError(`unsupported resource API operation: ${operation}`);
  }
}
export async function resourceFileRequest(root: string, operation: string, file: string): Promise<unknown> {
  if ((await lstat(file)).size > 16 * 1024 ** 2) throw new Error("resource request size limit exceeded");
  return resourceRequest(root, operation, parseStrictJson(await readFile(file, "utf8")));
}
function parseHostConfig(value: unknown): ResourceHostConfig {
  const raw = object(value, ["protocol", "transport", "imagePolicy", "platform", "workspace", "limits", "offline"]);
  if (raw.protocol !== "hitch-resource-host@1" || !["registry", "cache-first", "cache-only"].includes(String(raw.imagePolicy)) || typeof raw.platform !== "string" || !/^linux\/(amd64|arm64)(\/v[0-9]+)?$/.test(raw.platform)) throw new TypeError("invalid resource host configuration");
  if (!raw.transport || typeof raw.transport !== "object" || Array.isArray(raw.transport)) throw new TypeError("resource transport must be a map");
  for (const [key, ref] of Object.entries(raw.transport)) if (!/^sha256:[a-f0-9]{64}$/.test(key) || typeof ref !== "string" || !ref.endsWith(`@${key}`) || /[\s\0]/.test(ref)) throw new TypeError("invalid immutable image transport");
  if (raw.limits !== undefined) limits(raw.limits as Partial<ResourceLimits>);
  if (raw.offline !== undefined) {
    const offline = object(raw.offline, ["exportFormat", "registry"]);
    if (offline.exportFormat !== undefined && !["docker-archive", "registry-bundle"].includes(String(offline.exportFormat))) throw new Error("invalid offline image format");
    if (offline.registry !== undefined) { if (typeof offline.registry !== "string") throw new Error("invalid offline registry"); localRegistry(offline.registry); }
  }
  const policy = object(raw.workspace, ["mode", "maxCopyBytes", "maxWorkspaces"]);
  if (policy.mode !== undefined && !["auto", "copy", "require-clone"].includes(String(policy.mode))) throw new TypeError("invalid workspace mode");
  for (const key of ["maxCopyBytes", "maxWorkspaces"]) if (policy[key] !== undefined && (!Number.isSafeInteger(policy[key]) || (policy[key] as number) < (key === "maxWorkspaces" ? 1 : 0))) throw new TypeError("invalid workspace budget");
  return raw as unknown as ResourceHostConfig;
}
