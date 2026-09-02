import { randomUUID } from "node:crypto";
import path from "node:path";
import type { EnvironmentBuildRecordV1, EnvironmentImageManifestV1, Sha256 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, ensureDir, readJSON, sha256JSON, statePaths, withFileLock } from "../foundation/index.js";
import { resolveBuildContext } from "./context.js";
import { environmentImageIdentity, parseEnvironmentBuildRecord, parseEnvironmentImageManifest } from "./manifest.js";

export interface EnvironmentImageBuilderOutput {
  reference: string;
  manifest_digest: Sha256;
  config_digest?: Sha256;
  platform: string;
  buildkit_version?: string;
}

export interface EnvironmentImageBuilder {
  readonly id: string;
  probe(reference: string, manifestDigest: Sha256, platform: string, configDigest?: Sha256): Promise<boolean>;
  build(input: {
    contextDirectory: string;
    dockerfile: string;
    platform: string;
    target?: string;
    buildArgs: Readonly<Record<string, string>>;
    secretNames: readonly string[];
    outputReference: string;
    cacheKey: Sha256;
    cacheReference: string;
  }): Promise<EnvironmentImageBuilderOutput>;
}

export interface BuildEnvironmentImageInput {
  benchmarkId: string;
  benchmarkRevision: string;
  taskId?: string;
  sourceKind?: "build-context" | "compose-build";
  contextDirectory: string;
  dockerfile?: string;
  platform: string;
  target?: string;
  frontend?: string;
  buildArgs?: Record<string, string>;
  secretNames?: string[];
  baseImages?: Array<{ reference: string; digest: Sha256 }>;
  signal?: AbortSignal;
}

export interface EnvironmentImageServiceOptions {
  root: string;
  builder: EnvironmentImageBuilder;
  acquireBuildSlot?: (signal?: AbortSignal) => Promise<{ release(): void }>;
  onEvent?: (event: Record<string, unknown>) => void;
}

export class EnvironmentImageService {
  private readonly root: string;
  private readonly builder: EnvironmentImageBuilder;
  private readonly acquireBuildSlot: ((signal?: AbortSignal) => Promise<{ release(): void }>) | undefined;
  private readonly onEvent: (event: Record<string, unknown>) => void;
  private readonly active = new Map<Sha256, Promise<{ manifest: EnvironmentImageManifestV1; cacheHit: boolean }>>();

  constructor({ root, builder, acquireBuildSlot, onEvent = () => {} }: EnvironmentImageServiceOptions) {
    if (!root || !builder.id) throw new TypeError("environment image service identity is invalid");
    this.root = root;
    this.builder = builder;
    this.acquireBuildSlot = acquireBuildSlot;
    this.onEvent = onEvent;
  }

  async build(input: BuildEnvironmentImageInput): Promise<{ manifest: EnvironmentImageManifestV1; cacheHit: boolean }> {
    const resolved = await resolveInput(input);
    const buildId = buildIdentity(resolved.cacheKey);
    this.emit({ type: "build.queued", build_id: buildId, cache_key: resolved.cacheKey, task_id: input.taskId });
    const current = this.active.get(resolved.cacheKey);
    if (current) {
      const waitStartedAt = Date.now();
      return current.then((result) => {
        this.emit({ type: "build.wait", build_id: buildId, cache_key: resolved.cacheKey, duration_ms: Date.now() - waitStartedAt });
        return result;
      });
    }
    const operation = this.buildLocked(resolved, input.signal).finally(() => this.active.delete(resolved.cacheKey));
    this.active.set(resolved.cacheKey, operation);
    return operation;
  }

