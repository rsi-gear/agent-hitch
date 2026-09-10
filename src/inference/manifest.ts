import type {
  InferenceLockV1,
  InferenceRuntimeManifestV1,
  InferenceServiceRecordV1,
  InferenceServiceHandleV2,
  LocalModelFileV1,
  LocalModelManifestV1,
  Sha256,
} from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";

import { parseModelNodeBinding } from "../domain/index.js";
export { parseModelNodeBinding } from "../domain/index.js";

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
  if ((record.schema_version !== "1" && record.schema_version !== "2") || record.engine !== "sglang") fail("unsupported inference runtime manifest");
  if (record.backend !== "cpu" && record.backend !== "cuda" && record.backend !== "metal") fail("inference runtime backend is invalid");
  const pythonPackage = record.backend === "metal" || (record.schema_version === "2" && !!record.package && typeof record.package === "object"
    && (record.package as Record<string, unknown>).kind === "python-env");
  const packageRecord = exact(record.package,
    pythonPackage
      ? ["kind", "environment_digest", "python_version", "packages_digest"]
      : ["kind", "image", "image_digest", "platform"],
    "inference runtime package");
  const runtimePackage = pythonPackage
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
  if (packageRecord.kind !== runtimePackage.kind || (record.schema_version === "1" && (record.backend === "metal") !== (runtimePackage.kind === "python-env"))) fail("runtime package does not match backend");
  const manifest: InferenceRuntimeManifestV1 = {
    schema_version: record.schema_version,
    runtime_id: digest(record.runtime_id, "runtime_id"),
    engine: "sglang",
    sglang_version: text(record.sglang_version, "sglang_version"),
    sglang_commit: record.schema_version === "2" && runtimePackage.kind === "python-env"
      ? nullableText(record.sglang_commit, "sglang_commit") : text(record.sglang_commit, "sglang_commit"),
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
    "lease_owner_ids", "backend", "container_id", "service_handle", "model_node", "pid", "base_url", "started_at", "updated_at", "error",
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
  const serviceHandle = record.service_handle === undefined ? undefined : parseInferenceServiceHandle(record.service_handle);
  const modelNode = record.model_node === undefined ? undefined : parseModelNodeBinding(record.model_node);
  if (modelNode && (record.container_id !== undefined || record.pid !== undefined || serviceHandle?.kind === "docker"
    || serviceHandle?.kind === "process" && (serviceHandle.node_id !== modelNode.node_id || serviceHandle.generation !== modelNode.generation))) {
    fail("service handle differs from its frozen model node");
  }
  if (serviceHandle?.kind === "process" && (record.container_id !== undefined || record.pid !== undefined || serviceHandle.service_id !== record.service_id)) {
    fail("process service handle cannot use local container/PID identity or another service ID");
  }
  if (serviceHandle?.kind === "docker" && record.container_id !== undefined && record.container_id !== serviceHandle.container_id) fail("Docker service handle differs from container identity");
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
    ...(serviceHandle ? { service_handle: serviceHandle } : {}),
    ...(modelNode ? { model_node: modelNode } : {}),
    ...(record.pid === undefined ? {} : { pid: record.pid as number }),
    ...(record.base_url === undefined ? {} : { base_url: record.base_url as string }),
    started_at: timestamp(record.started_at, "inference started_at"),
    updated_at: timestamp(record.updated_at, "inference updated_at"),
    ...(error ? { error } : {}),
  };
}

export function parseInferenceServiceHandle(value: unknown): InferenceServiceHandleV2 {
  const input = value as Record<string, unknown> | null;
  const process = input?.kind === "process";
  const r = exact(input, process ? ["schema_version", "kind", "node_id", "generation", "service_id", "process"] : ["schema_version", "kind", "container_id"], "inference service handle");
  if (r.schema_version !== "2") fail("service handle version is invalid");
  if (!process) {
    if (r.kind !== "docker" || typeof r.container_id !== "string" || !/^[a-f0-9]{12,64}$/.test(r.container_id)) fail("Docker service handle is invalid");
    return { schema_version: "2", kind: "docker", container_id: r.container_id };
  }
  const p = exact(r.process, ["pid", "created_at"], "model-node process identity");
  for (const key of ["node_id", "generation"]) if (typeof r[key] !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(r[key] as string)) fail("model node identity/generation is invalid");
  if (typeof r.service_id !== "string" || !/^inference_[a-f0-9]{32}$/.test(r.service_id)
    || !Number.isSafeInteger(p.pid) || (p.pid as number) < 1 || typeof p.created_at !== "number" || !Number.isFinite(p.created_at) || p.created_at <= 0) fail("model-node process handle is invalid");
  return { schema_version: "2", kind: "process", node_id: r.node_id as string, generation: r.generation as string,
    service_id: r.service_id, process: { pid: p.pid as number, created_at: p.created_at } };
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
