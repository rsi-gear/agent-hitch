import { roleDirectory, validateRoleContexts } from "./role-context.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { durableWriteJSON as atomicWriteJSON } from "../foundation/index.js";
import { canonical, identity, object, parseStrictJson, type Binding, type Consumer, type Resource } from "./protocol.js";
import { ResourceStore, validateLease, type ResourceLease } from "./store.js";
import { preflightResourceTask, parseResourceTask, taskClosureLock, type ResourcePlan } from "./tasks.js";

export interface WorkspacePolicy { mode?: "auto" | "copy" | "require-clone"; maxCopyBytes?: number; maxWorkspaces?: number }
export interface WorkspaceEvidence {
  protocol: "hitch-resource-workspace@1";
  id: string;
  state: "active" | "sealed" | "removed";
  leaseId: string;
  plan: ResourcePlan;
  taskDirectory: string;
  materialized_task_digest: string;
  materializedTree?: Extract<Resource, { kind: "tree" }>;
  clonedBytes: number;
  copiedBytes: number;
  fallbackReasons: Record<string, number>;
  images: import("./store.js").ResourceClosure["images"];
}

export async function materializeResourceTask(store: ResourceStore, plan: ResourcePlan, input: { owner: string; generation: number; policy?: WorkspacePolicy; signal?: AbortSignal }): Promise<WorkspaceEvidence> {
  const checked = await preflightResourceTask(store, plan.task, { platform: plan.platform, owner: input.owner, generation: input.generation, ...(input.signal ? { signal: input.signal } : {}) });
  if (checked.plan.digest !== plan.digest) throw new Error("resource execution plan changed");
  const { lease } = await store.acquire(input.owner, taskClosureLock(plan.task), "execution", input.signal), id = randomUUID();
  const directory = path.join(store.directory, "workspaces", id), temp = `${directory}.tmp`, taskDirectory = path.join(directory, plan.task.task_id);
  const evidence: WorkspaceEvidence = { protocol: "hitch-resource-workspace@1", id, state: "active", leaseId: lease.id, plan, taskDirectory, materialized_task_digest: "", clonedBytes: 0, copiedBytes: 0, fallbackReasons: {}, images: checked.closure.images };
  try {
    return await store.locked(async () => {
      const mode = input.policy?.mode ?? "auto", maxWorkspaces = input.policy?.maxWorkspaces ?? 4, maxCopy = input.policy?.maxCopyBytes ?? store.objects.budget.maxTotalBytes;
      if (!["auto", "copy", "require-clone"].includes(mode) || !Number.isSafeInteger(maxWorkspaces) || maxWorkspaces < 1 || !Number.isSafeInteger(maxCopy) || maxCopy < 0) throw new TypeError("invalid workspace policy");
      const active = (await store.records<ResourceLease>("leases")).filter(l => { validateLease(l); return l.purpose === "execution" && l.state !== "released"; });
      if (active.length > maxWorkspaces) throw new Error("resource workspace concurrency budget exceeded");
      await mkdir(path.dirname(directory), { recursive: true }); await mkdir(temp, { mode: 0o700 });
      const destination = path.join(temp, plan.task.task_id); await mkdir(destination);
      const file = async (digest: `sha256:${string}`, target: string, size: number, executable: boolean) => {
        input.signal?.throwIfAborted(); await store.objects.verify(digest, size); let clone = false;
        if (mode !== "copy") try { await copyFile(store.objects.objectPath(digest), target, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL); clone = true; }
        catch (error) { const code = (error as NodeJS.ErrnoException).code ?? "unknown"; if (mode === "require-clone" || !["ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"].includes(code)) throw error; evidence.fallbackReasons[code] = (evidence.fallbackReasons[code] ?? 0) + 1; }
        if (clone) evidence.clonedBytes += size;
        else {
          if (evidence.copiedBytes + size > maxCopy) throw new Error("resource workspace copy budget exceeded");
          const space = await statfs(temp, { bigint: true }); if (space.bavail * space.bsize < BigInt(size + store.objects.budget.minFreeBytes)) throw new Error("resource workspace free-space reserve exceeded");
          await copyFile(store.objects.objectPath(digest), target, constants.COPYFILE_EXCL); evidence.copiedBytes += size;
        }
        input.signal?.throwIfAborted(); await store.objects.verify(digest, size, target); await chmod(target, executable ? 0o755 : 0o644);
      };
      const tree = async (resource: Extract<Resource, { kind: "tree" }>, target: string) => {
        const manifest = await store.objects.readTree(resource.manifestDigest);
        for (const entry of manifest.entries) {
          const output = path.join(target, entry.path);
          if (entry.kind === "directory") await mkdir(output, { mode: 0o755 });
          else await file(entry.digest, output, entry.size, entry.executable);
        }
      };
      await tree(plan.task.sourceTree, destination);
      await validateRoleContexts(destination, plan.task.lock.bindings, plan.platform, checked.closure.images);
      for (const binding of plan.task.lock.bindings) {
        if (binding.use === "environment-image") continue;
        const target = path.join(destination, roleDirectory(binding.consumer), binding.target), resource = plan.task.lock.resources[binding.resource]!;
        await mkdir(path.dirname(target), { recursive: true });
        // A source descriptor may not overwrite or shadow a resource binding.
        if (await lstat(target).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return undefined; })) throw new Error("resource target collides with task descriptor");
        if (resource.kind === "tree") { await mkdir(target); await tree(resource, target); }
        else if (resource.kind === "blob" && binding.use === "input-file") await file(resource.digest, target, resource.size, binding.executable);
        else throw new Error("resource binding changed after preflight");
      }
      const roles = new Map(plan.task.lock.bindings.map(b => [canonical(b.consumer), b.consumer]));
      for (const [role, consumer] of roles) {
        const file = path.join(destination, roleDirectory(consumer), "Dockerfile"), text = await readFile(file, "utf8");
        const transported = text.replace(/^(FROM\s+)(\S+)(.*)$/gim, (_all, prefix: string, ref: string, suffix: string) => {
          const image = checked.closure.images.find(i => ref.endsWith(`@${i.manifestDigest}`)); if (!image) throw new Error("unresolved OCI build base");
          return `${prefix}${image.reference}${suffix}`;
        });
        await writeFile(file, transported); await appendFile(file, `\nLABEL dev.hitch.resource.plan=${JSON.stringify(plan.digest)} dev.hitch.resource.consumer=${JSON.stringify(role)}\n`);
      }
      // Import the actual output as an identity proof while holding the same lock.
      // Its independent evidence lease keeps it reproducible until result sealing.
      const staging = path.join(temp, "proof"); await mkdir(staging);
      const actual = await store.objects.importTree(destination, staging, d => store.protect(lease, d), input.signal);
      evidence.materializedTree = actual.resource;
      evidence.materialized_task_digest = identity("hitch-materialized-task@1", actual.resource);
      await rm(staging, { recursive: true }); input.signal?.throwIfAborted();
      await rename(temp, directory); await atomicWriteJSON(path.join(store.directory, "workspace-records", `${id}.json`), evidence);
      return evidence;
    }, input.signal);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    // If published, retain the workspace and execution lease for explicit recovery.
    if (!await lstat(directory).catch(() => undefined)) await store.finishLease(lease.id, "ended");
    throw error;
  }
}
export async function finishResourceWorkspace(store: ResourceStore, id: string, confirmation: { executionEnded: true; resultSealed: true }): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(id) || confirmation.executionEnded !== true || confirmation.resultSealed !== true) throw new TypeError("workspace cleanup requires execution end and result sealing confirmation");
  await store.locked(async () => {
    const file = path.join(store.directory, "workspace-records", `${id}.json`), record = parseStrictJson(await readFile(file, "utf8")) as WorkspaceEvidence;
    parseResourceTask(record.plan.task);
    if (record.protocol !== "hitch-resource-workspace@1" || record.id !== id || record.taskDirectory !== path.join(store.directory, "workspaces", id, record.plan.task.task_id)) throw new TypeError("workspace ownership record mismatch");
    record.state = "sealed"; await atomicWriteJSON(file, record);
    await rm(path.join(store.directory, "workspaces", id), { recursive: true, force: true });
    const lease = await store.readRecord<ResourceLease>("leases", record.leaseId); if (!lease) throw new Error("workspace lease missing"); validateLease(lease); await store.finishLeaseLocked(lease);
    record.state = "removed"; await atomicWriteJSON(file, record);
  });
}
