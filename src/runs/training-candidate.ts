import path from "node:path";
import type { Sha256, TrainingDataCandidateV1 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, readJSON, sha256JSON, statePaths } from "../foundation/index.js";
import { verifyResultBundleIndex } from "./bundle.js";
import { loadRunRecord } from "./records.js";

export interface TrainingDataCandidatePolicyV1 {
  contextLicense?: "allowed" | "denied" | "unknown";
  captureRequired?: boolean;
  redactionPolicy?: string;
}

export async function deriveTrainingDataCandidate(input: {
  root: string;
  runId: string;
  policy?: TrainingDataCandidatePolicyV1;
}): Promise<{ candidate: TrainingDataCandidateV1; path: string; created: boolean }> {
  if (!/^run_[a-f0-9]{32}$/.test(input.runId)) throw invalid("training-data candidate run_id is invalid");
  const runDirectory = path.join(statePaths(input.root).runs, input.runId);
  const bundle = await verifyResultBundleIndex(runDirectory);
  const loaded = await loadRunRecord(runDirectory, { verifyTrajectory: true });
  if (loaded.record.run_id !== input.runId || bundle.run_id !== input.runId) throw new TypeError("training-data source identity changed");
  if (loaded.record.context.kind !== "benchmark_task") {
    throw new HitchError("training-data candidates require a benchmark task run", { code: "training_candidate_context_unsupported", exitCode: 2 });
  }
  const policy = normalizePolicy(input.policy);
  const ineligible: string[] = [];
  const review: string[] = [];
  const observation = loaded.record.observation;
  if (loaded.record_status !== "valid") ineligible.push("source-record-corrupt");
  if (observation?.status !== "valid") ineligible.push("observation-invalid");
  if (loaded.verifier_status !== "valid") ineligible.push("verifier-evidence-incomplete");
  if (loaded.trajectory_status !== "valid") ineligible.push("trajectory-incomplete");
  if (observation?.invalid_reason && /(?:infrastructure|bundle|trajectory|verifier_result_missing)/.test(observation.invalid_reason)) {
    ineligible.push("infrastructure-diagnostic");
  }
  if (policy.contextLicense === "denied") ineligible.push("context-license-denied");
  else if (policy.contextLicense === "unknown") review.push("context-license-unknown");
  if (loaded.record.model.identity_resolved !== true) review.push("model-identity-unresolved");
  const captureCompleteness = bundle.capture?.completeness ?? (loaded.trajectory_status === "valid" ? "complete" : "none");
  if (policy.captureRequired && captureCompleteness !== "complete") ineligible.push("required-capture-incomplete");
  if (bundle.capture?.redaction.status === "failed") ineligible.push("redaction-failed");
  const reasons = canonicalReasons(ineligible.length > 0 ? ineligible : review);
  const eligibility = ineligible.length > 0 ? "ineligible" : review.length > 0 ? "review-required" : "eligible";
  const harnessRevision = loaded.record.harness.revision_identity;
  if (!harnessRevision) ineligible.push("harness-revision-unresolved");
  if (!harnessRevision) {
    throw new HitchError("training-data source has no immutable harness revision", { code: "training_candidate_revision_unavailable", exitCode: 12 });
  }
  const contextRef = "manifest.json#/context";
  const trajectoryRef = loaded.record.trajectory_ref ?? "trajectory.ref.json";
  const verifierRef = observation?.verifier_result_ref ?? "verifier/result.json";
  const metadata = {
    benchmark_id: loaded.record.context.benchmark_id,
    benchmark_revision: loaded.record.context.benchmark_revision,
    harness_revision: harnessRevision,
    model_identity_resolved: loaded.record.model.identity_resolved === true,
    capture_completeness: captureCompleteness,
    redaction_policy: policy.redactionPolicy,
  };
  const provenanceDigest = sha256JSON({
    source_bundle_digest: bundle.bundle_digest,
    context_identity: bundle.context_identity,
    provenance: bundle.provenance,
    policy,
  });
  const identity = {
    schema_version: "1" as const,
    source_bundle_digest: bundle.bundle_digest,
    run_id: input.runId,
    eligibility,
    reasons,
    context_ref: contextRef,
    trajectory_ref: trajectoryRef,
    verifier_ref: verifierRef,
    metadata,
    provenance_digest: provenanceDigest,
  };
  const candidate = parseTrainingDataCandidate({ ...identity, candidate_id: sha256JSON(identity) });
  const target = path.join(statePaths(input.root).trainingDataCandidates, candidate.candidate_id.slice("sha256:".length), "candidate.json");
  const existing = await readJSON<unknown | null>(target, null);
  if (existing !== null) {
    const parsed = parseTrainingDataCandidate(existing);
    if (JSON.stringify(parsed) !== JSON.stringify(candidate)) throw new TypeError("training-data candidate identity was rebound");
    return { candidate: parsed, path: target, created: false };
  }
  await atomicWriteJSON(target, candidate);
  return { candidate, path: target, created: true };
}

