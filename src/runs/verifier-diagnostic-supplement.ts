import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { Sha256, VerifierArtifactExcerptV1 } from "../domain/index.js";
import { openContainedRegularFile, sha256Bytes, statePaths } from "../foundation/index.js";
import { verifyResultBundleIndex } from "./bundle.js";
import { loadRunRecord } from "./records.js";

const DIAGNOSTICS_INDEX_REF = "verifier/diagnostics.json";
const MAX_INDEX_BYTES = 1024 * 1024;
const ARTIFACT_NAMES = new Set(["ctrf.json", "test-stdout.txt", "test-stderr.txt", "stdout.txt", "stderr.txt"]);

export interface VerifierDiagnosticSourceIdentityV1 {
  name: VerifierArtifactExcerptV1["name"];
  bytes: number;
  sha256: Sha256;
}

export interface VerifierDiagnosticRepairManifestV1 {
  schema_version: "1";
  kind: "verifier-diagnostics-repair";
  run_id: string;
  parent: { eval_id: string; trial_id: string; attempt: number; task_id: string };
  original: {
    bundle_digest: Sha256;
    bundle_index_sha256: Sha256;
    diagnostics_index_sha256: Sha256;
  };
  source: {
    kind: "harbor-trial";
    relative_trial_directory: string;
    artifacts: VerifierDiagnosticSourceIdentityV1[];
  };
  repaired: { diagnostics_index_sha256: Sha256 };
  created_at: string;
}

export interface LoadedVerifierDiagnosticSupplement {
  directory: string;
  manifest: VerifierDiagnosticRepairManifestV1;
  repair_sha256: Sha256;
}

export function verifierDiagnosticSupplementRelative(runId: string, originalIndexSha256: Sha256): string {
  if (!/^run_[a-f0-9]{32}$/.test(runId) || !/^sha256:[0-9a-f]{64}$/.test(originalIndexSha256)) {
    throw new TypeError("verifier diagnostic supplement identity is invalid");
  }
  return path.join(runId, originalIndexSha256.slice("sha256:".length));
}

export function verifierDiagnosticSupplementBase(root: string): string {
  return path.join(statePaths(root).root, "derived", "verifier-diagnostics");
}

