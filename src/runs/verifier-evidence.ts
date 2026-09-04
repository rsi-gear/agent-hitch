import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  HitchVerifierEvidenceV1,
  JsonValue,
  RunRecordV1,
  Sha256,
  VerifierArtifactExcerptV1,
} from "../domain/index.js";
import { validateRelativePath } from "../domain/index.js";
import {
  HitchError,
  PROVIDER_ENVIRONMENT_NAMES,
  credentialValuesFromEnv,
  openContainedRegularFile,
  safeDiagnosticMessage,
  sha256Bytes,
  statePaths,
} from "../foundation/index.js";
import { verifyResultBundleIndex } from "./bundle.js";
import { loadRunRecord } from "./records.js";
import { sanitizeVerifierJson, sanitizeVerifierText } from "./verifier-evidence-redaction.js";

export const MAX_VERIFIER_RESULT_BYTES = 1024 * 1024;
export const MAX_VERIFIER_ARTIFACT_OUTPUT_BYTES = 64 * 1024;

const DIAGNOSTICS_INDEX_REF = "verifier/diagnostics.json";
const ARTIFACT_NAMES: readonly VerifierArtifactExcerptV1["name"][] = [
  "ctrf.json", "test-stdout.txt", "test-stderr.txt", "stdout.txt", "stderr.txt",
];
const JSON_DIAGNOSTIC_REFS = [
  "verifier/infrastructure-error.json",
  "verifier/infrastructure-retry-history.json",
] as const;
const TRUNCATION_MARKER = "\n[... verifier artifact truncated ...]\n";
const MAX_EVAL_IDENTITY_BYTES = 16 * 1024 * 1024;
const MAX_PERSISTED_VERIFIER_ARTIFACT_BYTES = 16 * 1024 * 1024;

export interface LoadVerifierEvidenceOptions {
  env?: NodeJS.ProcessEnv;
  maxResultBytes?: number;
  maxArtifactBytes?: number;
}

