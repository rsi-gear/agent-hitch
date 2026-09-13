import { lstat } from "node:fs/promises";
import path from "node:path";
import type {
  JsonValue,
  Sha256,
  VerifierArtifactExcerptV1,
  VerifierDiagnosticPageV1,
} from "../domain/index.js";
import { validateRelativePath } from "../domain/index.js";
import { openContainedRegularFile, sha256Bytes } from "../foundation/index.js";
import { sanitizeVerifierJson, sanitizeVerifierText } from "./verifier-evidence-redaction.js";

export const VERIFIER_DIAGNOSTICS_INDEX_REF = "verifier/diagnostics.json";
export const VERIFIER_DIAGNOSTIC_ARTIFACT_NAMES: readonly VerifierArtifactExcerptV1["name"][] = [
  "ctrf.json", "test-stdout.txt", "test-stderr.txt", "stdout.txt", "stderr.txt",
];

const MAX_DIAGNOSTICS_INDEX_BYTES = 1024 * 1024;
const MAX_PERSISTED_VERIFIER_ARTIFACT_BYTES = 16 * 1024 * 1024;

export interface StoredVerifierDiagnosticArtifact {
  name: VerifierArtifactExcerptV1["name"];
  mediaType: VerifierArtifactExcerptV1["media_type"];
  bytes: Buffer;
  sha256: Sha256;
  sourceComplete: boolean;
  lossReason?: VerifierDiagnosticPageV1["artifact"]["loss_reason"];
}

export interface StoredVerifierDiagnostics {
  artifacts: StoredVerifierDiagnosticArtifact[];
  redactions: Map<string, number>;
}

/** Reads and validates one diagnostic store for both inspect previews and page delivery. */
export async function readVerifierDiagnosticStorage(
  runRoot: string,
  credentialValues: readonly string[],
): Promise<StoredVerifierDiagnostics> {
  const indexFile = path.join(runRoot, ...VERIFIER_DIAGNOSTICS_INDEX_REF.split("/"));
  return await exists(indexFile)
    ? await readIndexedStorage(runRoot, credentialValues)
    : await readLegacyStorage(runRoot, credentialValues);
}