  private async buildLocked(input: ResolvedInput, signal?: AbortSignal): Promise<{ manifest: EnvironmentImageManifestV1; cacheHit: boolean }> {
    const paths = statePaths(this.root);
    const lockRequestedAt = Date.now();
    return withFileLock(paths.buildLocks, input.cacheKey, async () => {
      const lockWaitMs = Date.now() - lockRequestedAt;
      if (lockWaitMs > 0) this.emit({ type: "build.wait", build_id: buildIdentity(input.cacheKey), cache_key: input.cacheKey, duration_ms: lockWaitMs });
      const cached = await this.cached(input.cacheKey);
      if (cached && await this.builder.probe(cached.output.reference, cached.output.manifest_digest, cached.platform, cached.output.config_digest)) {
        this.emit({ type: "build.cache_hit", build_id: buildIdentity(input.cacheKey), cache_key: input.cacheKey, image_id: cached.image_id });
        return { manifest: cached, cacheHit: true };
      }
      const now = new Date().toISOString();
      const started = Date.now();
      const ownerId = randomUUID();
      const recordBase = {
        schema_version: "1" as const,
        build_id: buildIdentity(input.cacheKey),
        cache_key: input.cacheKey,
        owner_id: ownerId,
        builder_id: this.builder.id,
        started_at: now,
      };
      await this.writeRecord(parseEnvironmentBuildRecord({ ...recordBase, state: "running" }));
      this.emit({ type: "build.started", build_id: recordBase.build_id, cache_key: input.cacheKey });
      let slot: { release(): void } | undefined;
      try {
        slot = await this.acquireBuildSlot?.(signal);
        const output = await this.builder.build({
          contextDirectory: input.context.context_directory,
          dockerfile: input.context.dockerfile,
          platform: input.platform,
          ...(input.target ? { target: input.target } : {}),
          buildArgs: input.buildArgs,
          secretNames: input.secretNames,
          outputReference: input.outputReference,
          cacheKey: input.cacheKey,
          cacheReference: input.cacheReference,
        });
        if (output.platform !== input.platform || !/^sha256:[a-f0-9]{64}$/.test(output.manifest_digest)) throw new HitchError("BuildKit output identity does not match the image plan", { code: "image_output_mismatch", exitCode: 12 });
        const withoutIdentity: Omit<EnvironmentImageManifestV1, "image_id" | "created_at"> = {
          schema_version: "1",
          source: input.source,
          platform: input.platform,
          build: {
            builder: "buildkit",
            ...(output.buildkit_version ? { buildkit_version: output.buildkit_version } : {}),
            builder_id: this.builder.id,
            ...(input.frontend ? { frontend: input.frontend } : {}),
            ...(input.target ? { target: input.target } : {}),
            build_args_sha256: input.buildArgsDigest,
            secret_names: input.secretNames,
            cache_key: input.cacheKey,
          },
          output: {
            reference: output.reference,
            manifest_digest: output.manifest_digest,
            ...(output.config_digest ? { config_digest: output.config_digest } : {}),
          },
          base_images: input.baseImages,
        };
        const manifest = parseEnvironmentImageManifest({ ...withoutIdentity, image_id: environmentImageIdentity(withoutIdentity), created_at: new Date().toISOString() });
        await this.writeManifest(manifest);
        await this.writeRecord(parseEnvironmentBuildRecord({ ...recordBase, state: "succeeded", image_id: manifest.image_id, completed_at: new Date().toISOString() }));
        this.emit({ type: "build.completed", build_id: recordBase.build_id, cache_key: input.cacheKey, image_id: manifest.image_id, duration_ms: Date.now() - started });
        return { manifest, cacheHit: false };
      } catch (error) {
        const code = error instanceof HitchError ? error.code : "image_build_failed";
        await this.writeRecord(parseEnvironmentBuildRecord({
          ...recordBase,
          state: "failed",
          completed_at: new Date().toISOString(),
          error: { code, message: "environment image build failed" },
        }));
        this.emit({ type: "build.failed", build_id: recordBase.build_id, cache_key: input.cacheKey, code, duration_ms: Date.now() - started });
        throw new HitchError("environment image build failed", { code, exitCode: error instanceof HitchError ? error.exitCode : 12, cause: error });
      } finally { slot?.release(); }
    }, { timeoutCode: "image_build_locked", timeoutExitCode: 12, ...(signal ? { signal } : {}) });
  }

  private async cached(cacheKey: Sha256): Promise<EnvironmentImageManifestV1 | null> {
    const record = await readJSON<unknown | null>(environmentBuildRecordPath(this.root, cacheKey), null);
    if (!record) return null;
    const parsed = parseEnvironmentBuildRecord(record);
    if (parsed.state !== "succeeded" || !parsed.image_id) return null;
    const manifest = await readJSON<unknown | null>(environmentImageManifestPath(this.root, parsed.image_id), null);
    return manifest ? parseEnvironmentImageManifest(manifest) : null;
  }

  private async writeManifest(manifest: EnvironmentImageManifestV1): Promise<void> {
    const file = environmentImageManifestPath(this.root, manifest.image_id);
    await ensureDir(path.dirname(file));
    await atomicWriteJSON(file, manifest);
    parseEnvironmentImageManifest(await readJSON(file));
  }

  private async writeRecord(record: EnvironmentBuildRecordV1): Promise<void> {
    const file = environmentBuildRecordPath(this.root, record.cache_key);
    const index = path.join(statePaths(this.root).buildIndexes, `${record.build_id}.json`);
    await ensureDir(path.dirname(file));
    await ensureDir(path.dirname(index));
    const existing = await readJSON<Record<string, unknown> | null>(index, null);
    if (existing && (existing.schema_version !== "1" || existing.build_id !== record.build_id || existing.cache_key !== record.cache_key)) {
      throw new HitchError("environment build id collision", { code: "build_id_collision", exitCode: 12 });
    }
    if (!existing) await atomicWriteJSON(index, { schema_version: "1", build_id: record.build_id, cache_key: record.cache_key });
    await atomicWriteJSON(file, record);
  }

