import { createHash } from "node:crypto";
import { realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { JsonValue, Sha256, VerifierArtifactExcerptV1 } from "../domain/index.js";
import { PROVIDER_ENVIRONMENT_NAMES, atomicWriteJSON, credentialValuesFromEnv, openContainedRegularFile, redactCredentialText, writePrivateFile } from "../foundation/index.js";
import type { ContainedRegularFile } from "../foundation/index.js";
import { sanitizeVerifierJson, sanitizeVerifierText } from "../runs/index.js";
import { captureVerifierScoreEvidence } from "./verifier-score-artifacts.js";
import type { CapturedVerifierScoreEvidenceV1 } from "./verifier-score-artifacts.js";

export const MAX_VERIFIER_DIAGNOSTIC_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_VERIFIER_DIAGNOSTIC_MAX_BYTES = MAX_VERIFIER_DIAGNOSTIC_MAX_BYTES;
export const VERIFIER_DIAGNOSTICS_INDEX_REF = "verifier/diagnostics.json";
export const VERIFIER_ARTIFACT_NAMES: readonly VerifierArtifactExcerptV1["name"][] = [
  "ctrf.json", "test-stdout.txt", "test-stderr.txt", "stdout.txt", "stderr.txt",
];

export interface PersistedVerifierArtifactV1 {
  name: VerifierArtifactExcerptV1["name"];
  ref: string;
  media_type: VerifierArtifactExcerptV1["media_type"];
  source_bytes: number;
  source_sha256: Sha256;
  bytes: number;
  sha256: Sha256;
  stored_bytes: number;
  stored_sha256: Sha256;
  truncated: boolean;
}

export interface VerifierDiagnosticsIndexV1 {
  schema_version: "1";
  kind: "verifier-diagnostics";
  artifacts: PersistedVerifierArtifactV1[];
  redactions: Array<{ rule_id: string; count: number }>;
}

export interface UnavailableVerifierArtifactV2 {
  name: VerifierArtifactExcerptV1["name"];
  media_type: VerifierArtifactExcerptV1["media_type"];
  source_bytes: number;
  source_sha256?: Sha256;
  loss_reason: "persistence_limit_exceeded" | "invalid_json";
  persistence_limit_bytes: number;
}

export interface VerifierDiagnosticsIndexV2 {
  schema_version: "2";
  kind: "verifier-diagnostics";
  hard_cap_bytes: number;
  artifacts: PersistedVerifierArtifactV1[];
  losses: UnavailableVerifierArtifactV2[];
  redactions: Array<{ rule_id: string; count: number }>;
}

export interface CaptureVerifierDiagnosticsOptions {
  maxArtifactBytes?: number;
  credentialValues?: readonly string[];
  signal?: AbortSignal;
}

export async function persistTrialVerifierDiagnostics(input: {
  trialDirectory: string;
  runDirectory: string;
  passEnv?: readonly string[];
  env?: NodeJS.ProcessEnv | undefined;
  maxArtifactBytes?: number | undefined;
  verifierResult?: Record<string, unknown> | null;
  dataset?: string | undefined;
  benchmarkRevision?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<CapturedVerifierScoreEvidenceV1> {
  const env = input.env ?? process.env;
  const credentialValues = credentialValuesFromEnv(
    [...PROVIDER_ENVIRONMENT_NAMES, ...(input.passEnv ?? [])],
    env,
  );
  throwIfAborted(input.signal);
  await copyVerifierRetryHistory(input.trialDirectory, input.runDirectory, credentialValues, input.signal);
  await copyCandidateIneligibleDiagnostic(input.trialDirectory, input.runDirectory, input.signal);
  const scores = await captureVerifierScoreEvidence({
    trialDirectory: input.trialDirectory,
    runDirectory: input.runDirectory,
    verifierResult: input.verifierResult ?? null,
    credentialValues,
    ...(input.dataset === undefined ? {} : { dataset: input.dataset }),
    ...(input.benchmarkRevision === undefined ? {} : { benchmarkRevision: input.benchmarkRevision }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  await captureVerifierDiagnostics(input.trialDirectory, input.runDirectory, {
    ...(input.maxArtifactBytes === undefined ? {} : { maxArtifactBytes: input.maxArtifactBytes }),
    credentialValues,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return scores;
}

async function copyCandidateIneligibleDiagnostic(trialDirectory: string, runDirectory: string, signal?: AbortSignal): Promise<void> {
  const root = await realpath(trialDirectory);
  throwIfAborted(signal);
  const safe = await safeArtifact(root, "candidate-ineligible.json", 16 * 1024);
  if (!safe) return;
  let bytes: Buffer;
  try {
    bytes = await safe.handle.readFile();
    await safe.assertUnchanged();
  } finally {
    await safe.handle.close();
  }
  const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (value.schema_version !== "1" || value.code !== "candidate_evidence_unavailable" || value.verifier_executed !== false) return;
  await atomicWriteJSON(path.join(runDirectory, "verifier", "candidate-ineligible.json"), value);
}

/** Persist complete redacted verifier artifacts up to an explicit hard cap. */
export async function captureVerifierDiagnostics(
  trialDirectory: string,
  runDirectory: string,
  options: CaptureVerifierDiagnosticsOptions = {},
): Promise<VerifierDiagnosticsIndexV2 | null> {
  const maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_VERIFIER_DIAGNOSTIC_MAX_BYTES;
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes <= 0
    || maxArtifactBytes > MAX_VERIFIER_DIAGNOSTIC_MAX_BYTES) {
    throw new TypeError("verifier diagnostic artifact limit is invalid");
  }
  throwIfAborted(options.signal);
  const root = await realpath(trialDirectory);
  const artifacts: PersistedVerifierArtifactV1[] = [];
  const losses: UnavailableVerifierArtifactV2[] = [];
  const redactions = new Map<string, number>();
  for (const name of VERIFIER_ARTIFACT_NAMES) {
    throwIfAborted(options.signal);
    const safe = await safeArtifact(root, name);
    if (!safe) continue;
    const mediaType = name === "ctrf.json" ? "application/json" : "text/plain";
    if (safe.size > maxArtifactBytes) {
      try {
        await safe.assertUnchanged();
      } finally {
        await safe.handle.close();
      }
      losses.push({
        name,
        media_type: mediaType,
        source_bytes: safe.size,
        loss_reason: "persistence_limit_exceeded",
        persistence_limit_bytes: maxArtifactBytes,
      });
      continue;
    }
    let captured: Awaited<ReturnType<typeof captureArtifact>>;
    try {
      captured = await captureArtifact(safe.handle, safe.size, mediaType, options.credentialValues ?? [], options.signal);
      await safe.assertUnchanged();
      if (captured.sourceBytes !== safe.size) throw new TypeError(`verifier artifact changed while being captured: ${name}`);
    } finally {
      await safe.handle.close();
    }
    if (captured.lossReason || !captured.stored || captured.stored.length > maxArtifactBytes) {
      losses.push({
        name,
        media_type: mediaType,
        source_bytes: captured.sourceBytes,
        source_sha256: captured.sourceSha256,
        loss_reason: captured.lossReason ?? "persistence_limit_exceeded",
        persistence_limit_bytes: maxArtifactBytes,
      });
      continue;
    }
    mergeCounts(redactions, captured.redactions);
    const ref = `verifier/${name}`;
    const destination = path.join(runDirectory, ...ref.split("/"));
    await writePrivateFile(destination, captured.stored);
    const stored = captured.stored;
    artifacts.push({
      name,
      ref,
      media_type: mediaType,
      source_bytes: captured.sourceBytes,
      source_sha256: captured.sourceSha256,
      bytes: captured.contentBytes,
      sha256: captured.contentSha256,
      stored_bytes: stored.length,
      stored_sha256: sha256(stored),
      truncated: false,
    });
  }
  if (artifacts.length === 0 && losses.length === 0) return null;
  const index: VerifierDiagnosticsIndexV2 = {
    schema_version: "2",
    kind: "verifier-diagnostics",
    hard_cap_bytes: maxArtifactBytes,
    artifacts,
    losses,
    redactions: canonicalCounts(redactions),
  };
  await atomicWriteJSON(path.join(runDirectory, ...VERIFIER_DIAGNOSTICS_INDEX_REF.split("/")), index);
  return index;
}

async function safeArtifact(root: string, name: string, maximumBytes?: number): Promise<ContainedRegularFile | null> {
  try {
    return await openContainedRegularFile(root, `verifier/${name}`, maximumBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new TypeError(`unsafe verifier artifact: ${name}`, { cause: error });
  }
}

async function captureArtifact(
  handle: FileHandle,
  expectedBytes: number,
  mediaType: VerifierArtifactExcerptV1["media_type"],
  credentialValues: readonly string[],
  signal?: AbortSignal | undefined,
): Promise<{
  sourceSha256: Sha256;
  sourceBytes: number;
  contentSha256: Sha256;
  contentBytes: number;
  stored?: Buffer;
  lossReason?: "invalid_json";
  redactions: Map<string, number>;
}> {
  throwIfAborted(signal);
  const source = await readExactFile(handle, expectedBytes, signal);
  throwIfAborted(signal);
  let stored: Buffer;
  let redactions: Map<string, number>;
  if (mediaType === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.toString("utf8")) as unknown;
    } catch {
      return {
        sourceSha256: sha256(source), sourceBytes: source.length,
        contentSha256: sha256(Buffer.alloc(0)), contentBytes: 0,
        lossReason: "invalid_json", redactions: new Map(),
      };
    }
    if (!isJsonValue(parsed)) {
      return {
        sourceSha256: sha256(source), sourceBytes: source.length,
        contentSha256: sha256(Buffer.alloc(0)), contentBytes: 0,
        lossReason: "invalid_json", redactions: new Map(),
      };
    }
    const sanitized = sanitizeVerifierJson(parsed, credentialValues);
    stored = Buffer.from(JSON.stringify(sanitized.value), "utf8");
    redactions = sanitized.redactions;
  } else {
    const sanitized = sanitizeVerifierText(source.toString("utf8"), credentialValues);
    stored = Buffer.from(sanitized.text, "utf8");
    redactions = sanitized.redactions;
  }
  return {
    sourceSha256: sha256(source),
    sourceBytes: source.length,
    contentSha256: sha256(stored),
    contentBytes: stored.length,
    stored,
    redactions,
  };
}

async function readExactFile(handle: FileHandle, expectedBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const result = Buffer.allocUnsafe(expectedBytes);
  let position = 0;
  while (position < expectedBytes) {
    throwIfAborted(signal);
    const read = await handle.read(result, position, expectedBytes - position, position);
    if (read.bytesRead === 0) throw new TypeError("verifier artifact changed while being captured");
    position += read.bytesRead;
  }
  const probe = Buffer.allocUnsafe(1);
  if ((await handle.read(probe, 0, 1, expectedBytes)).bytesRead !== 0) {
    throw new TypeError("verifier artifact changed while being captured");
  }
  return result;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return Boolean(value) && typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function canonicalCounts(counts: Map<string, number>): Array<{ rule_id: string; count: number }> {
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rule_id, count]) => ({ rule_id, count }));
}

function mergeCounts(target: Map<string, number>, source: Map<string, number>): void {
  for (const [rule, count] of source) increment(target, rule, count);
}

function increment(counts: Map<string, number>, rule: string, count = 1): void {
  counts.set(rule, (counts.get(rule) ?? 0) + count);
}

function sha256(value: Buffer): Sha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function copyVerifierRetryHistory(
  trialDirectory: string,
  runDirectory: string,
  credentialValues: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const root = await realpath(trialDirectory);
  throwIfAborted(signal);
  const safe = await safeArtifact(root, "infrastructure-retry-history.json", 1024 * 1024);
  if (!safe) return;
  let bytes: Buffer;
  try {
    bytes = await safe.handle.readFile();
    await safe.assertUnchanged();
  } finally {
    await safe.handle.close();
  }
  throwIfAborted(signal);
  const history = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (history?.schema_version !== "1"
    || history.code !== "verifier_infrastructure_retry_history"
    || history.candidate_rerun !== false
    || !Array.isArray(history.attempts)) return;
  const redacted = redactCredentialText(JSON.stringify(history), credentialValues).text;
  await atomicWriteJSON(path.join(runDirectory, "verifier", "infrastructure-retry-history.json"), JSON.parse(redacted));
}
