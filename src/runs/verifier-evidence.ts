import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  HitchVerifierEvidenceV1,
  JsonValue,
  RunRecordV1,
  Sha256,
  VerifierDiagnosticPageV1,
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
import {
  readVerifierDiagnosticStorage,
  VERIFIER_DIAGNOSTIC_ARTIFACT_NAMES,
} from "./verifier-diagnostic-storage.js";
import { sanitizeVerifierJson, sanitizeVerifierText } from "./verifier-evidence-redaction.js";
import { loadVerifierDiagnosticSupplement } from "./verifier-diagnostic-supplement.js";
import { loadStructuredVerifierEvidence } from "./verifier-structured-evidence.js";

export const MAX_VERIFIER_RESULT_BYTES = 1024 * 1024;
export const MAX_VERIFIER_ARTIFACT_OUTPUT_BYTES = 64 * 1024;
export const MAX_VERIFIER_DIAGNOSTIC_PAGE_BYTES = 64 * 1024;

const JSON_DIAGNOSTIC_REFS = [
  "verifier/infrastructure-error.json",
  "verifier/infrastructure-retry-history.json",
] as const;
const TRUNCATION_MARKER = "\n[... verifier artifact truncated ...]\n";
const MAX_EVAL_IDENTITY_BYTES = 16 * 1024 * 1024;

export interface LoadVerifierEvidenceOptions {
  env?: NodeJS.ProcessEnv;
  maxResultBytes?: number;
  maxArtifactBytes?: number;
}

export interface LoadVerifierDiagnosticPageOptions {
  env?: NodeJS.ProcessEnv;
  offset?: number;
  maxBytes?: number;
  expectedSha256?: Sha256;
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
    const supplement = await loadVerifierDiagnosticSupplement(root, runRoot, runId);
    diagnostics = await loadDiagnostics(supplement?.directory ?? runRoot, maxArtifactBytes, credentialValues, redactions);
  } catch (error) {
    corrupt = true;
    issues.push(safeIssue("verifier diagnostics are corrupt", error, credentialValues));
  }

  let structured: Awaited<ReturnType<typeof loadStructuredVerifierEvidence>> = {};
  try {
    structured = await loadStructuredVerifierEvidence(runRoot, result, credentialValues, redactions);
  } catch (error) {
    corrupt = true;
    issues.push(safeIssue("structured verifier evidence is corrupt", error, credentialValues));
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
      ...(structured.scores === undefined ? {} : { scores: structured.scores }),
      ...(structured.process === undefined ? {} : { process: structured.process }),
      ...(structured.feedback === undefined ? {} : { feedback: structured.feedback }),
      ...(structured.structured_artifacts === undefined ? {} : { structured_artifacts: structured.structured_artifacts }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
      ...(issues.length === 0 ? {} : { issues: [...new Set(issues)].slice(0, 16) }),
    },
    ...(redactions.size === 0 ? {} : { redactions: canonicalCounts(redactions) }),
  };
}