  private emit(event: Record<string, unknown>): void {
    try { this.onEvent(event); } catch { /* Build observers cannot alter image identity. */ }
  }
}

function buildIdentity(cacheKey: Sha256): string {
  return `build_${cacheKey.slice("sha256:".length, "sha256:".length + 32)}`;
}

interface ResolvedInput {
  context: Awaited<ReturnType<typeof resolveBuildContext>>;
  source: EnvironmentImageManifestV1["source"];
  platform: string;
  target?: string;
  frontend?: string;
  buildArgs: Record<string, string>;
  buildArgsDigest: Sha256;
  secretNames: string[];
  baseImages: Array<{ reference: string; digest: Sha256 }>;
  cacheKey: Sha256;
  outputReference: string;
  cacheReference: string;
}

async function resolveInput(input: BuildEnvironmentImageInput): Promise<ResolvedInput> {
  if (!input.benchmarkId || !input.benchmarkRevision || !input.platform) throw new TypeError("environment image request identity is invalid");
  const context = await resolveBuildContext(input.contextDirectory, input.dockerfile);
  const buildArgs = canonicalRecord(input.buildArgs ?? {});
  const secretNames = canonicalNames(input.secretNames ?? []);
  if (secretNames.some((name) => name in buildArgs)) throw new TypeError("secret image inputs cannot also be build args");
  const baseImages = canonicalBaseImages(input.baseImages ?? []);
  const source: EnvironmentImageManifestV1["source"] = {
    kind: input.sourceKind ?? "build-context",
    benchmark_id: input.benchmarkId,
    benchmark_revision: input.benchmarkRevision,
    ...(input.taskId ? { task_id: input.taskId } : {}),
    context_digest: context.context_digest,
    dockerfile_digest: context.dockerfile_digest,
  };
  const buildArgsDigest = sha256JSON(buildArgs);
  const cacheKey = sha256JSON({ source, platform: input.platform, frontend: input.frontend, target: input.target, build_args_sha256: buildArgsDigest, base_images: baseImages, secret_names: secretNames });
  const suffix = cacheKey.slice("sha256:".length, "sha256:".length + 32);
  return {
    context,
    source,
    platform: input.platform,
    ...(input.target ? { target: input.target } : {}),
    ...(input.frontend ? { frontend: input.frontend } : {}),
    buildArgs,
    buildArgsDigest,
    secretNames,
    baseImages,
    cacheKey,
    outputReference: `hitch-environment:${suffix}`,
    cacheReference: `hitch-cache:${sha256JSON({ benchmark_id: input.benchmarkId, task_id: input.taskId ?? null, platform: input.platform }).slice("sha256:".length, "sha256:".length + 32)}`,
  };
}

function canonicalRecord(value: Record<string, string>): Record<string, string> {
  for (const [name, entry] of Object.entries(value)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof entry !== "string") throw new TypeError("environment image build args are invalid");
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
}

function canonicalNames(value: string[]): string[] {
  if (value.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new TypeError("environment image secret names are invalid");
  return [...new Set(value)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function canonicalBaseImages(value: Array<{ reference: string; digest: Sha256 }>): Array<{ reference: string; digest: Sha256 }> {
  for (const entry of value) if (!entry.reference || !/^sha256:[a-f0-9]{64}$/.test(entry.digest)) throw new TypeError("environment image base identity is invalid");
  if (new Set(value.map((entry) => entry.reference)).size !== value.length) throw new TypeError("environment image base references are duplicated");
  return [...value].sort((left, right) => Buffer.compare(Buffer.from(left.reference), Buffer.from(right.reference)));
}

export function environmentImageManifestPath(root: string, imageId: Sha256): string {
  return path.join(statePaths(root).environmentImages, imageId.slice("sha256:".length), "manifest.json");
}

export async function loadEnvironmentImageManifest(root: string, imageId: Sha256): Promise<EnvironmentImageManifestV1> {
  if (!root || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new TypeError("environment image identity is invalid");
  return parseEnvironmentImageManifest(await readJSON(environmentImageManifestPath(root, imageId)));
}

export function environmentBuildRecordPath(root: string, cacheKey: Sha256): string {
  return path.join(statePaths(root).buildRecords, cacheKey.slice("sha256:".length), "record.json");
}