export async function loadVerifierEvidence(
  root: string,
  runId: string,
  options: LoadVerifierEvidenceOptions = {},
): Promise<HitchVerifierEvidenceV1> {
  if (!/^run_[a-f0-9]{32}$/.test(runId)) throw new TypeError(`invalid run ID: ${runId}`);
  const maxResultBytes = positiveLimit(options.maxResultBytes ?? MAX_VERIFIER_RESULT_BYTES, "verifier result");
  const maxArtifactBytes = positiveLimit(options.maxArtifactBytes ?? MAX_VERIFIER_ARTIFACT_OUTPUT_BYTES, "verifier artifact");
  const runDirectory = path.join(statePaths(root).runs, runId);
  const runRoot = await safeRunRoot(runDirectory, runId);
  let loaded: Awaited<ReturnType<typeof loadRunRecord>>;
  try {
    loaded = await loadRunRecord(runDirectory, { verifyTrajectory: false });
  } catch (error) {
    throw new HitchError(`run ${runId} record is corrupt`, { code: "verifier_evidence_corrupt", exitCode: 3, cause: error });
  }
  const credentialValues = await runCredentialValues(runRoot, loaded.record, options.env ?? process.env);
  const redactions = new Map<string, number>();
  const issues: string[] = [];
  let corrupt = loaded.record_status === "corrupt";
  if (corrupt) issues.push("run record integrity is corrupt");

  if (await exists(path.join(runDirectory, "bundle.index.json"))) {
    try {
      await verifyResultBundleIndex(runDirectory);
    } catch {
      corrupt = true;
      issues.push("result bundle integrity is corrupt");
    }
  }
  const parentIssue = await verifierParentIssue(root, loaded.record);
  if (parentIssue) {
    corrupt = true;
    issues.push(parentIssue);
  }

  let result: JsonValue | undefined;
  let resultSha256: Sha256 | undefined;
  const resultRef = loaded.record.observation?.verifier_result_ref;
  if (resultRef) {
    try {
      if (!resultRef.startsWith("verifier/")) throw new TypeError("verifier result ref is outside verifier evidence");
      const bytes = await secureRead(runRoot, resultRef, maxResultBytes);
      resultSha256 = sha256Bytes(bytes);
      const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
      if (!isJsonValue(parsed)) throw new TypeError("verifier result is not JSON data");
      result = redactJson(parsed, credentialValues, redactions);
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > maxResultBytes) throw new TypeError("verifier result exceeds its output limit");
    } catch (error) {
      corrupt = true;
      issues.push(safeIssue("verifier result is corrupt", error, credentialValues));
    }
  }

  let diagnostics: NonNullable<HitchVerifierEvidenceV1["verifier"]["diagnostics"]> | undefined;
  try {
    diagnostics = await loadDiagnostics(runRoot, maxArtifactBytes, credentialValues, redactions);
  } catch (error) {
    corrupt = true;
    issues.push(safeIssue("verifier diagnostics are corrupt", error, credentialValues));
  }

  const completeDiagnostics = diagnostics?.ctrf !== undefined
    || Boolean(diagnostics?.stdout?.length)
    || Boolean(diagnostics?.stderr?.length);
  const status = corrupt
    ? "corrupt"
    : result === undefined
      ? "missing"
      : completeDiagnostics ? "complete" : "result_only";
  let publicParent: HitchVerifierEvidenceV1["parent"];
  if (loaded.record.parent && /^eval_[a-f0-9]{32}$/.test(loaded.record.parent.eval_id)) {
    const trialId = sanitizeVerifierText(loaded.record.parent.trial_id, credentialValues);
    mergeCounts(redactions, trialId.redactions);
    publicParent = {
      eval_id: loaded.record.parent.eval_id,
      trial_id: trialId.text,
      attempt: loaded.record.parent.attempt,
    };
  }
  let publicObservation = loaded.record.observation;
  if (loaded.record.observation) {
    const reason = loaded.record.observation.invalid_reason
      ? sanitizeVerifierText(loaded.record.observation.invalid_reason, credentialValues) : undefined;
    const ref = loaded.record.observation.verifier_result_ref
      ? sanitizeVerifierText(loaded.record.observation.verifier_result_ref, credentialValues) : undefined;
    if (reason) mergeCounts(redactions, reason.redactions);
    if (ref) mergeCounts(redactions, ref.redactions);
    publicObservation = {
      ...loaded.record.observation,
      ...(reason ? { invalid_reason: reason.text } : {}),
      ...(ref ? { verifier_result_ref: ref.text } : {}),
    };
  }
  return {
    schema_version: "1",
    kind: "verifier-evidence",
    run_id: runId,
    ...(publicParent ? { parent: publicParent } : {}),
    ...(publicObservation ? { observation: publicObservation } : {}),
    verifier: {
      status,
      ...(result === undefined ? {} : { result }),
      ...(resultSha256 === undefined ? {} : { result_sha256: resultSha256 }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
      ...(issues.length === 0 ? {} : { issues: [...new Set(issues)].slice(0, 16) }),
    },
    ...(redactions.size === 0 ? {} : { redactions: canonicalCounts(redactions) }),
  };
}

async function loadDiagnostics(
  runRoot: string,
  maxBytes: number,
  credentialValues: readonly string[],
  redactions: Map<string, number>,
): Promise<NonNullable<HitchVerifierEvidenceV1["verifier"]["diagnostics"]> | undefined> {
  const indexFile = path.join(runRoot, ...DIAGNOSTICS_INDEX_REF.split("/"));
  const artifacts = await exists(indexFile)
    ? await indexedArtifacts(runRoot, maxBytes, credentialValues, redactions)
    : await legacyArtifacts(runRoot, maxBytes, credentialValues, redactions);
  const ctrf = artifacts.find((artifact) => artifact.name === "ctrf.json");
  const stdout = artifacts.filter((artifact) => artifact.name === "test-stdout.txt" || artifact.name === "stdout.txt");
  const stderr = artifacts.filter((artifact) => artifact.name === "test-stderr.txt" || artifact.name === "stderr.txt");
  const infrastructureError = await optionalJsonDiagnostic(runRoot, JSON_DIAGNOSTIC_REFS[0], credentialValues, redactions);
  const retryHistory = await optionalJsonDiagnostic(runRoot, JSON_DIAGNOSTIC_REFS[1], credentialValues, redactions);
  if (!ctrf && stdout.length === 0 && stderr.length === 0 && infrastructureError === undefined && retryHistory === undefined) return undefined;
  return {
    ...(ctrf ? { ctrf } : {}),
    ...(stdout.length ? { stdout } : {}),
    ...(stderr.length ? { stderr } : {}),
    ...(infrastructureError === undefined ? {} : { infrastructure_error: infrastructureError }),
    ...(retryHistory === undefined ? {} : { retry_history: [retryHistory] }),
  };
}

