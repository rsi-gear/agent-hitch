import type { EnvironmentBuildRecordV1, EnvironmentImageManifestV1, Sha256 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/;

export function environmentImageIdentity(value: Omit<EnvironmentImageManifestV1, "image_id" | "created_at">): Sha256 {
  return sha256JSON({
    source: value.source,
    platform: value.platform,
    build: value.build,
    output: {
      manifest_digest: value.output.manifest_digest,
      ...(value.output.config_digest ? { config_digest: value.output.config_digest } : {}),
    },
    base_images: value.base_images,
  });
}

export function parseEnvironmentImageManifest(value: unknown): EnvironmentImageManifestV1 {
  const manifest = exact(value, ["schema_version", "image_id", "source", "platform", "build", "output", "base_images", "created_at"], "environment image manifest");
  if (manifest.schema_version !== "1" || !digest(manifest.image_id) || typeof manifest.platform !== "string" || !manifest.platform
    || typeof manifest.created_at !== "string" || !Number.isFinite(Date.parse(manifest.created_at))) throw new TypeError("environment image manifest identity is invalid");
  const source = exact(manifest.source, ["kind", "benchmark_id", "benchmark_revision"], "environment image source", ["task_id", "context_digest", "dockerfile_digest"]);
  if (!new Set(["registry", "build-context", "compose-build"]).has(String(source.kind))
    || typeof source.benchmark_id !== "string" || !source.benchmark_id
    || typeof source.benchmark_revision !== "string" || !source.benchmark_revision) throw new TypeError("environment image source is invalid");
  for (const name of ["task_id"] as const) if (source[name] !== undefined && (typeof source[name] !== "string" || !source[name])) throw new TypeError(`environment image source ${name} is invalid`);
  for (const name of ["context_digest", "dockerfile_digest"] as const) if (source[name] !== undefined && !digest(source[name])) throw new TypeError(`environment image source ${name} is invalid`);
  if (source.kind !== "registry" && (!digest(source.context_digest) || !digest(source.dockerfile_digest))) throw new TypeError("built image source digests are missing");
  const build = exact(manifest.build, ["builder", "secret_names", "cache_key"], "environment image build", ["buildkit_version", "builder_id", "frontend", "target", "build_args_sha256"]);
  if (build.builder !== "buildkit" || !digest(build.cache_key)) throw new TypeError("environment image build identity is invalid");
  for (const name of ["buildkit_version", "builder_id", "frontend", "target"] as const) if (build[name] !== undefined && (typeof build[name] !== "string" || !build[name])) throw new TypeError(`environment image build ${name} is invalid`);
  if (build.build_args_sha256 !== undefined && !digest(build.build_args_sha256)) throw new TypeError("environment image build args digest is invalid");
  const secretNames = stringSet(build.secret_names, "environment image secret names", /^[A-Za-z_][A-Za-z0-9_]*$/);
  const output = exact(manifest.output, ["reference", "manifest_digest"], "environment image output", ["config_digest"]);
  if (typeof output.reference !== "string" || !output.reference || !digest(output.manifest_digest)
    || (output.config_digest !== undefined && !digest(output.config_digest))) throw new TypeError("environment image output is invalid");
  if (!Array.isArray(manifest.base_images)) throw new TypeError("environment image base images are invalid");
  const baseImages = manifest.base_images.map((entry) => {
    const base = exact(entry, ["reference", "digest"], "environment image base image");
    if (typeof base.reference !== "string" || !base.reference || !digest(base.digest)) throw new TypeError("environment image base image is invalid");
    return { reference: base.reference, digest: base.digest as Sha256 };
  });
  if (!canonical(baseImages.map((entry) => entry.reference)) || new Set(baseImages.map((entry) => entry.reference)).size !== baseImages.length) throw new TypeError("environment image base images are not canonical");
  const parsed = {
    schema_version: "1" as const,
    image_id: manifest.image_id as Sha256,
    source: source as unknown as EnvironmentImageManifestV1["source"],
    platform: manifest.platform,
    build: { ...build, secret_names: secretNames } as unknown as EnvironmentImageManifestV1["build"],
    output: output as unknown as EnvironmentImageManifestV1["output"],
    base_images: baseImages,
    created_at: manifest.created_at,
  };
  const { image_id: _imageId, created_at: _createdAt, ...identity } = parsed;
  if (environmentImageIdentity(identity) !== parsed.image_id) throw new TypeError("environment image id does not match its identity");
  return parsed;
}

export function parseEnvironmentBuildRecord(value: unknown): EnvironmentBuildRecordV1 {
  const record = exact(value, ["schema_version", "build_id", "cache_key", "state", "owner_id", "builder_id", "started_at"], "environment build record", ["completed_at", "image_id", "error"]);
  if (record.schema_version !== "1" || typeof record.build_id !== "string" || !/^build_[a-f0-9]{32}$/.test(record.build_id)
    || !digest(record.cache_key) || !new Set(["running", "succeeded", "failed"]).has(String(record.state))
    || typeof record.owner_id !== "string" || !record.owner_id || typeof record.builder_id !== "string" || !record.builder_id
    || typeof record.started_at !== "string" || !Number.isFinite(Date.parse(record.started_at))) throw new TypeError("environment build record identity is invalid");
  const terminal = record.state === "succeeded" || record.state === "failed";
  if (terminal !== (typeof record.completed_at === "string" && Number.isFinite(Date.parse(record.completed_at)))) throw new TypeError("environment build terminal state is inconsistent");
  if ((record.state === "succeeded") !== digest(record.image_id)) throw new TypeError("environment build image identity is inconsistent");
  const error = record.error;
  if ((record.state === "failed") !== Boolean(error) || (error && (typeof error !== "object" || Array.isArray(error)
    || typeof (error as Record<string, unknown>).code !== "string" || typeof (error as Record<string, unknown>).message !== "string"))) throw new TypeError("environment build failure is inconsistent");
  return record as unknown as EnvironmentBuildRecordV1;
}

function exact(value: unknown, required: string[], label: string, optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (required.some((key) => !(key in record)) || Object.keys(record).some((key) => !required.includes(key) && !optional.includes(key))) throw new TypeError(`${label} fields are invalid`);
  return record;
}

function digest(value: unknown): value is Sha256 {
  return typeof value === "string" && SHA256.test(value);
}

function stringSet(value: unknown, label: string, pattern: RegExp): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !pattern.test(entry)) || !canonical(value)
    || new Set(value).size !== value.length) throw new TypeError(`${label} are invalid`);
  return value;
}

function canonical(values: string[]): boolean {
  return values.every((value, index) => index === 0 || Buffer.compare(Buffer.from(values[index - 1] as string), Buffer.from(value)) < 0);
}