export function parseTrainingDataCandidate(value: unknown): TrainingDataCandidateV1 {
  const record = exact(value, [
    "schema_version", "candidate_id", "source_bundle_digest", "run_id", "eligibility", "reasons",
    "context_ref", "trajectory_ref", "verifier_ref", "metadata", "provenance_digest",
  ], "training-data candidate");
  if (record.schema_version !== "1" || !isSha256(record.candidate_id) || !isSha256(record.source_bundle_digest)
    || !isSha256(record.provenance_digest) || typeof record.run_id !== "string" || !/^run_[a-f0-9]{32}$/.test(record.run_id)
    || !new Set(["eligible", "ineligible", "review-required"]).has(String(record.eligibility))) {
    throw new TypeError("training-data candidate identity is invalid");
  }
  if (!Array.isArray(record.reasons) || record.reasons.some((reason) => typeof reason !== "string" || !/^[a-z0-9-]+$/.test(reason))) {
    throw new TypeError("training-data candidate reasons are invalid");
  }
  const reasons = canonicalReasons(record.reasons as string[]);
  if (JSON.stringify(reasons) !== JSON.stringify(record.reasons)) throw new TypeError("training-data candidate reasons are not canonical");
  for (const field of ["context_ref", "trajectory_ref", "verifier_ref"] as const) {
    if (typeof record[field] !== "string" || !record[field] || record[field].length > 4_096 || /[\0\r\n]/.test(record[field] as string)) {
      throw new TypeError(`training-data candidate ${field} is invalid`);
    }
  }
  const metadata = exact(record.metadata, [
    "benchmark_id", "benchmark_revision", "harness_revision", "model_identity_resolved", "capture_completeness", "redaction_policy",
  ], "training-data candidate metadata");
  if (typeof metadata.benchmark_id !== "string" || !metadata.benchmark_id || typeof metadata.benchmark_revision !== "string" || !metadata.benchmark_revision
    || !isSha256(metadata.harness_revision) || typeof metadata.model_identity_resolved !== "boolean"
    || !new Set(["complete", "partial", "none"]).has(String(metadata.capture_completeness))
    || typeof metadata.redaction_policy !== "string" || !metadata.redaction_policy || metadata.redaction_policy.length > 256) {
    throw new TypeError("training-data candidate metadata is invalid");
  }
  return {
    schema_version: "1",
    candidate_id: record.candidate_id as Sha256,
    source_bundle_digest: record.source_bundle_digest as Sha256,
    run_id: record.run_id,
    eligibility: record.eligibility as TrainingDataCandidateV1["eligibility"],
    reasons,
    context_ref: record.context_ref as string,
    trajectory_ref: record.trajectory_ref as string,
    verifier_ref: record.verifier_ref as string,
    metadata: metadata as unknown as TrainingDataCandidateV1["metadata"],
    provenance_digest: record.provenance_digest as Sha256,
  };
}

function normalizePolicy(value?: TrainingDataCandidatePolicyV1): Required<TrainingDataCandidatePolicyV1> {
  const contextLicense = value?.contextLicense ?? "unknown";
  const captureRequired = value?.captureRequired ?? false;
  const redactionPolicy = value?.redactionPolicy ?? "hitch-provider-redaction-v1";
  if (!new Set(["allowed", "denied", "unknown"]).has(contextLicense) || typeof captureRequired !== "boolean"
    || !redactionPolicy || redactionPolicy.length > 256 || /[\0\r\n]/.test(redactionPolicy)) throw invalid("training-data candidate policy is invalid");
  return { contextLicense, captureRequired, redactionPolicy };
}

function canonicalReasons(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new TypeError(`${label} has unknown fields`);
  return record;
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function invalid(message: string): HitchError {
  return new HitchError(message, { code: "invalid_input", exitCode: 2 });
}