export async function loadVerifierDiagnosticPage(
  root: string,
  runId: string,
  name: VerifierArtifactExcerptV1["name"],
  options: LoadVerifierDiagnosticPageOptions = {},
): Promise<VerifierDiagnosticPageV1> {
  if (!/^run_[a-f0-9]{32}$/.test(runId)) throw new TypeError(`invalid run ID: ${runId}`);
  if (!VERIFIER_DIAGNOSTIC_ARTIFACT_NAMES.includes(name)) throw new TypeError(`invalid verifier diagnostic artifact: ${name}`);
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("verifier diagnostic offset is invalid");
  const maxBytes = options.maxBytes ?? MAX_VERIFIER_DIAGNOSTIC_PAGE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > MAX_VERIFIER_DIAGNOSTIC_PAGE_BYTES) {
    throw new TypeError("verifier diagnostic page limit is invalid");
  }
  const runDirectory = path.join(statePaths(root).runs, runId);
  const runRoot = await safeRunRoot(runDirectory, runId);
  let loaded: Awaited<ReturnType<typeof loadRunRecord>>;
  try {
    loaded = await loadRunRecord(runDirectory, { verifyTrajectory: false });
    if (loaded.record_status === "corrupt" || loaded.record.run_id !== runId) throw new TypeError("run record integrity is corrupt");
    if (await exists(path.join(runDirectory, "bundle.index.json"))) await verifyResultBundleIndex(runDirectory);
  } catch (error) {
    throw new HitchError(`run ${runId} record is corrupt`, { code: "verifier_evidence_corrupt", exitCode: 3, cause: error });
  }
  const parentIssue = await verifierParentIssue(root, loaded.record);
  if (parentIssue) {
    throw new HitchError(`run ${runId} verifier parent is corrupt: ${parentIssue}`, {
      code: "verifier_evidence_corrupt", exitCode: 3,
    });
  }
  const credentialValues = await runCredentialValues(runRoot, loaded.record, options.env ?? process.env);
  let source: Awaited<ReturnType<typeof readVerifierDiagnosticStorage>>["artifacts"][number];
  try {
    const supplement = await loadVerifierDiagnosticSupplement(root, runRoot, runId);
    const stored = await readVerifierDiagnosticStorage(supplement?.directory ?? runRoot, credentialValues);
    const found = stored.artifacts.find((artifact) => artifact.name === name);
    if (!found) throw diagnosticNotFound(name);
    source = found;
  } catch (error) {
    if (error instanceof HitchError) throw error;
    throw new HitchError(`verifier diagnostic ${name} is corrupt`, {
      code: "verifier_evidence_corrupt", exitCode: 3, cause: error,
    });
  }
  if (options.expectedSha256 !== undefined && options.expectedSha256 !== source.sha256) {
    throw new HitchError(`verifier diagnostic ${name} changed`, {
      code: "verifier_diagnostic_version_mismatch", exitCode: 3,
    });
  }
  const artifact = {
    name,
    media_type: source.mediaType,
    bytes: source.bytes.length,
    sha256: source.sha256,
    source_complete: source.sourceComplete,
    ...(source.lossReason ? { loss_reason: source.lossReason } : {}),
  };
  if (!source.sourceComplete) {
    if (offset !== 0) throw new TypeError("unavailable verifier diagnostic requires offset zero");
    return {
      schema_version: "1", kind: "verifier-diagnostic-page", run_id: runId, artifact,
      page: { offset: 0, bytes: 0, text: "", eof: true },
    };
  }
  if (offset > source.bytes.length || !isUtf8Boundary(source.bytes, offset)) {
    throw new TypeError("verifier diagnostic offset is invalid");
  }
  let end = Math.min(source.bytes.length, offset + maxBytes);
  while (end > offset && end < source.bytes.length && !isUtf8Boundary(source.bytes, end)) end -= 1;
  if (end === offset && end < source.bytes.length) throw new TypeError("verifier diagnostic page limit is too small");
  const page = source.bytes.subarray(offset, end);
  const eof = end === source.bytes.length;
  return {
    schema_version: "1", kind: "verifier-diagnostic-page", run_id: runId, artifact,
    page: {
      offset,
      bytes: page.length,
      text: page.toString("utf8"),
      eof,
      ...(eof ? {} : { next_offset: end }),
    },
  };
}

async function loadDiagnostics(
  runRoot: string,
  maxBytes: number,
  credentialValues: readonly string[],
  redactions: Map<string, number>,
): Promise<NonNullable<HitchVerifierEvidenceV1["verifier"]["diagnostics"]> | undefined> {
  const stored = await readVerifierDiagnosticStorage(runRoot, credentialValues);
  mergeCounts(redactions, stored.redactions);
  const artifacts = stored.artifacts.map((artifact) => {
    const bounded = truncate(artifact.bytes, maxBytes);
    return excerpt(
      artifact.name,
      artifact.mediaType,
      artifact.bytes.length,
      artifact.sha256,
      !artifact.sourceComplete || bounded.truncated,
      bounded.bytes,
    );
  });
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

function diagnosticNotFound(name: string): HitchError {
  return new HitchError(`verifier diagnostic not found: ${name}`, {
    code: "verifier_diagnostic_not_found", exitCode: 3,
  });
}

function isUtf8Boundary(value: Buffer, offset: number): boolean {
  return offset === 0 || offset === value.length || (value[offset]! & 0xc0) !== 0x80;
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

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
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