async function indexedArtifacts(
  runRoot: string,
  maxBytes: number,
  credentialValues: readonly string[],
  redactions: Map<string, number>,
): Promise<VerifierArtifactExcerptV1[]> {
  const indexBytes = await secureRead(runRoot, DIAGNOSTICS_INDEX_REF, MAX_VERIFIER_RESULT_BYTES);
  const index = asRecord(JSON.parse(indexBytes.toString("utf8")), "verifier diagnostics index");
  if (index.schema_version !== "1" || index.kind !== "verifier-diagnostics" || !Array.isArray(index.artifacts) || !Array.isArray(index.redactions)) {
    throw new TypeError("verifier diagnostics index is invalid");
  }
  const seen = new Set<string>();
  for (const rule of index.redactions) {
    const parsed = asRecord(rule, "verifier diagnostics redaction");
    exactFields(parsed, ["rule_id", "count"], "verifier diagnostics redaction");
    if (typeof parsed.rule_id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(parsed.rule_id)
      || !Number.isSafeInteger(parsed.count) || Number(parsed.count) < 1) {
      throw new TypeError("verifier diagnostics redaction is invalid");
    }
    if (seen.has(`redaction:${parsed.rule_id}`)) throw new TypeError("verifier diagnostics redactions are duplicated");
    seen.add(`redaction:${parsed.rule_id}`);
    increment(redactions, parsed.rule_id, Number(parsed.count));
  }
  const result: VerifierArtifactExcerptV1[] = [];
  for (const raw of index.artifacts) {
    const artifact = asRecord(raw, "verifier diagnostic artifact");
    exactFields(artifact, [
      "name", "ref", "media_type", "source_bytes", "source_sha256", "bytes", "sha256",
      "stored_bytes", "stored_sha256", "truncated",
    ], "verifier diagnostic artifact");
    const name = artifact.name as VerifierArtifactExcerptV1["name"];
    if (!ARTIFACT_NAMES.includes(name) || seen.has(name) || artifact.ref !== `verifier/${name}`) {
      throw new TypeError("verifier diagnostic artifact identity is invalid");
    }
    seen.add(name);
    const mediaType = name === "ctrf.json" ? "application/json" : "text/plain";
    if (artifact.media_type !== mediaType) throw new TypeError("verifier diagnostic artifact media type is invalid");
    const persistedBytes = nonNegativeInteger(artifact.bytes, "verifier diagnostic bytes");
    const persistedDigest = sha256Value(artifact.sha256, "verifier diagnostic digest");
    nonNegativeInteger(artifact.source_bytes, "source verifier diagnostic bytes");
    sha256Value(artifact.source_sha256, "source verifier diagnostic digest");
    const storedBytes = nonNegativeInteger(artifact.stored_bytes, "stored verifier diagnostic bytes");
    const storedDigest = sha256Value(artifact.stored_sha256, "stored verifier diagnostic digest");
    if (typeof artifact.truncated !== "boolean" || storedBytes > MAX_PERSISTED_VERIFIER_ARTIFACT_BYTES) {
      throw new TypeError("stored verifier diagnostic exceeds its persistence limit");
    }
    const stored = await secureRead(runRoot, String(artifact.ref), MAX_PERSISTED_VERIFIER_ARTIFACT_BYTES);
    if (stored.length !== storedBytes || sha256Bytes(stored) !== storedDigest) throw new TypeError("stored verifier diagnostic integrity mismatch");
    if (artifact.truncated === false && (persistedBytes !== storedBytes || persistedDigest !== storedDigest)) {
      throw new TypeError("complete verifier diagnostic metadata mismatch");
    }
    const full = sanitizedArtifact(stored, mediaType, artifact.truncated === false, credentialValues, redactions);
    const bounded = truncate(full, maxBytes);
    result.push(excerpt(name, mediaType, full.length, sha256Bytes(full), artifact.truncated === true || bounded.truncated, bounded.bytes));
  }
  return result;
}

