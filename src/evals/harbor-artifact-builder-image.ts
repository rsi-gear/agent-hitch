import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { HARBOR_NODE_VERSION, HARBOR_NODE_VERSION_WITH_PREFIX, HARBOR_PNPM_VERSION } from "../backends/index.js";
import { HitchError, digest, hitchRootId, runCommand, withFileLock } from "../foundation/index.js";

export const DEFAULT_HARBOR_ARTIFACT_BUILDER_BASE_IMAGE = `node:${HARBOR_NODE_VERSION}-bookworm-slim`;
export const HARBOR_ARTIFACT_BUILDER_RECIPE_VERSION = "1";

export interface HarborBuilderImage {
  reference: string;
  id: string;
  dockerPlatform: string;
  artifactPlatform: string;
}

export async function ensureHarborArtifactBuilderImage(input: {
  root: string;
  cache: { locks: string; temporary: string };
  docker: string;
  dockerPlatform: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<HarborBuilderImage> {
  const base = input.env.HITCH_HARBOR_BUILDER_BASE_IMAGE?.trim() || DEFAULT_HARBOR_ARTIFACT_BUILDER_BASE_IMAGE;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$/.test(base)) {
    throw new HitchError("Harbor artifact builder base image reference is invalid", { code: "invalid_input", exitCode: 2 });
  }
  const imageKey = digest({ base, node: HARBOR_NODE_VERSION, pnpm: HARBOR_PNPM_VERSION, platform: input.dockerPlatform });
  const tag = `hitch-harbor-artifact-builder:${imageKey.slice("sha256:".length, "sha256:".length + 24)}`;
  return withFileLock(input.cache.locks, `builder-image-${imageKey.slice("sha256:".length)}`, async () => {
    const existing = await inspectBuilderImage(input.docker, tag, input.dockerPlatform, input.env, input.signal);
    if (existing) return existing;
    const context = await mkdtemp(path.join(input.cache.temporary, "builder-image-"));
    try {
      const dockerfile = [
        `FROM ${base}`,
        "RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*",
        `RUN npm install --global pnpm@${HARBOR_PNPM_VERSION} && test \"$(node -p process.version)\" = \"${HARBOR_NODE_VERSION_WITH_PREFIX}\" && test \"$(pnpm --version)\" = \"${HARBOR_PNPM_VERSION}\"`,
        `LABEL io.hitch.harbor-artifact-builder.recipe=${JSON.stringify(HARBOR_ARTIFACT_BUILDER_RECIPE_VERSION)}`,
        `LABEL io.hitch.harbor-artifact-builder.node=${JSON.stringify(HARBOR_NODE_VERSION_WITH_PREFIX)}`,
        `LABEL io.hitch.harbor-artifact-builder.pnpm=${JSON.stringify(HARBOR_PNPM_VERSION)}`,
        "ENTRYPOINT []",
        "",
      ].join("\n");
      await writeFile(path.join(context, "Dockerfile"), dockerfile, { mode: 0o600 });
      await runCommand(input.docker, [
        "build", "--platform", input.dockerPlatform, "--tag", tag,
        "--label", `io.hitch.root-id=${hitchRootId(input.root)}`, context,
      ], {
        env: input.env,
        ...(input.signal ? { signal: input.signal } : {}),
        timeoutMs: 30 * 60 * 1_000,
        failureCode: "harbor_artifact_builder_image_failed",
        failureExitCode: 12,
      });
    } finally {
      await rm(context, { recursive: true, force: true });
    }
    const built = await inspectBuilderImage(input.docker, tag, input.dockerPlatform, input.env, input.signal);
    if (!built) {
      throw new HitchError("Harbor artifact builder image failed post-build verification", {
        code: "harbor_artifact_builder_image_failed",
        exitCode: 12,
      });
    }
    return built;
  }, {
    timeoutCode: "harbor_artifact_builder_image_locked",
    timeoutExitCode: 12,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

async function inspectBuilderImage(
  docker: string,
  reference: string,
  expectedPlatform: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<HarborBuilderImage | null> {
  let result;
  try {
    result = await runCommand(docker, ["image", "inspect", "--format", "{{json .}}", reference], {
      env,
      ...(signal ? { signal } : {}),
      timeoutMs: 30_000,
      failureCode: "harbor_artifact_builder_image_unavailable",
      failureExitCode: 12,
    });
  } catch (error) {
    if ((error as { code?: string }).code === "cancelled") throw error;
    return null;
  }
  let image: Record<string, unknown>;
  try { image = JSON.parse(result.stdout) as Record<string, unknown>; } catch { return null; }
  const config = image.Config && typeof image.Config === "object" && !Array.isArray(image.Config) ? image.Config as Record<string, unknown> : {};
  const labels = config.Labels && typeof config.Labels === "object" && !Array.isArray(config.Labels) ? config.Labels as Record<string, unknown> : {};
  const os = typeof image.Os === "string" ? image.Os : "";
  const architecture = image.Architecture === "x86_64" ? "amd64" : image.Architecture === "aarch64" ? "arm64" : image.Architecture;
  const platform = `${os}/${String(architecture || "")}`;
  if (!/^sha256:[0-9a-f]{64}$/.test(String(image.Id || "")) || platform !== expectedPlatform
    || labels["io.hitch.harbor-artifact-builder.recipe"] !== HARBOR_ARTIFACT_BUILDER_RECIPE_VERSION
    || labels["io.hitch.harbor-artifact-builder.node"] !== HARBOR_NODE_VERSION_WITH_PREFIX
    || labels["io.hitch.harbor-artifact-builder.pnpm"] !== HARBOR_PNPM_VERSION) return null;
  return {
    reference,
    id: String(image.Id),
    dockerPlatform: platform,
    artifactPlatform: platform === "linux/amd64" ? "linux-x64" : "linux-arm64",
  };
}
