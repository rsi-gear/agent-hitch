import type {
  InferenceLockV1,
  InferenceRuntimeManifestV1,
  InferenceServiceRecordV1,
  LocalModelFileV1,
  LocalModelManifestV1,
  Sha256,
} from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function localModelIdentity(value: Omit<LocalModelManifestV1, "model_id" | "created_at" | "source">): Sha256 {
  return sha256JSON({
    format: value.format,
    files: value.files,
    architecture: value.architecture,
    model_type: value.model_type,
    dtype: value.dtype,
    quantization: value.quantization,
    context_tokens: value.context_tokens,
    tokenizer_digest: value.tokenizer_digest,
    template_digest: value.template_digest,
  });
}

export function inferenceRuntimeIdentity(value: Omit<InferenceRuntimeManifestV1, "runtime_id">): Sha256 {
  return sha256JSON(value);
}

export function inferenceLockIdentity(value: Omit<InferenceLockV1, "inference_id">): Sha256 {
  return sha256JSON(value);
}

export function parseLocalModelManifest(value: unknown): LocalModelManifestV1 {
  const record = exact(value, [
    "schema_version", "model_id", "format", "files", "architecture", "model_type", "dtype",
    "quantization", "context_tokens", "tokenizer_digest", "template_digest", "source", "created_at",
  ], "local model manifest");
  if (record.schema_version !== "1" || record.format !== "hf-safetensors") fail("unsupported local model manifest");
  const files = array(record.files, "model files").map(parseModelFile);
  if (files.length === 0 || files.some((file, index) => index > 0 && files[index - 1]!.path >= file.path)) {
    fail("model files must be non-empty and strictly sorted");
  }
  const source = exact(record.source, ["kind", "label", "license"], "model source");
  if (source.kind !== "local-directory") fail("model source kind is invalid");
  const manifest: LocalModelManifestV1 = {
    schema_version: "1",
    model_id: digest(record.model_id, "model_id"),
    format: "hf-safetensors",
    files,
    architecture: text(record.architecture, "architecture"),
    model_type: text(record.model_type, "model_type"),
    dtype: text(record.dtype, "dtype"),
    quantization: nullableText(record.quantization, "quantization"),
    context_tokens: nullablePositiveInteger(record.context_tokens, "context_tokens"),
    tokenizer_digest: digest(record.tokenizer_digest, "tokenizer_digest"),
    template_digest: nullableDigest(record.template_digest, "template_digest"),
    source: {
      kind: "local-directory",
      label: text(source.label, "source label"),
      license: nullableText(source.license, "source license"),
    },
    created_at: timestamp(record.created_at, "created_at"),
  };
  const expected = localModelIdentity(manifest);
  if (manifest.model_id !== expected) fail("local model manifest identity mismatch");
  return manifest;
}

export function parseInferenceRuntimeManifest(value: unknown): InferenceRuntimeManifestV1 {
  const record = exact(value, [
    "schema_version", "runtime_id", "engine", "sglang_version", "sglang_commit", "backend", "package", "compatibility_profile",
  ], "inference runtime manifest");
  if (record.schema_version !== "1" || record.engine !== "sglang") fail("unsupported inference runtime manifest");
  if (record.backend !== "cpu" && record.backend !== "cuda" && record.backend !== "metal") fail("inference runtime backend is invalid");
  const packageRecord = exact(record.package,
    record.backend === "metal"
      ? ["kind", "environment_digest", "python_version", "packages_digest"]
      : ["kind", "image", "image_digest", "platform"],
    "inference runtime package");
  const runtimePackage = record.backend === "metal"
    ? {
      kind: "python-env" as const,
      environment_digest: digest(packageRecord.environment_digest, "environment_digest"),
      python_version: text(packageRecord.python_version, "python_version"),
      packages_digest: digest(packageRecord.packages_digest, "packages_digest"),
    }
    : {
      kind: "oci" as const,
      image: text(packageRecord.image, "runtime image"),
      image_digest: digest(packageRecord.image_digest, "image_digest"),
      platform: literal(packageRecord.platform, "linux/amd64", "runtime platform"),
    };
  if ((record.backend === "metal") !== (runtimePackage.kind === "python-env")) fail("runtime package does not match backend");
  const manifest: InferenceRuntimeManifestV1 = {
    schema_version: "1",
    runtime_id: digest(record.runtime_id, "runtime_id"),
    engine: "sglang",
    sglang_version: text(record.sglang_version, "sglang_version"),
    sglang_commit: text(record.sglang_commit, "sglang_commit"),
    backend: record.backend,
    package: runtimePackage,
    compatibility_profile: text(record.compatibility_profile, "compatibility_profile"),
  };
  const { runtime_id: _runtimeId, ...identity } = manifest;
  if (manifest.runtime_id !== inferenceRuntimeIdentity(identity)) {
    fail("inference runtime manifest identity mismatch");
  }
  return manifest;
}

