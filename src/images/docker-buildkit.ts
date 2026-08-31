import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Sha256 } from "../domain/index.js";
import { HitchError, ensureDir, runCommand, statePaths } from "../foundation/index.js";
import type { EnvironmentImageBuilder, EnvironmentImageBuilderOutput } from "./service.js";

export interface DockerBuildKitBuilderOptions {
  root: string;
  dockerExecutable?: string;
  env?: NodeJS.ProcessEnv;
  builderId?: string;
  registryCachePrefix?: string;
}

export class DockerBuildKitBuilder implements EnvironmentImageBuilder {
  readonly id: string;
  private readonly root: string;
  private readonly docker: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly registryCachePrefix: string | undefined;
  private versionPromise: Promise<string> | undefined;

  constructor({ root, dockerExecutable, env = process.env, builderId = "local-docker-buildkit", registryCachePrefix }: DockerBuildKitBuilderOptions) {
    if (!root || !builderId) throw new TypeError("Docker BuildKit builder identity is invalid");
    this.root = root;
    this.docker = dockerExecutable || env.HITCH_DOCKER_PATH || "docker";
    this.env = env;
    this.id = builderId;
    this.registryCachePrefix = registryCachePrefix?.replace(/\/+$/, "") || undefined;
  }

  async probe(reference: string, manifestDigest: Sha256, platform: string, configDigest?: Sha256): Promise<boolean> {
    try {
      const inspected = await this.inspect(reference);
      return inspected.platform === platform && (configDigest ? inspected.configDigest === configDigest : inspected.repoDigests.includes(manifestDigest));
    } catch { return false; }
  }

  async build(input: {
    contextDirectory: string;
    dockerfile: string;
    platform: string;
    target?: string;
    buildArgs: Readonly<Record<string, string>>;
    secretNames: readonly string[];
    outputReference: string;
    cacheKey: Sha256;
    cacheReference: string;
  }): Promise<EnvironmentImageBuilderOutput> {
    const temporary = await mkdtemp(path.join(await ensureDir(statePaths(this.root).temporary), "buildkit-"));
    const metadataFile = path.join(temporary, "metadata.json");
    try {
      const args = ["buildx", "build", "--progress", "plain", "--load", "--metadata-file", metadataFile,
        "--platform", input.platform, "--file", path.join(input.contextDirectory, input.dockerfile), "--tag", input.outputReference];
      if (input.target) args.push("--target", input.target);
      for (const [name, value] of Object.entries(input.buildArgs)) args.push("--build-arg", `${name}=${value}`);
      for (const name of input.secretNames) args.push("--secret", `id=${name},env=${name}`);
      const cacheReference = this.cacheReference(input.cacheKey, input.cacheReference);
      if (cacheReference) args.push("--cache-from", `type=registry,ref=${cacheReference}`, "--cache-to", `type=registry,ref=${cacheReference},mode=max`);
      args.push(input.contextDirectory);
      try {
        await runCommand(this.docker, args, { env: this.env, failureCode: "image_build_failed", failureExitCode: 12 });
      } catch (error) {
        throw new HitchError("BuildKit invocation failed", { code: (error as { code?: string }).code || "image_build_failed", exitCode: 12, cause: error });
      }
      const metadata = await parseMetadata(metadataFile);
      const inspected = await this.inspect(input.outputReference);
      if (inspected.platform !== input.platform) throw new HitchError("built image platform does not match", { code: "image_output_mismatch", exitCode: 12 });
      return {
        reference: input.outputReference,
        manifest_digest: metadata.manifestDigest,
        config_digest: metadata.configDigest ?? inspected.configDigest,
        platform: inspected.platform,
        buildkit_version: await this.version(),
      };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  private async inspect(reference: string): Promise<{ configDigest: Sha256; repoDigests: Sha256[]; platform: string }> {
    const result = await runCommand(this.docker, ["image", "inspect", "--format", "{{json .}}", reference], {
      env: this.env,
      failureCode: "image_unavailable",
      failureExitCode: 12,
      timeoutMs: 30_000,
    });
    let value: unknown;
    try { value = JSON.parse(result.stdout); } catch { throw new TypeError("Docker image inspection is invalid"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Docker image inspection is invalid");
    const image = value as Record<string, unknown>;
    if (!digest(image.Id) || typeof image.Os !== "string" || !image.Os || typeof image.Architecture !== "string" || !image.Architecture) throw new TypeError("Docker image identity is invalid");
    const repoDigests = Array.isArray(image.RepoDigests)
      ? image.RepoDigests.map((entry) => typeof entry === "string" ? entry.slice(entry.lastIndexOf("@") + 1) : "").filter(digest)
      : [];
    const variant = typeof image.Variant === "string" && image.Variant ? `/${image.Variant}` : "";
    return { configDigest: image.Id, repoDigests, platform: `${image.Os}/${image.Architecture}${variant}` };
  }

  private version(): Promise<string> {
    this.versionPromise ??= runCommand(this.docker, ["buildx", "version"], { env: this.env, timeoutMs: 10_000, failureCode: "buildkit_unavailable", failureExitCode: 3 })
      .then((result) => result.stdout.trim().split(/\s+/).slice(0, 3).join(" ") || "unknown")
      .catch((error) => { throw new HitchError("BuildKit version probe failed", { code: "buildkit_unavailable", exitCode: 3, cause: error }); });
    return this.versionPromise;
  }

  private cacheReference(cacheKey: Sha256, fallback: string): string | null {
    if (this.registryCachePrefix) return `${this.registryCachePrefix}/${cacheKey.slice("sha256:".length)}`;
    return fallback.includes("/") ? fallback : null;
  }
}

async function parseMetadata(file: string): Promise<{ manifestDigest: Sha256; configDigest?: Sha256 }> {
  let value: unknown;
  try { value = JSON.parse(await readFile(file, "utf8")); } catch { throw new TypeError("BuildKit metadata is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("BuildKit metadata is invalid");
  const metadata = value as Record<string, unknown>;
  const manifestDigest = metadata["containerimage.digest"];
  const configDigest = metadata["containerimage.config.digest"];
  if (!digest(manifestDigest) || (configDigest !== undefined && !digest(configDigest))) throw new TypeError("BuildKit output digest is invalid");
  return { manifestDigest, ...(configDigest ? { configDigest } : {}) };
}

function digest(value: unknown): value is Sha256 {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}