export async function loadVerifierDiagnosticSupplement(
  root: string,
  runRoot: string,
  runId: string,
): Promise<LoadedVerifierDiagnosticSupplement | null> {
  let originalIndex: Buffer;
  try {
    originalIndex = await readContained(runRoot, DIAGNOSTICS_INDEX_REF, MAX_INDEX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const originalIndexSha256 = sha256Bytes(originalIndex);
  const relative = verifierDiagnosticSupplementRelative(runId, originalIndexSha256);
  const base = verifierDiagnosticSupplementBase(await canonicalStateRoot(root));
  let canonicalBase: string;
  try {
    const info = await lstat(base);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("verifier diagnostic supplement root is unsafe");
    canonicalBase = await realpath(base);
    if (canonicalBase !== path.resolve(base)) throw new TypeError("verifier diagnostic supplement root is unsafe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const manifestRef = path.join(relative, "repair.json").split(path.sep).join("/");
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readContained(canonicalBase, manifestRef, MAX_INDEX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const manifest = parseVerifierDiagnosticRepairManifest(JSON.parse(manifestBytes.toString("utf8")));
  const run = await loadRunRecord(runRoot, { verifyTrajectory: false });
  const parent = run.record.parent;
  if (manifest.run_id !== runId || !parent || run.record.context.kind !== "benchmark_task"
    || manifest.parent.eval_id !== parent.eval_id || manifest.parent.trial_id !== parent.trial_id
    || manifest.parent.attempt !== parent.attempt || manifest.parent.task_id !== run.record.context.task_id) {
    throw new TypeError("verifier diagnostic repair parent identity mismatch");
  }
  const bundle = await verifyResultBundleIndex(runRoot);
  const bundleIndexSha256 = sha256Bytes(await readContained(runRoot, "bundle.index.json", MAX_INDEX_BYTES));
  if (manifest.original.bundle_digest !== bundle.bundle_digest
    || manifest.original.bundle_index_sha256 !== bundleIndexSha256
    || manifest.original.diagnostics_index_sha256 !== originalIndexSha256) {
    throw new TypeError("verifier diagnostic repair original bundle identity mismatch");
  }
  const expectedSources = sourceIdentitiesFromLegacyIndex(JSON.parse(originalIndex.toString("utf8")));
  if (JSON.stringify(manifest.source.artifacts) !== JSON.stringify(expectedSources)) {
    throw new TypeError("verifier diagnostic repair source identity mismatch");
  }
  const repairedIndexRef = path.join(relative, DIAGNOSTICS_INDEX_REF).split(path.sep).join("/");
  const repairedIndex = await readContained(canonicalBase, repairedIndexRef, MAX_INDEX_BYTES);
  if (sha256Bytes(repairedIndex) !== manifest.repaired.diagnostics_index_sha256) {
    throw new TypeError("verifier diagnostic repair index digest mismatch");
  }
  const repairedValue = JSON.parse(repairedIndex.toString("utf8")) as Record<string, unknown>;
  if (repairedValue.schema_version !== "2" || repairedValue.kind !== "verifier-diagnostics"
    || !Array.isArray(repairedValue.artifacts) || !Array.isArray(repairedValue.losses)
    || repairedValue.losses.length !== 0) {
    throw new TypeError("verifier diagnostic repair index is incomplete");
  }
  return {
    directory: path.join(canonicalBase, relative),
    manifest,
    repair_sha256: sha256Bytes(manifestBytes),
  };
}

async function canonicalStateRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("Hitch state root is unsafe");
  const canonical = await realpath(resolved);
  const canonicalInfo = await lstat(canonical);
  if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory()) throw new TypeError("Hitch state root is unsafe");
  return canonical;
}

export function sourceIdentitiesFromLegacyIndex(value: unknown): VerifierDiagnosticSourceIdentityV1[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("verifier diagnostics index is invalid");
  const index = value as Record<string, unknown>;
  if (index.schema_version !== "1" || index.kind !== "verifier-diagnostics" || !Array.isArray(index.artifacts)) {
    throw new TypeError("verifier diagnostics repair requires a legacy index");
  }
  const seen = new Set<string>();
  const artifacts = index.artifacts.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("legacy verifier diagnostic artifact is invalid");
    const artifact = raw as Record<string, unknown>;
    const name = artifact.name;
    if (typeof name !== "string" || !ARTIFACT_NAMES.has(name) || seen.has(name)
      || artifact.ref !== `verifier/${name}` || typeof artifact.truncated !== "boolean"
      || !Number.isSafeInteger(artifact.source_bytes) || Number(artifact.source_bytes) < 0
      || typeof artifact.source_sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(artifact.source_sha256)) {
      throw new TypeError("legacy verifier diagnostic artifact identity is invalid");
    }
    seen.add(name);
    return {
      name: name as VerifierArtifactExcerptV1["name"],
      bytes: Number(artifact.source_bytes),
      sha256: artifact.source_sha256 as Sha256,
    };
  });
  return artifacts.sort((left, right) => left.name.localeCompare(right.name));
}

export function legacyIndexNeedsDiagnosticRepair(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const index = value as Record<string, unknown>;
  return index.schema_version === "1" && Array.isArray(index.artifacts)
    && index.artifacts.some((raw) => Boolean(raw && typeof raw === "object" && !Array.isArray(raw) && (raw as Record<string, unknown>).truncated === true));
}

async function readContained(root: string, relative: string, maximumBytes: number): Promise<Buffer> {
  const opened = await openContainedRegularFile(root, relative, maximumBytes);
  try {
    const bytes = Buffer.allocUnsafe(opened.size);
    let position = 0;
    while (position < bytes.length) {
      const read = await opened.handle.read(bytes, position, bytes.length - position, position);
      if (read.bytesRead === 0) throw new TypeError("verifier diagnostic evidence changed while being read");
      position += read.bytesRead;
    }
    if ((await opened.handle.read(Buffer.allocUnsafe(1), 0, 1, bytes.length)).bytesRead !== 0) {
      throw new TypeError("verifier diagnostic evidence changed while being read");
    }
    await opened.assertUnchanged();
    return bytes;
  } finally {
    await opened.handle.close();
  }
}

function parseVerifierDiagnosticRepairManifest(value: unknown): VerifierDiagnosticRepairManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("verifier diagnostic repair manifest is invalid");
  const record = value as Record<string, unknown>;
  exact(record, ["schema_version", "kind", "run_id", "parent", "original", "source", "repaired", "created_at"]);
  if (record.schema_version !== "1" || record.kind !== "verifier-diagnostics-repair"
    || typeof record.run_id !== "string" || !/^run_[a-f0-9]{32}$/.test(record.run_id)
    || typeof record.created_at !== "string" || !Number.isFinite(Date.parse(record.created_at))) {
    throw new TypeError("verifier diagnostic repair manifest identity is invalid");
  }
  const parent = object(record.parent, "verifier diagnostic repair parent");
  exact(parent, ["eval_id", "trial_id", "attempt", "task_id"]);
  if (typeof parent.eval_id !== "string" || !/^eval_[a-f0-9]{32}$/.test(parent.eval_id)
    || typeof parent.trial_id !== "string" || !parent.trial_id || typeof parent.task_id !== "string" || !parent.task_id
    || !Number.isSafeInteger(parent.attempt) || Number(parent.attempt) < 1) throw new TypeError("verifier diagnostic repair parent is invalid");
  const original = object(record.original, "verifier diagnostic repair original identity");
  exact(original, ["bundle_digest", "bundle_index_sha256", "diagnostics_index_sha256"]);
  const source = object(record.source, "verifier diagnostic repair source");
  exact(source, ["kind", "relative_trial_directory", "artifacts"]);
  const repaired = object(record.repaired, "verifier diagnostic repair output");
  exact(repaired, ["diagnostics_index_sha256"]);
  for (const digest of [original.bundle_digest, original.bundle_index_sha256, original.diagnostics_index_sha256, repaired.diagnostics_index_sha256]) {
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new TypeError("verifier diagnostic repair digest is invalid");
  }
  if (source.kind !== "harbor-trial" || typeof source.relative_trial_directory !== "string"
    || !validRelativePath(source.relative_trial_directory) || !Array.isArray(source.artifacts)) {
    throw new TypeError("verifier diagnostic repair source is invalid");
  }
  const artifacts = source.artifacts.map((raw) => {
    const artifact = object(raw, "verifier diagnostic repair source artifact");
    exact(artifact, ["name", "bytes", "sha256"]);
    if (typeof artifact.name !== "string" || !ARTIFACT_NAMES.has(artifact.name)
      || !Number.isSafeInteger(artifact.bytes) || Number(artifact.bytes) < 0
      || typeof artifact.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(artifact.sha256)) {
      throw new TypeError("verifier diagnostic repair source artifact is invalid");
    }
    return { name: artifact.name as VerifierArtifactExcerptV1["name"], bytes: Number(artifact.bytes), sha256: artifact.sha256 as Sha256 };
  });
  const canonical = [...artifacts].sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(artifacts.map((entry) => entry.name)).size !== artifacts.length || JSON.stringify(canonical) !== JSON.stringify(artifacts)) {
    throw new TypeError("verifier diagnostic repair source artifacts are not canonical");
  }
  return {
    schema_version: "1", kind: "verifier-diagnostics-repair", run_id: record.run_id,
    parent: { eval_id: parent.eval_id, trial_id: parent.trial_id, attempt: Number(parent.attempt), task_id: parent.task_id },
    original: {
      bundle_digest: original.bundle_digest as Sha256,
      bundle_index_sha256: original.bundle_index_sha256 as Sha256,
      diagnostics_index_sha256: original.diagnostics_index_sha256 as Sha256,
    },
    source: { kind: "harbor-trial", relative_trial_directory: source.relative_trial_directory, artifacts },
    repaired: { diagnostics_index_sha256: repaired.diagnostics_index_sha256 as Sha256 },
    created_at: record.created_at,
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).some((field) => !fields.includes(field))) throw new TypeError("verifier diagnostic repair has unknown fields");
}

function validRelativePath(value: string): boolean {
  return value === value.normalize("NFC") && !path.posix.isAbsolute(value) && !value.includes("\\")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