async function legacyArtifacts(
  runRoot: string,
  maxBytes: number,
  credentialValues: readonly string[],
  redactions: Map<string, number>,
): Promise<VerifierArtifactExcerptV1[]> {
  const result: VerifierArtifactExcerptV1[] = [];
  for (const name of ARTIFACT_NAMES) {
    const ref = `verifier/${name}`;
    if (!await exists(path.join(runRoot, ...ref.split("/")))) continue;
    let raw: Buffer;
    try {
      raw = await secureRead(runRoot, ref, MAX_PERSISTED_VERIFIER_ARTIFACT_BYTES);
    } catch (error) {
      if ((error as Error)?.message === "contained file exceeds its limit") continue;
      throw error;
    }
    const mediaType = name === "ctrf.json" ? "application/json" : "text/plain";
    const full = sanitizedArtifact(raw, mediaType, mediaType === "application/json", credentialValues, redactions);
    const stored = truncate(full, maxBytes);
    result.push(excerpt(
      name,
      mediaType,
      full.length,
      sha256Bytes(full),
      stored.truncated,
      stored.bytes,
    ));
  }
  return result;
}

function sanitizedArtifact(
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

function excerpt(
  name: VerifierArtifactExcerptV1["name"],
  mediaType: VerifierArtifactExcerptV1["media_type"],
  bytes: number,
  digest: Sha256,
  truncated: unknown,
  stored: Buffer,
): VerifierArtifactExcerptV1 {
  const common = { name, media_type: mediaType, bytes, sha256: digest, truncated: truncated === true };
  const text = stored.toString("utf8");
  if (mediaType === "application/json" && truncated !== true) {
    const parsed = JSON.parse(text) as unknown;
    if (!isJsonValue(parsed)) throw new TypeError("CTRF artifact is not JSON data");
    return { ...common, json: parsed };
  }
  return { ...common, text };
}

async function optionalJsonDiagnostic(
  runRoot: string,
  ref: string,
  credentialValues: readonly string[],
  redactions: Map<string, number>,
): Promise<JsonValue | undefined> {
  if (!await exists(path.join(runRoot, ...ref.split("/")))) return undefined;
  const bytes = await secureRead(runRoot, ref, MAX_VERIFIER_RESULT_BYTES);
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!isJsonValue(parsed)) throw new TypeError(`${path.basename(ref)} is not JSON data`);
  return redactJson(parsed, credentialValues, redactions);
}

