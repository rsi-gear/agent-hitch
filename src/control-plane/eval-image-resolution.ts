import type { EvalEnvironmentImageBuilder, EvalEnvironmentImageManifestLoader, EvalEnvironmentImageResolver } from "../evals/index.js";
import { DockerBuildKitBuilder, DockerRegistryResolver, EnvironmentImageService, inspectPinnedDockerfileBases, loadEnvironmentImageManifest, resolveRegistryEnvironmentImage } from "../images/index.js";
import type { EnvironmentImageBuilder, RegistryImageResolver } from "../images/index.js";

export function localRegistryImageResolution(root: string, resolver: RegistryImageResolver = new DockerRegistryResolver()): EvalEnvironmentImageResolver {
  return async (input) => {
    const resolved = await resolveRegistryEnvironmentImage({
      root,
      benchmarkId: input.benchmarkId,
      benchmarkRevision: input.benchmarkRevision,
      taskId: input.taskId,
      reference: input.reference,
      platform: input.platform,
      resolver,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      image_id: resolved.manifest.image_id,
      reference: resolved.manifest.output.reference,
      manifest_digest: resolved.manifest.output.manifest_digest,
      platform: resolved.manifest.platform,
      cache_hit: resolved.cacheHit,
    };
  };
}

export function localEnvironmentImageManifestLoader(root: string): EvalEnvironmentImageManifestLoader {
  return (imageId) => loadEnvironmentImageManifest(root, imageId);
}

export function localEnvironmentImageBuild(
  root: string,
  acquireBuildSlot: (signal?: AbortSignal) => Promise<{ release(): void }>,
  builder: EnvironmentImageBuilder = new DockerBuildKitBuilder({ root }),
): EvalEnvironmentImageBuilder {
  const images = new EnvironmentImageService({ root, builder, acquireBuildSlot });
  return async (input) => {
    const baseImages = await inspectPinnedDockerfileBases(input.contextDirectory, input.dockerfile);
    const built = await images.build({
      benchmarkId: input.benchmarkId,
      benchmarkRevision: input.benchmarkRevision,
      taskId: input.taskId,
      contextDirectory: input.contextDirectory,
      dockerfile: input.dockerfile,
      platform: input.platform,
      baseImages,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const requested = built.manifest.output.reference;
    if (!requested || requested.includes("@")) throw new TypeError("local BuildKit image reference is invalid");
    return {
      image_id: built.manifest.image_id,
      requested_reference: requested,
      reference: `${requested}@${built.manifest.output.manifest_digest}`,
      manifest_digest: built.manifest.output.manifest_digest,
      platform: built.manifest.platform,
      cache_hit: built.cacheHit,
    };
  };
}
