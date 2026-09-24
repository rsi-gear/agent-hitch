import { DockerRegistryResolver, resolveRegistryEnvironmentImage, type RegistryImageResolver } from "../images/index.js";
import type { Resource } from "./protocol.js";
import type { ResourceImageProvider } from "./store.js";
import { durableWriteJSON } from "../foundation/index.js";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { exportRegistryBundle, fetchRegistryManifest, verifyRegistryManifest, importRegistryBundle, validateRegistryBundle, isRegistryBundle, type OfflineImageOptions } from "./oci-registry-bundle.js";
import { DEFAULT_IMAGE_IMPORT_BUDGET, type ImageImportBudget } from "./oci-layer-validation.js";
import { DEFAULT_RESOURCE_LIMITS, type ResourceLimits } from "./object-store.js";
import { sha } from "./protocol.js";

/** Transport is deliberately separate from the lock and all task identities. */
export class DockerResourceImageProvider implements ResourceImageProvider {
  readonly protocol = "hitch-oci-provider@1" as const;
  constructor(readonly root: string, readonly transport: Record<string, string>, readonly resolver: RegistryImageResolver = new DockerRegistryResolver({ policy: "cache-first" }), readonly offline: OfflineImageOptions = {}, readonly imagePolicy = "cache-first", readonly budget: ResourceLimits = DEFAULT_RESOURCE_LIMITS) {
    if (resolver instanceof DockerRegistryResolver) this.resolver = resolver.withBeforePull(async (reference, platform, signal) => {
      const resource = { kind: "oci-image" as const, manifestDigest: sha(reference.split("@")[1]), platform };
      const staging = path.join(root, "store", "benchmark-resources", "staging"); await mkdir(staging, { recursive: true });
      const temporary = await mkdtemp(path.join(staging, "oci-validation-")), file = path.join(temporary, "bundle");
      try {
        await exportRegistryBundle(resource, reference, file, { maxBytes: Math.min(budget.maxObjectBytes, budget.maxTotalBytes), minFreeBytes: budget.minFreeBytes }, signal);
        const validated = await validateRegistryBundle(resource, file, signal, { maxExpandedBytes: budget.maxTotalBytes, maxFiles: budget.maxFiles });
        await durableWriteJSON(this.proofFile(resource), { manifest: validated.manifest });
      } finally { await rm(temporary, { recursive: true, force: true }); }
    });
  }
  private proofFile(resource: Extract<Resource, { kind: "oci-image" }>) { return path.join(this.root, "store", "benchmark-resources", "oci-manifests", `${resource.manifestDigest.slice(7)}.json`); }
  async exportArchive(resource: Extract<Resource, { kind: "oci-image" }>, destination: string, signal?: AbortSignal, budget?: { maxBytes: number; minFreeBytes: number }): Promise<void> {
    if (this.offline.exportFormat === "docker-archive") throw new Error("docker-archive cannot preserve verified manifest and expanded-layer budgets; use registry-bundle");
    const image = await this.resolve(resource, signal);
    return exportRegistryBundle(resource, image.reference, destination, budget ?? { maxBytes: 1024 ** 3, minFreeBytes: 64 * 1024 ** 2 }, signal);
  }
  async validateArchive(resource: Extract<Resource, { kind: "oci-image" }>, source: string, signal?: AbortSignal, budget: ImageImportBudget = DEFAULT_IMAGE_IMPORT_BUDGET) {
    if (!await isRegistryBundle(source)) throw new Error("unvalidated Docker archives are unsupported; import a registry-bundle");
    return (await validateRegistryBundle(resource, source, signal, budget)).usage;
  }
  async importArchive(resource: Extract<Resource, { kind: "oci-image" }>, source: string, signal?: AbortSignal, budget: ImageImportBudget = DEFAULT_IMAGE_IMPORT_BUDGET): Promise<void> {
    signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
    const reference = this.transport[resource.manifestDigest]; if (!reference) throw new Error("offline OCI transport missing");
    if (await isRegistryBundle(source)) {
      if (!this.offline.registry) throw new Error("registry bundle import requires an explicitly configured local offline registry");
      const raw = await importRegistryBundle(resource, source, reference, this.offline.registry, signal, budget);
      await durableWriteJSON(this.proofFile(resource), { manifest: raw });
      // Only the explicitly configured loopback registry is contacted here.
      // Normal execution remains cache-only and uses the exact original digest.
      await new DockerRegistryResolver({ policy: "registry" }).resolve(reference, resource.platform, signal);
    } else throw new Error("unvalidated Docker archives are unsupported; import a registry-bundle");
    await new DockerRegistryResolver({ policy: "cache-only" }).resolve(reference, resource.platform, signal);
  }
  async resolve(resource: Extract<Resource, { kind: "oci-image" }>, signal?: AbortSignal) {
    signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
    if (resource.indexDigest) throw new Error("this OCI provider does not support index membership verification; supply a platform manifest without an index lock");
    const reference = this.transport[resource.manifestDigest];
    if (!reference || !reference.endsWith(`@${resource.manifestDigest}`) || /[\s\0]/.test(reference)) throw new Error("immutable OCI resource transport is missing or mismatched");
    const { manifest } = await resolveRegistryEnvironmentImage({ root: this.root, benchmarkId: "benchmark-resource", benchmarkRevision: resource.manifestDigest,
      reference, platform: resource.platform, resolver: this.resolver, ...(signal ? { signal } : {}) });
    if (!manifest.output.config_digest) throw new Error("OCI resource provider must verify the config digest");
    const file = this.proofFile(resource), info = await lstat(file).catch(e => { if (e.code !== "ENOENT") throw e; return undefined; });
    let raw: string;
    if (info) {
      if (!info.isFile() || info.size > 4 * 1024 ** 2) throw new Error("invalid cached OCI manifest proof");
      raw = JSON.parse(await readFile(file, "utf8")).manifest;
    } else {
      if (this.imagePolicy === "cache-only") throw new Error("cache-only OCI manifest proof missing; import a registry bundle or verify the image online first");
      raw = await fetchRegistryManifest(resource, reference, signal);
    }
    verifyRegistryManifest(raw, resource, manifest.output.config_digest);
    if (!info) await durableWriteJSON(file, { manifest: raw });
    return { imageId: manifest.image_id, manifestDigest: manifest.output.manifest_digest, configDigest: manifest.output.config_digest, platform: manifest.platform, reference: manifest.output.reference };
  }
}