async function verifierParentIssue(root: string, record: RunRecordV1): Promise<string | null> {
  if (!record.parent) return null;
  if (!/^eval_[a-f0-9]{32}$/.test(record.parent.eval_id)) return "eval parent identity is invalid";
  const evalDirectory = path.join(statePaths(root).evals, record.parent.eval_id);
  let evalRoot: string;
  try {
    const info = await lstat(evalDirectory);
    if (info.isSymbolicLink() || !info.isDirectory()) return "eval parent directory is unsafe";
    evalRoot = await realpath(evalDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "eval parent directory is unreadable";
  }
  let inspected = false;
  for (const name of ["result.json", "progress.json"]) {
    const file = path.join(evalDirectory, name);
    if (!await exists(file)) continue;
    inspected = true;
    let document: Record<string, unknown>;
    try {
      const value = JSON.parse((await secureRead(evalRoot, name, MAX_EVAL_IDENTITY_BYTES)).toString("utf8")) as unknown;
      document = asRecord(value, "eval record");
    } catch {
      return "eval parent record is corrupt";
    }
    if (document.eval_id !== undefined && document.eval_id !== record.parent.eval_id) return "eval parent identity mismatch";
    if (!Array.isArray(document.trials)) continue;
    const trial = document.trials.map((entry) => asRecord(entry, "eval trial"))
      .find((entry) => entry.trial_id === record.parent?.trial_id);
    if (!trial) continue;
    if (trial.run_id !== record.run_id || trial.attempt !== record.parent.attempt
      || record.context.kind === "benchmark_task" && trial.task_id !== record.context.task_id) {
      return "eval trial identity mismatch";
    }
    return null;
  }
  return inspected ? "eval trial identity is missing" : null;
}

async function runCredentialValues(runRoot: string, record: RunRecordV1, env: NodeJS.ProcessEnv): Promise<string[]> {
  let names: string[] = [...PROVIDER_ENVIRONMENT_NAMES];
  try {
    const request = JSON.parse((await secureRead(runRoot, record.request_ref, MAX_VERIFIER_RESULT_BYTES)).toString("utf8")) as Record<string, unknown>;
    if (Array.isArray(request.credential_names)) {
      names = [...names, ...request.credential_names.filter((name): name is string => typeof name === "string")];
    }
  } catch { /* Core record validation reports malformed requests separately. */ }
  return credentialValuesFromEnv([...new Set(names)], env);
}

async function safeRunRoot(runDirectory: string, runId: string): Promise<string> {
  try {
    const info = await lstat(runDirectory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("run directory is unsafe");
    return await realpath(runDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HitchError(`run not found: ${runId}`, { code: "run_not_found", exitCode: 3 });
    }
    throw new HitchError(`run ${runId} directory is unsafe`, { code: "verifier_evidence_corrupt", exitCode: 3, cause: error });
  }
}

async function secureRead(root: string, ref: string, maxBytes: number): Promise<Buffer> {
  const relative = validateRelativePath(ref, "verifier evidence ref");
  const opened = await openContainedRegularFile(root, relative, maxBytes);
  try {
    const bytes = await opened.handle.readFile();
    await opened.assertUnchanged();
    if (bytes.length !== opened.size) throw new TypeError(`${path.basename(ref)} changed while being read`);
    return bytes;
  } finally {
    await opened.handle.close();
  }
}

function redactJson(value: JsonValue, credentials: readonly string[], counts: Map<string, number>): JsonValue {
  const redacted = sanitizeVerifierJson(value, credentials);
  mergeCounts(counts, redacted.redactions);
  return redacted.value;
}

function truncate(value: Buffer, limit: number): { bytes: Buffer; truncated: boolean } {
  if (value.length <= limit) return { bytes: value, truncated: false };
  const marker = Buffer.from(TRUNCATION_MARKER, "utf8");
  const payload = limit - marker.length;
  const head = Math.floor(payload / 2);
  return {
    bytes: Buffer.concat([
      validUtf8Prefix(value, head),
      marker,
      validUtf8Suffix(value, payload - head),
    ]),
    truncated: true,
  };
}

function validUtf8Prefix(value: Buffer, limit: number): Buffer {
  let end = Math.min(value.length, limit);
  if (end === value.length) return value;
  while (end > 0 && (value[end]! & 0xc0) === 0x80) end -= 1;
  return value.subarray(0, end);
}

function validUtf8Suffix(value: Buffer, limit: number): Buffer {
  let start = Math.max(0, value.length - limit);
  while (start < value.length && (value[start]! & 0xc0) === 0x80) start += 1;
  return value.subarray(start);
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= Buffer.byteLength(TRUNCATION_MARKER) + 2) throw new TypeError(`${label} limit is invalid`);
  return value;
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
  return Boolean(value) && typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function canonicalCounts(counts: Map<string, number>): Array<{ rule_id: string; count: number }> {
  return [...counts.entries()].filter(([, count]) => count > 0).sort(([left], [right]) => left.localeCompare(right))
    .map(([rule_id, count]) => ({ rule_id, count }));
}

function mergeCounts(target: Map<string, number>, source: Map<string, number>): void {
  for (const [rule, count] of source) increment(target, rule, count);
}

function increment(counts: Map<string, number>, rule: string, count = 1): void {
  counts.set(rule, (counts.get(rule) ?? 0) + count);
}

function safeIssue(prefix: string, error: unknown, credentials: readonly string[]): string {
  const detail = sanitizeVerifierText(safeDiagnosticMessage(error, credentials, 512), credentials).text;
  return detail ? `${prefix}: ${detail}` : prefix;
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