async function readIndexedStorage(
  runRoot: string,
  credentialValues: readonly string[],
): Promise<StoredVerifierDiagnostics> {
  const indexBytes = await secureRead(runRoot, VERIFIER_DIAGNOSTICS_INDEX_REF, MAX_DIAGNOSTICS_INDEX_BYTES);
  const index = asRecord(JSON.parse(indexBytes.toString("utf8")), "verifier diagnostics index");
  const version = index.schema_version;
  if ((version !== "1" && version !== "2") || index.kind !== "verifier-diagnostics"
    || !Array.isArray(index.artifacts) || !Array.isArray(index.redactions)
    || version === "2" && (!Array.isArray(index.losses)
      || !Number.isSafeInteger(index.hard_cap_bytes) || Number(index.hard_cap_bytes) <= 0
      || Number(index.hard_cap_bytes) > MAX_PERSISTED_VERIFIER_ARTIFACT_BYTES)) {
    throw new TypeError("verifier diagnostics index is invalid");
  }

  const redactions = new Map<string, number>();
  const seen = new Set<string>();
  for (const raw of index.redactions) {
    const rule = asRecord(raw, "verifier diagnostics redaction");
    exactFields(rule, ["rule_id", "count"], "verifier diagnostics redaction");
    if (typeof rule.rule_id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(rule.rule_id)
      || !Number.isSafeInteger(rule.count) || Number(rule.count) < 1
      || seen.has(`redaction:${rule.rule_id}`)) {
      throw new TypeError("verifier diagnostics redaction is invalid");
    }
    seen.add(`redaction:${rule.rule_id}`);
    increment(redactions, rule.rule_id, Number(rule.count));
  }

  const artifacts: StoredVerifierDiagnosticArtifact[] = [];
  for (const raw of index.artifacts) {
    const artifact = asRecord(raw, "verifier diagnostic artifact");
    exactFields(artifact, [
      "name", "ref", "media_type", "source_bytes", "source_sha256", "bytes", "sha256",
      "stored_bytes", "stored_sha256", "truncated",
    ], "verifier diagnostic artifact");
    const name = artifact.name as VerifierArtifactExcerptV1["name"];
    if (!VERIFIER_DIAGNOSTIC_ARTIFACT_NAMES.includes(name) || seen.has(name) || artifact.ref !== `verifier/${name}`) {
      throw new TypeError("verifier diagnostic artifact identity is invalid");
    }
    seen.add(name);
    const mediaType = mediaTypeFor(name);
    if (artifact.media_type !== mediaType) throw new TypeError("verifier diagnostic artifact media type is invalid");
    const availableBytes = nonNegativeInteger(artifact.bytes, "verifier diagnostic bytes");
    const availableDigest = sha256Value(artifact.sha256, "verifier diagnostic digest");
    nonNegativeInteger(artifact.source_bytes, "source verifier diagnostic bytes");
    sha256Value(artifact.source_sha256, "source verifier diagnostic digest");
    const storedBytes = nonNegativeInteger(artifact.stored_bytes, "stored verifier diagnostic bytes");
    const storedDigest = sha256Value(artifact.stored_sha256, "stored verifier diagnostic digest");
    if (typeof artifact.truncated !== "boolean" || version === "2" && artifact.truncated !== false
      || storedBytes > MAX_PERSISTED_VERIFIER_ARTIFACT_BYTES) {
      throw new TypeError("stored verifier diagnostic exceeds its persistence limit");
    }
    const stored = await secureRead(runRoot, String(artifact.ref), MAX_PERSISTED_VERIFIER_ARTIFACT_BYTES);
    if (stored.length !== storedBytes || sha256Bytes(stored) !== storedDigest) {
      throw new TypeError("stored verifier diagnostic integrity mismatch");
    }
    if (artifact.truncated === false && (availableBytes !== storedBytes || availableDigest !== storedDigest)) {
      throw new TypeError("complete verifier diagnostic metadata mismatch");
    }
    const bytes = sanitizeArtifact(stored, mediaType, artifact.truncated === false, credentialValues, redactions);
    artifacts.push({
      name,
      mediaType,
      bytes,
      sha256: sha256Bytes(bytes),
      sourceComplete: artifact.truncated === false,
      ...(artifact.truncated === true ? { lossReason: "legacy_truncated" as const } : {}),
    });
  }

  if (version === "2") {
    for (const raw of index.losses as unknown[]) {
      const loss = asRecord(raw, "unavailable verifier diagnostic");
      exactFields(loss, [
        "name", "media_type", "source_bytes", ...(loss.source_sha256 === undefined ? [] : ["source_sha256"]),
        "loss_reason", "persistence_limit_bytes",
      ], "unavailable verifier diagnostic");
      const name = loss.name as VerifierArtifactExcerptV1["name"];
      if (!VERIFIER_DIAGNOSTIC_ARTIFACT_NAMES.includes(name) || seen.has(name)) {
        throw new TypeError("unavailable verifier diagnostic identity is invalid");
      }
      seen.add(name);
      const mediaType = mediaTypeFor(name);
      if (loss.media_type !== mediaType
        || (loss.loss_reason !== "persistence_limit_exceeded" && loss.loss_reason !== "invalid_json")) {
        throw new TypeError("unavailable verifier diagnostic metadata is invalid");
      }
      nonNegativeInteger(loss.source_bytes, "unavailable verifier diagnostic source bytes");
      if (loss.source_sha256 !== undefined) {
        sha256Value(loss.source_sha256, "unavailable verifier diagnostic source digest");
      }
      const persistenceLimit = nonNegativeInteger(loss.persistence_limit_bytes, "verifier diagnostic persistence limit");
      if (persistenceLimit < 1 || persistenceLimit > MAX_PERSISTED_VERIFIER_ARTIFACT_BYTES) {
        throw new TypeError("unavailable verifier diagnostic persistence limit is invalid");
      }
      const bytes = Buffer.alloc(0);
      artifacts.push({
        name,
        mediaType,
        bytes,
        sha256: sha256Bytes(bytes),
        sourceComplete: false,
        lossReason: loss.loss_reason,
      });
    }
  }
  return { artifacts, redactions };
}

