import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { ResourceStore, validateLease, validateRoot, type ResourceLease, type ResourceRoot } from "./store.js";

export async function resourceStorageStats(store: ResourceStore) {
  return store.locked(async () => {
    const scopes: Record<string, { files: number; logicalBytes: number; allocatedBlockBytes: number }> = {};
    for (const scope of ["objects", "oci-manifests", "descriptor-views", "view-quarantine", "quarantine", "workspaces", "staging", "workspace-records", "roots", "leases", "transactions"]) {
      const result = { files: 0, logicalBytes: 0, allocatedBlockBytes: 0 };
      const visit = async (file: string): Promise<void> => {
        const info = await lstat(file).catch(e => { if (e.code !== "ENOENT") throw e; return undefined; }); if (!info) return;
        if (info.isDirectory()) for (const name of await readdir(file)) await visit(path.join(file, name));
        else if (info.isFile()) { result.files++; result.logicalBytes += info.size; result.allocatedBlockBytes += info.blocks * 512; }
        else throw new Error("resource store contains an unsafe entry; accounting stopped");
      };
      await visit(path.join(store.directory, scope)); scopes[scope] = result;
    }
    const roots = await store.records<ResourceRoot>("roots"), leases = await store.records<ResourceLease>("leases"); roots.forEach(validateRoot); leases.forEach(validateLease);
    return { protocol: "hitch-resource-storage@1", scopes, roots: roots.map(r => ({ owner: r.owner, generation: r.generation, state: r.state, purpose: r.purpose })),
      leases: leases.filter(l => l.state !== "released").map(l => ({ id: l.id, owner: l.owner, state: l.state, purpose: l.purpose })),
      physicalAccounting: "allocated blocks may overlap under CoW; no exclusive-byte or saved-byte claim", externalScopes: ["source dataset/projections", "OCI image layers", "BuildKit cache", "sealed run evidence"] };
  });
}
