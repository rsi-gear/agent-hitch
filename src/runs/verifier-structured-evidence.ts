import { lstat } from "node:fs/promises";
import path from "node:path";
import type {
  HitchVerifierEvidenceV1,
  JsonValue,
  VerifierStructuredArtifactV1,
} from "../domain/index.js";
import {
  MAX_VERIFIER_FEEDBACK_BYTES,
  MAX_VERIFIER_PROCESS_BYTES,
  assertVerifierScoreEvidenceConsistency,
  parseVerifierFeedback,
  parseVerifierProcessEvidence,
  parseVerifierScores,
  validateRelativePath,
} from "../domain/index.js";
import { openContainedRegularFile, sha256Bytes } from "../foundation/index.js";
import { sanitizeVerifierJson } from "./verifier-evidence-redaction.js";

export async function loadStructuredVerifierEvidence(
  runRoot: string,
  result: JsonValue | undefined,
  credentialValues: readonly string[],
  redactions: Map<string, number>,
): Promise<Pick<HitchVerifierEvidenceV1["verifier"], "scores" | "process" | "feedback" | "structured_artifacts">> {
  const scores = parseVerifierScores(result);
  const processArtifact = await optionalStructuredJson(runRoot, "process.json", MAX_VERIFIER_PROCESS_BYTES);
  const feedbackArtifact = await optionalStructuredJson(runRoot, "feedback.json", MAX_VERIFIER_FEEDBACK_BYTES);
  const processEvidence = processArtifact === undefined ? undefined : parseVerifierProcessEvidence(processArtifact.value);
  const feedback = feedbackArtifact === undefined ? undefined : parseVerifierFeedback(feedbackArtifact.value, processEvidence);
  assertVerifierScoreEvidenceConsistency({
    scores,
    ...(processEvidence === undefined ? {} : { process: processEvidence }),
    ...(feedback === undefined ? {} : { feedback }),
  });
  const safeProcess = processEvidence === undefined ? undefined : sanitizedStructured(processEvidence, credentialValues, redactions, parseVerifierProcessEvidence);
  const safeFeedback = feedback === undefined ? undefined : sanitizedStructured(
    feedback,
    credentialValues,
    redactions,
    (value) => parseVerifierFeedback(value, safeProcess),
  );
  const artifacts: NonNullable<HitchVerifierEvidenceV1["verifier"]["structured_artifacts"]> = {};
  if (processArtifact) artifacts.process = structuredArtifact("verifier/process.json", processArtifact.bytes);
  if (feedbackArtifact) artifacts.feedback = structuredArtifact("verifier/feedback.json", feedbackArtifact.bytes);
  return {
    ...(scores === undefined ? {} : { scores }),
    ...(safeProcess === undefined ? {} : { process: safeProcess }),
    ...(safeFeedback === undefined ? {} : { feedback: safeFeedback }),
    ...(Object.keys(artifacts).length === 0 ? {} : { structured_artifacts: artifacts }),
  };
}

async function optionalStructuredJson(
  runRoot: string,
  name: "process.json" | "feedback.json",
  maximumBytes: number,
): Promise<{ value: JsonValue; bytes: Buffer } | undefined> {
  const ref = `verifier/${name}`;
  if (!await exists(path.join(runRoot, ...ref.split("/")))) return undefined;
  const bytes = await secureRead(runRoot, ref, maximumBytes);
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!isJsonValue(value)) throw new TypeError(`${name} is not JSON data`);
  return { value, bytes };
}

function sanitizedStructured<T>(
  value: T,
  credentials: readonly string[],
  redactions: Map<string, number>,
  parser: (value: unknown) => T,
): T {
  const safe = sanitizeVerifierJson(value as JsonValue, credentials);
  for (const [rule, count] of safe.redactions) redactions.set(rule, (redactions.get(rule) ?? 0) + count);
  return parser(safe.value);
}

function structuredArtifact(ref: VerifierStructuredArtifactV1["ref"], bytes: Buffer): VerifierStructuredArtifactV1 {
  return { ref, bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

async function secureRead(root: string, ref: string, maxBytes: number): Promise<Buffer> {
  const opened = await openContainedRegularFile(root, validateRelativePath(ref, "structured verifier evidence ref"), maxBytes);
  try {
    const bytes = await opened.handle.readFile();
    await opened.assertUnchanged();
    if (bytes.length !== opened.size) throw new TypeError(`${path.basename(ref)} changed while being read`);
    return bytes;
  } finally {
    await opened.handle.close();
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return Boolean(value) && typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