async function readLegacyStorage(
  runRoot: string,
  credentialValues: readonly string[],
): Promise<StoredVerifierDiagnostics> {
  const artifacts: StoredVerifierDiagnosticArtifact[] = [];
  const redactions = new Map<string, number>();
  for (const name of VERIFIER_DIAGNOSTIC_ARTIFACT_NAMES) {
    const ref = `verifier/${name}`;
    if (!await exists(path.join(runRoot, ...ref.split("/")))) continue;
    const mediaType = mediaTypeFor(name);
    let raw: Buffer;
    try {
      raw = await secureRead(runRoot, ref, MAX_PERSISTED_VERIFIER_ARTIFACT_BYTES);
    } catch (error) {
      if ((error as Error)?.message !== "contained file exceeds its limit") throw error;
      const bytes = Buffer.alloc(0);
      artifacts.push({
        name, mediaType, bytes, sha256: sha256Bytes(bytes), sourceComplete: false,
        lossReason: "persistence_limit_exceeded",
      });
      continue;
    }
    const bytes = sanitizeArtifact(raw, mediaType, mediaType === "application/json", credentialValues, redactions);
    artifacts.push({ name, mediaType, bytes, sha256: sha256Bytes(bytes), sourceComplete: true });
  }
  return { artifacts, redactions };
}

function sanitizeArtifact(
  stored: Buffer,
  mediaType: VerifierArtifactExcerptV1["media_type"],
  parseJson: boolean,
  credentials: readonly string[],
  redactions: Map<string, number>,
): Buffer {
  if (mediaType === "application/json" && parseJson) {
    const parsed = JSON.parse(stored.toString("utf8")) as unknown;
    if (!isJsonValue(parsed)) throw new TypeError("CTRF artifact is not JSON data");
    const safe = sanitizeVerifierJson(parsed, credentials);
    mergeCounts(redactions, safe.redactions);
    return Buffer.from(JSON.stringify(safe.value), "utf8");
  }
  const safe = sanitizeVerifierText(stored.toString("utf8"), credentials);
  mergeCounts(redactions, safe.redactions);
  return Buffer.from(safe.text, "utf8");
}

function mediaTypeFor(name: VerifierArtifactExcerptV1["name"]): VerifierArtifactExcerptV1["media_type"] {
  return name === "ctrf.json" ? "application/json" : "text/plain";
}

async function secureRead(root: string, ref: string, maxBytes: number): Promise<Buffer> {
  const relative = validateRelativePath(ref, "verifier diagnostic ref");
  const opened = await openContainedRegularFile(root, relative, maxBytes);
  try {
    const bytes = Buffer.allocUnsafe(opened.size);
    let position = 0;
    while (position < bytes.length) {
      const read = await opened.handle.read(bytes, position, bytes.length - position, position);
      if (read.bytesRead === 0) throw new TypeError(`${path.basename(ref)} changed while being read`);
      position += read.bytesRead;
    }
    if ((await opened.handle.read(Buffer.allocUnsafe(1), 0, 1, bytes.length)).bytesRead !== 0) {
      throw new TypeError(`${path.basename(ref)} changed while being read`);
    }
    await opened.assertUnchanged();
    return bytes;
  } finally {
    await opened.handle.close();
  }
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} is invalid`);
  return Number(value);
}

function sha256Value(value: unknown, label: string): Sha256 {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new TypeError(`${label} is invalid`);
  return value as Sha256;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactFields(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const fields = new Set(allowed);
  const unexpected = Object.keys(record).find((field) => !fields.has(field));
  if (unexpected) throw new TypeError(`${label} has unknown field: ${unexpected}`);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return Boolean(value) && typeof value === "object"
    && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function mergeCounts(target: Map<string, number>, source: Map<string, number>): void {
  for (const [rule, count] of source) increment(target, rule, count);
}

function increment(counts: Map<string, number>, rule: string, count = 1): void {
  counts.set(rule, (counts.get(rule) ?? 0) + count);
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
