import { realpath } from "node:fs/promises";
import path from "node:path";
import type {
  JsonValue,
  Sha256,
  VerifierFeedbackV1,
  VerifierProcessEvidenceV1,
  VerifierScoresV1,
  VerifierStructuredArtifactV1,
} from "../domain/index.js";
import {
  MAX_VERIFIER_FEEDBACK_BYTES,
  MAX_VERIFIER_PROCESS_BYTES,
  assertVerifierScoreEvidenceConsistency,
  parseVerifierFeedback,
  parseVerifierProcessEvidence,
  parseVerifierScores,
} from "../domain/index.js";
import { atomicWriteJSON, openContainedRegularFile, safeDiagnosticMessage, sha256Bytes } from "../foundation/index.js";
import { loadBenchmarkAdapterManifest, scoreWithinRange } from "./benchmark-adapter-manifest.js";

export interface CapturedVerifierScoreEvidenceV1 {
  scores?: VerifierScoresV1;
  process?: VerifierProcessEvidenceV1;
  feedback?: VerifierFeedbackV1;
  structured_artifacts?: {
    process?: VerifierStructuredArtifactV1;
    feedback?: VerifierStructuredArtifactV1;
  };
  issue?: string;
}

/**
 * Validate and persist only the two standard structured verifier artifacts.
 * Arbitrary files in the verifier directory remain private and inaccessible.
 */
export async function captureVerifierScoreEvidence(input: {
  trialDirectory: string;
  runDirectory: string;
  verifierResult: Record<string, unknown> | null;
  credentialValues?: readonly string[];
  dataset?: string;
  benchmarkRevision?: string;
  signal?: AbortSignal;
}): Promise<CapturedVerifierScoreEvidenceV1> {
  try {
    throwIfAborted(input.signal);
    const adapterManifest = input.dataset === undefined ? null : await loadBenchmarkAdapterManifest(input.dataset);
    if (adapterManifest && adapterManifest.dataset_digest !== input.benchmarkRevision) {
      throw new TypeError("benchmark adapter manifest changed after eval admission");
    }
    const root = await realpath(input.trialDirectory);
    const processSource = await optionalJson(root, "process.json", MAX_VERIFIER_PROCESS_BYTES, input.signal);
    const feedbackSource = await optionalJson(root, "feedback.json", MAX_VERIFIER_FEEDBACK_BYTES, input.signal);
    const scores = parseVerifierScores(input.verifierResult);
    const processEvidence = processSource === undefined ? undefined : parseVerifierProcessEvidence(processSource.value);
    const feedback = feedbackSource === undefined ? undefined : parseVerifierFeedback(feedbackSource.value, processEvidence);
    assertVerifierScoreEvidenceConsistency({
      scores,
      ...(processEvidence === undefined ? {} : { process: processEvidence }),
      ...(feedback === undefined ? {} : { feedback }),
    });
    if (adapterManifest) {
      if (!scores || scores.normalization !== "standard") throw new TypeError("standardized benchmark requires total_score");
      if (!scoreWithinRange(scores.total_score, adapterManifest.scoring.total_score)) throw new TypeError("total_score is outside the benchmark range");
      const processDefinition = adapterManifest.scoring.process_score;
      if ((scores.process_score !== undefined) !== (processDefinition !== undefined)) {
        throw new TypeError("process_score availability differs from the benchmark manifest");
      }
      if (processDefinition && scores.process_score !== undefined && !scoreWithinRange(scores.process_score, processDefinition)) {
        throw new TypeError("process_score is outside the benchmark range");
      }
      if (processDefinition && processEvidence?.metric !== processDefinition.source_metric) {
        throw new TypeError("process evidence metric differs from the benchmark manifest");
      }
    }
    const structuredArtifacts: NonNullable<CapturedVerifierScoreEvidenceV1["structured_artifacts"]> = {};
    if (processEvidence) {
      const target = path.join(input.runDirectory, "verifier", "process.json");
      await atomicWriteJSON(target, processEvidence);
      structuredArtifacts.process = artifact("verifier/process.json", encoded(processEvidence));
    }
    if (feedback) {
      const target = path.join(input.runDirectory, "verifier", "feedback.json");
      await atomicWriteJSON(target, feedback);
      structuredArtifacts.feedback = artifact("verifier/feedback.json", encoded(feedback));
    }
    return {
      ...(scores === undefined ? {} : { scores }),
      ...(processEvidence === undefined ? {} : { process: processEvidence }),
      ...(feedback === undefined ? {} : { feedback }),
      ...(Object.keys(structuredArtifacts).length === 0 ? {} : { structured_artifacts: structuredArtifacts }),
    };
  } catch (error) {
    if (input.signal?.aborted || (error as Error)?.name === "AbortError") throw error;
    return {
      issue: safeDiagnosticMessage(error, input.credentialValues ?? []).slice(0, 1024),
    };
  }
}

async function optionalJson(
  root: string,
  name: "process.json" | "feedback.json",
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<{ value: JsonValue; bytes: Buffer } | undefined> {
  let safe;
  try {
    safe = await openContainedRegularFile(root, `verifier/${name}`, maximumBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new TypeError(`unsafe structured verifier artifact: ${name}`, { cause: error });
  }
  try {
    throwIfAborted(signal);
    const bytes = await safe.handle.readFile();
    await safe.assertUnchanged();
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!isJsonValue(value)) throw new TypeError(`${name} is not JSON data`);
    return { value, bytes };
  } finally {
    await safe.handle.close();
  }
}

function artifact(ref: VerifierStructuredArtifactV1["ref"], bytes: Buffer): VerifierStructuredArtifactV1 {
  return { ref, bytes: bytes.length, sha256: sha256Bytes(bytes) as Sha256 };
}

function encoded(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return Boolean(value) && typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
