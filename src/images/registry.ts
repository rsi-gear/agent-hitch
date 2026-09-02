import { lstat } from "node:fs/promises";
import path from "node:path";
import type { EnvironmentImageManifestV1, Sha256 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, ensureDir, readJSON, runCommand, sha256JSON } from "../foundation/index.js";
import { environmentImageIdentity, parseEnvironmentImageManifest } from "./manifest.js";
import { environmentImageManifestPath } from "./service.js";

export interface RegistryImageResolution {
  reference: string;
  manifest_digest: Sha256;
  config_digest?: Sha256;
  platform: string;
}

export interface RegistryImageResolver {
  readonly id: string;
  resolve(reference: string, platform: string, signal?: AbortSignal): Promise<RegistryImageResolution>;
}

export async function resolveRegistryEnvironmentImage(input: {
  root: string;
  benchmarkId: string;
  benchmarkRevision: string;
  taskId?: string;
  reference: string;
  platform: string;
  resolver: RegistryImageResolver;
  secretNames?: string[];
  signal?: AbortSignal;
}): Promise<{ manifest: EnvironmentImageManifestV1; cacheHit: boolean }> {
  if (!input.root || !input.benchmarkId || !input.benchmarkRevision || !validReference(input.reference) || !input.platform || !input.resolver.id) {
    throw new TypeError("registry image request identity is invalid");
  }
  const secretNames = canonicalNames(input.secretNames ?? []);
  const resolved = await input.resolver.resolve(input.reference, input.platform, input.signal);
  if (resolved.platform !== input.platform || !digest(resolved.manifest_digest) || (resolved.config_digest !== undefined && !digest(resolved.config_digest))
    || !validReference(resolved.reference) || repositoryOf(resolved.reference) !== repositoryOf(input.reference)
    || !resolved.reference.endsWith(`@${resolved.manifest_digest}`)) {
    throw new HitchError("registry image identity does not match the request", { code: "image_output_mismatch", exitCode: 12 });
  }
  const requestedDigest = input.reference.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
  if (requestedDigest && requestedDigest !== resolved.manifest_digest) throw new HitchError("registry digest resolution changed an immutable reference", { code: "image_digest_mismatch", exitCode: 12 });
  const cacheKey = sha256JSON({ kind: "registry", requested_reference: input.reference, manifest_digest: resolved.manifest_digest, platform: input.platform });
  const withoutIdentity: Omit<EnvironmentImageManifestV1, "image_id" | "created_at"> = {
    schema_version: "1",
    source: {
      kind: "registry",
      benchmark_id: input.benchmarkId,
      benchmark_revision: input.benchmarkRevision,
      ...(input.taskId ? { task_id: input.taskId } : {}),
    },
    platform: input.platform,
    build: {
      builder: "buildkit",
      builder_id: input.resolver.id,
      frontend: "registry-resolution",
      secret_names: secretNames,
      cache_key: cacheKey,
    },
    output: {
      reference: resolved.reference,
      manifest_digest: resolved.manifest_digest,
      ...(resolved.config_digest ? { config_digest: resolved.config_digest } : {}),
    },
    base_images: [],
  };
  const manifest = parseEnvironmentImageManifest({
    ...withoutIdentity,
    image_id: environmentImageIdentity(withoutIdentity),
    created_at: new Date().toISOString(),
  });
  const file = environmentImageManifestPath(input.root, manifest.image_id);
  const cacheHit = await regularFile(file);
  if (cacheHit) {
    const persisted = parseEnvironmentImageManifest(await readJSON(file));
    if (persisted.image_id !== manifest.image_id || persisted.output.manifest_digest !== manifest.output.manifest_digest) throw new TypeError("registry image cache identity changed");
    return { manifest: persisted, cacheHit: true };
  }
  await ensureDir(path.dirname(file));
  await atomicWriteJSON(file, manifest);
  return { manifest: parseEnvironmentImageManifest(await readJSON(file)), cacheHit: false };
}

export interface DockerRegistryResolverOptions {
  dockerExecutable?: string;
  env?: NodeJS.ProcessEnv;
  id?: string;
}

export class DockerRegistryResolver implements RegistryImageResolver {
  readonly id: string;
  private readonly docker: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor({ dockerExecutable, env = process.env, id = "local-docker-registry" }: DockerRegistryResolverOptions = {}) {
    if (!id) throw new TypeError("Docker registry resolver id is invalid");
    this.id = id;
    this.docker = dockerExecutable || env.HITCH_DOCKER_PATH || "docker";
    this.env = env;
  }

  async resolve(reference: string, platform: string, signal?: AbortSignal): Promise<RegistryImageResolution> {
    if (!validReference(reference) || !platform) throw new TypeError("Docker registry image request is invalid");
    try {
      await runCommand(this.docker, ["pull", "--platform", platform, reference], {
        env: this.env,
        failureCode: "image_registry_unavailable",
        failureExitCode: 3,
        ...(signal ? { signal } : {}),
      });
      const result = await runCommand(this.docker, ["image", "inspect", "--format", "{{json .}}", reference], {
        env: this.env,
        failureCode: "image_unavailable",
        failureExitCode: 12,
        timeoutMs: 30_000,
        ...(signal ? { signal } : {}),
      });
      return parseDockerInspection(reference, platform, result.stdout);
    } catch (error) {
      if ((error as { code?: string }).code === "cancelled") throw error;
      throw new HitchError("registry image resolution failed", { code: (error as { code?: string }).code || "image_registry_unavailable", exitCode: 12, cause: error });
    }
  }
}

function parseDockerInspection(requested: string, platform: string, stdout: string): RegistryImageResolution {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new TypeError("Docker registry inspection is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Docker registry inspection is invalid");
  const image = value as Record<string, unknown>;
  if (!digest(image.Id) || typeof image.Os !== "string" || typeof image.Architecture !== "string" || !Array.isArray(image.RepoDigests)) throw new TypeError("Docker registry image identity is invalid");
  const actualPlatform = `${image.Os}/${image.Architecture}${typeof image.Variant === "string" && image.Variant ? `/${image.Variant}` : ""}`;
  if (actualPlatform !== platform) throw new HitchError("registry image platform does not match", { code: "image_platform_mismatch", exitCode: 12 });
  const candidates = image.RepoDigests.filter((entry): entry is string => typeof entry === "string" && /@sha256:[a-f0-9]{64}$/.test(entry));
  const requestedDigest = requested.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
  const repository = repositoryOf(requested);
  const selected = candidates.find((entry) => entry === `${repository}@${requestedDigest}`)
    ?? candidates.find((entry) => entry.startsWith(`${repository}@`))
    ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!selected) throw new TypeError("Docker registry manifest digest is unavailable");
  const manifestDigest = selected.slice(selected.lastIndexOf("@") + 1) as Sha256;
  if (requestedDigest && manifestDigest !== requestedDigest) throw new HitchError("Docker registry digest does not match", { code: "image_digest_mismatch", exitCode: 12 });
  return { reference: `${repository}@${manifestDigest}`, manifest_digest: manifestDigest, config_digest: image.Id, platform: actualPlatform };
}

function repositoryOf(reference: string): string {
  const withoutDigest = reference.split("@")[0] as string;
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

function validReference(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 && !/[\s\0]/.test(value) && !value.includes("://");
}

function digest(value: unknown): value is Sha256 {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function canonicalNames(value: string[]): string[] {
  if (value.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new TypeError("registry secret names are invalid");
  return [...new Set(value)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

async function regularFile(file: string): Promise<boolean> {
  try { return (await lstat(file)).isFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
