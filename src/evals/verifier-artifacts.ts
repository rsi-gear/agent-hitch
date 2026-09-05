import { createHash } from "node:crypto";
import { realpath, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import type { Sha256, VerifierArtifactExcerptV1 } from "../domain/index.js";
import { PROVIDER_ENVIRONMENT_NAMES, atomicWriteJSON, credentialValuesFromEnv, openContainedRegularFile, redactCredentialText, writePrivateFile } from "../foundation/index.js";
import type { ContainedRegularFile } from "../foundation/index.js";
import { captureVerifierScoreEvidence } from "./verifier-score-artifacts.js";
import type { CapturedVerifierScoreEvidenceV1 } from "./verifier-score-artifacts.js";

export const DEFAULT_VERIFIER_DIAGNOSTIC_MAX_BYTES = 64 * 1024;
export const MAX_VERIFIER_DIAGNOSTIC_MAX_BYTES = 16 * 1024 * 1024;
export const VERIFIER_DIAGNOSTICS_INDEX_REF = "verifier/diagnostics.json";
export const VERIFIER_ARTIFACT_NAMES: readonly VerifierArtifactExcerptV1["name"][] = [
  "ctrf.json", "test-stdout.txt", "test-stderr.txt", "stdout.txt", "stderr.txt",
];

const TRUNCATION_MARKER = Buffer.from("\n[... verifier artifact truncated ...]\n", "utf8");
const MAX_LOG_LINE_BYTES = 1024 * 1024;

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

/** Persist bounded, redacted verifier artifacts in the immutable run bundle. */
export async function captureVerifierDiagnostics(
  trialDirectory: string,
  runDirectory: string,
  options: CaptureVerifierDiagnosticsOptions = {},
): Promise<VerifierDiagnosticsIndexV1 | null> {
  const maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_VERIFIER_DIAGNOSTIC_MAX_BYTES;
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes <= TRUNCATION_MARKER.length + 2
    || maxArtifactBytes > MAX_VERIFIER_DIAGNOSTIC_MAX_BYTES) {
    throw new TypeError("verifier diagnostic artifact limit is invalid");
  }
  throwIfAborted(options.signal);
  const root = await realpath(trialDirectory);
  const artifacts: PersistedVerifierArtifactV1[] = [];
  const redactions = new Map<string, number>();
  for (const name of VERIFIER_ARTIFACT_NAMES) {
    throwIfAborted(options.signal);
    const safe = await safeArtifact(root, name);
    if (!safe) continue;
    let captured: Awaited<ReturnType<typeof captureText>>;
    try {
      captured = await captureText(safe.handle, maxArtifactBytes, options.credentialValues ?? [], options.signal);
      await safe.assertUnchanged();
      if (captured.sourceBytes !== safe.size) throw new TypeError(`verifier artifact changed while being captured: ${name}`);
    } finally {
      await safe.handle.close();
    }
    mergeCounts(redactions, captured.redactions);
    const ref = `verifier/${name}`;
    const destination = path.join(runDirectory, ...ref.split("/"));
    await writePrivateFile(destination, captured.stored);
    const stored = captured.stored;
    artifacts.push({
      name,
      ref,
      media_type: name === "ctrf.json" ? "application/json" : "text/plain",
      source_bytes: captured.sourceBytes,
      source_sha256: captured.sourceSha256,
      bytes: captured.contentBytes,
      sha256: captured.contentSha256,
      stored_bytes: stored.length,
      stored_sha256: sha256(stored),
      truncated: captured.truncated,
    });
  }
  if (artifacts.length === 0) return null;
  const index: VerifierDiagnosticsIndexV1 = {
    schema_version: "1",
    kind: "verifier-diagnostics",
    artifacts,
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

async function captureText(
  handle: FileHandle,
  maxBytes: number,
  credentialValues: readonly string[],
  signal?: AbortSignal | undefined,
): Promise<{
  sourceSha256: Sha256;
  sourceBytes: number;
  contentSha256: Sha256;
  contentBytes: number;
  stored: Buffer;
  truncated: boolean;
  redactions: Map<string, number>;
}> {
  const sourceHash = createHash("sha256");
  const contentHash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  const bounded = new BoundedBuffer(maxBytes);
  const redactions = new Map<string, number>();
  let sourceBytes = 0;
  let pending = "";
  let discarding = false;
  const emit = (value: string): void => {
    const redacted = redactCredentialText(value, credentialValues);
    mergeCounts(redactions, redacted.redactions);
    const bytes = Buffer.from(redacted.text, "utf8");
    contentHash.update(bytes);
    bounded.append(bytes);
  };
  const drain = (): void => {
    for (;;) {
      const newline = pending.indexOf("\n");
      if (discarding) {
        if (newline < 0) { pending = ""; return; }
        pending = pending.slice(newline + 1);
        discarding = false;
        continue;
      }
      if (newline >= 0) {
        emit(pending.slice(0, newline + 1));
        pending = pending.slice(newline + 1);
        continue;
      }
      if (Buffer.byteLength(pending, "utf8") > MAX_LOG_LINE_BYTES) {
        emit("[REDACTED OVERSIZED VERIFIER LOG LINE]\n");
        increment(redactions, "oversized-verifier-log-line-v1");
        bounded.markOmitted();
        pending = "";
        discarding = true;
      }
      return;
    }
  };

  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  for (;;) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    const bytes = buffer.subarray(0, bytesRead);
    sourceHash.update(bytes);
    sourceBytes += bytes.length;
    pending += decoder.write(bytes);
    drain();
  }
  pending += decoder.end();
  drain();
  if (!discarding && pending) emit(pending);
  throwIfAborted(signal);
  return {
    sourceSha256: `sha256:${sourceHash.digest("hex")}`,
    sourceBytes,
    contentSha256: `sha256:${contentHash.digest("hex")}`,
    contentBytes: bounded.totalBytes,
    stored: bounded.value(),
    truncated: bounded.truncated,
    redactions,
  };
}

class BoundedBuffer {
  readonly payloadLimit: number;
  readonly headLimit: number;
  readonly tailLimit: number;
  totalBytes = 0;
  private clipped = false;
  private omitted = false;
  private complete: Buffer[] = [];
  private head: Buffer = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);

  constructor(readonly limit: number) {
    this.payloadLimit = limit - TRUNCATION_MARKER.length;
    this.headLimit = Math.floor(this.payloadLimit / 2);
    this.tailLimit = this.payloadLimit - this.headLimit;
  }

  append(value: Buffer): void {
    if (value.length === 0) return;
    this.totalBytes += value.length;
    if (!this.clipped) {
      this.complete.push(value);
      const combined = Buffer.concat(this.complete);
      if (combined.length <= this.limit) return;
      this.clipped = true;
      this.complete = [];
      this.head = combined.subarray(0, this.headLimit);
      this.tail = combined.subarray(Math.max(0, combined.length - this.tailLimit));
      return;
    }
    this.tail = rollingTail(this.tail, value, this.tailLimit);
  }

  value(): Buffer {
    return this.clipped
      ? Buffer.concat([
        validUtf8Prefix(this.head),
        TRUNCATION_MARKER,
        validUtf8Suffix(this.tail),
      ])
      : Buffer.concat(this.complete);
  }

  markOmitted(): void {
    this.omitted = true;
  }

  get truncated(): boolean {
    return this.clipped || this.omitted;
  }
}

function validUtf8Prefix(value: Buffer): Buffer {
  let end = value.length;
  while (end > 0 && (value[end - 1]! & 0xc0) === 0x80) end -= 1;
  const lead = end - 1;
  return lead >= 0 && utf8SequenceLength(value[lead]!) > value.length - lead ? value.subarray(0, lead) : value;
}

function validUtf8Suffix(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length && (value[start]! & 0xc0) === 0x80) start += 1;
  return value.subarray(start);
}

function utf8SequenceLength(byte: number): number {
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

function rollingTail(current: Buffer, next: Buffer, limit: number): Buffer {
  if (next.length >= limit) return next.subarray(next.length - limit);
  const keep = Math.max(0, limit - next.length);
  return Buffer.concat([current.subarray(Math.max(0, current.length - keep)), next]);
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