export function parseInferenceServiceRecord(value: unknown): InferenceServiceRecordV1 {
  const record = exact(value, [
    "schema_version", "service_id", "inference_id", "isolation_key", "state", "epoch", "owner_id",
    "lease_owner_ids", "backend", "container_id", "pid", "base_url", "started_at", "updated_at", "error",
  ], "inference service record");
  if (record.schema_version !== "1" || typeof record.service_id !== "string" || !/^inference_[a-f0-9]{32}$/.test(record.service_id)) {
    fail("inference service identity is invalid");
  }
  if (!new Set(["starting", "ready", "draining", "stopped", "failed"]).has(String(record.state))) fail("inference service state is invalid");
  if (record.backend !== "cpu" && record.backend !== "cuda" && record.backend !== "metal") fail("inference service backend is invalid");
  if (!Number.isSafeInteger(record.epoch) || (record.epoch as number) < 1) fail("inference service epoch is invalid");
  const owners = array(record.lease_owner_ids, "inference lease owners").map((owner) => text(owner, "inference lease owner"));
  if (new Set(owners).size !== owners.length) fail("inference lease owners must be unique");
  if (record.container_id !== undefined && (typeof record.container_id !== "string" || !/^[a-f0-9]{12,64}$/.test(record.container_id))) {
    fail("inference container identity is invalid");
  }
  if (record.pid !== undefined && (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1)) fail("inference process identity is invalid");
  if (record.base_url !== undefined) {
    let url: URL;
    try { url = new URL(text(record.base_url, "inference base URL")); } catch { fail("inference base URL is invalid"); }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash) {
      fail("inference base URL must be loopback HTTP");
    }
  }
  let error: InferenceServiceRecordV1["error"];
  if (record.error !== undefined) {
    const parsed = exact(record.error, ["code", "message"], "inference service error");
    error = { code: text(parsed.code, "inference error code"), message: text(parsed.message, "inference error message") };
  }
  return {
    schema_version: "1",
    service_id: record.service_id,
    inference_id: digest(record.inference_id, "inference_id"),
    isolation_key: digest(record.isolation_key, "isolation_key"),
    state: record.state as InferenceServiceRecordV1["state"],
    epoch: record.epoch as number,
    owner_id: text(record.owner_id, "inference owner"),
    lease_owner_ids: owners,
    backend: record.backend,
    ...(record.container_id === undefined ? {} : { container_id: record.container_id }),
    ...(record.pid === undefined ? {} : { pid: record.pid as number }),
    ...(record.base_url === undefined ? {} : { base_url: record.base_url as string }),
    started_at: timestamp(record.started_at, "inference started_at"),
    updated_at: timestamp(record.updated_at, "inference updated_at"),
    ...(error ? { error } : {}),
  };
}

function parseModelFile(value: unknown): LocalModelFileV1 {
  const record = exact(value, ["path", "size", "sha256"], "model file");
  const relative = text(record.path, "model file path");
  if (relative.startsWith("/") || relative.includes("\\")
    || relative.split("/").some((part) => !part || part === "." || part === "..")) fail("model file path is unsafe");
  if (!Number.isSafeInteger(record.size) || (record.size as number) < 0) fail("model file size is invalid");
  return { path: relative, size: record.size as number, sha256: digest(record.sha256, "model file digest") };
}

function exact(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const allowed = new Set(fields);
  const unknown = Object.keys(record).find((field) => !allowed.has(field));
  if (unknown) fail(`${label} has unknown field: ${unknown}`);
  return record;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  return text(value, label);
}

function digest(value: unknown, label: string): Sha256 {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(`${label} must be a SHA-256 digest`);
  return value as Sha256;
}

function nullableDigest(value: unknown, label: string): Sha256 | null {
  return value === null ? null : digest(value, label);
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(`${label} must be a positive integer or null`);
  return value as number;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label);
  if (!Number.isFinite(Date.parse(result))) fail(`${label} must be an ISO timestamp`);
  return result;
}

function literal<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) fail(`${label} must be ${expected}`);
  return expected;
}

function fail(message: string): never {
  throw new TypeError(message);
}
