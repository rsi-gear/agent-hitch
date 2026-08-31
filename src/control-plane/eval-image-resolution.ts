import type { EvalEnvironmentImageResolver } from "../evals/index.js";
import { DockerRegistryResolver, resolveRegistryEnvironmentImage } from "../images/index.js";
import type { RegistryImageResolver } from "../images/index.js";

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
