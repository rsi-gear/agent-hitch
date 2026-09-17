import { lstat, mkdir, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Sha256 } from "../domain/index.js";
import { validateRelativePath } from "../domain/index.js";
import { HitchError, PROVIDER_ENVIRONMENT_NAMES, atomicWriteJSON, credentialValuesFromEnv, ensureDir, openContainedRegularFile, sha256Bytes, statePaths, withFileLock } from "../foundation/index.js";
import {
  legacyIndexNeedsDiagnosticRepair,
  loadRunRecord,
  loadVerifierDiagnosticSupplement,
  loadVerifierEvidence,
  sourceIdentitiesFromLegacyIndex,
  verifierDiagnosticSupplementRelative,
  verifyResultBundleIndex,
} from "../runs/index.js";
import type { VerifierDiagnosticRepairManifestV1 } from "../runs/index.js";
import { captureVerifierDiagnostics } from "./verifier-artifacts.js";

const DIAGNOSTICS_INDEX_REF = "verifier/diagnostics.json";
const MAX_INDEX_BYTES = 16 * 1024 * 1024;

export interface RepairVerifierDiagnosticsOptions {
  root: string;
  runId: string;
  source?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface RepairVerifierDiagnosticsResultV1 {
  schema_version: "1";
  kind: "verifier-diagnostics-repair-result";
  run_id: string;
  status: "repaired" | "already_repaired" | "not_needed";
  repair_sha256?: Sha256;
  diagnostics_index_sha256?: Sha256;
}

export async function repairVerifierDiagnostics(
  options: RepairVerifierDiagnosticsOptions,
): Promise<RepairVerifierDiagnosticsResultV1> {
  const { root, runId } = options;
  if (!/^run_[a-f0-9]{32}$/.test(runId)) throw new TypeError(`invalid run ID: ${runId}`);
  const stateRoot = await canonicalStateRoot(root);
  const runDirectory = path.join(statePaths(stateRoot).runs, runId);
  const runRoot = await safeDirectory(runDirectory, "run");
  const loaded = await loadRunRecord(runRoot, { verifyTrajectory: false });
  const parent = loaded.record.parent;
  if (!parent || !/^eval_[a-f0-9]{32}$/.test(parent.eval_id) || loaded.record.context.kind !== "benchmark_task") {
    throw repairError("run has no supported Harbor eval parent", "verifier_diagnostic_repair_unsupported");
  }
  const evidence = await loadVerifierEvidence(stateRoot, runId, { env: options.env ?? process.env });
  if (evidence.verifier.status === "corrupt") {
    throw repairError("run verifier evidence is corrupt", "verifier_evidence_corrupt");
  }
  const bundle = await verifyResultBundleIndex(runRoot);
  const bundleIndexSha256 = sha256Bytes(await readContained(runRoot, "bundle.index.json", MAX_INDEX_BYTES));
  const originalIndexBytes = await readContained(runRoot, DIAGNOSTICS_INDEX_REF, MAX_INDEX_BYTES).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw repairError("run has no indexed verifier diagnostics", "verifier_diagnostic_repair_unsupported");
    }
    throw error;
  });
  const originalIndex = JSON.parse(originalIndexBytes.toString("utf8")) as unknown;
  if (!legacyIndexNeedsDiagnosticRepair(originalIndex)) {
    if (hasExplicitV2Losses(originalIndex)) {
      throw repairError(
        "version 2 diagnostics contain explicit source loss and cannot be safely reconstructed",
        "verifier_diagnostic_repair_source_unavailable",
      );
    }
    return { schema_version: "1", kind: "verifier-diagnostics-repair-result", run_id: runId, status: "not_needed" };
  }
  if (hasRetiredCredentialRedactions(originalIndex)) {
    throw repairError(
      "legacy diagnostics used credential-value redaction that cannot be safely reproduced",
      "verifier_diagnostic_repair_credentials_required",
    );
  }
  const originalIndexSha256 = sha256Bytes(originalIndexBytes);
  const existing = await loadVerifierDiagnosticSupplement(stateRoot, runRoot, runId).catch((error) => {
    throw repairError("existing verifier diagnostic repair is corrupt", "verifier_diagnostic_repair_conflict", error);
  });
  if (existing) return {
    schema_version: "1", kind: "verifier-diagnostics-repair-result", run_id: runId,
    status: "already_repaired", repair_sha256: existing.repair_sha256,
    diagnostics_index_sha256: existing.manifest.repaired.diagnostics_index_sha256,
  };

  const sourceIdentities = sourceIdentitiesFromLegacyIndex(originalIndex);
  const evalDirectory = path.join(statePaths(stateRoot).evals, parent.eval_id);
  const relativeSource = await resolveSource(evalDirectory, parent.trial_id, parent.attempt, options.source);
  const sourceDirectory = await safeRelativeDirectory(evalDirectory, relativeSource);
  const temporaryRoot = await ensureSafeRelativeDirectory(stateRoot, "tmp");
  const temporaryParent = await mkdtemp(path.join(temporaryRoot, "verifier-diagnostics-repair-"));
  const staging = path.join(temporaryParent, "supplement");
  await ensureDir(staging);
  try {
    const request = JSON.parse((await readContained(runRoot, loaded.record.request_ref, MAX_INDEX_BYTES)).toString("utf8")) as Record<string, unknown>;
    const credentialNames = Array.isArray(request.credential_names)
      ? request.credential_names.filter((entry): entry is string => typeof entry === "string") : [];
    const credentialValues = credentialValuesFromEnv([...PROVIDER_ENVIRONMENT_NAMES, ...credentialNames], options.env ?? process.env);
    const captured = await captureVerifierDiagnostics(sourceDirectory, staging, {
      credentialValues,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!captured || captured.losses.length > 0) {
      throw repairError("Harbor verifier diagnostics cannot be fully persisted", "verifier_diagnostic_repair_source_unavailable");
    }
    const capturedSources = captured.artifacts.map((artifact) => ({
      name: artifact.name, bytes: artifact.source_bytes, sha256: artifact.source_sha256,
    })).sort((left, right) => left.name.localeCompare(right.name));
    if (JSON.stringify(capturedSources) !== JSON.stringify(sourceIdentities)) {
      throw repairError("Harbor verifier diagnostics do not match the sealed source digests", "verifier_diagnostic_repair_source_mismatch");
    }
    const repairedIndexSha256 = sha256Bytes(await readContained(staging, DIAGNOSTICS_INDEX_REF, MAX_INDEX_BYTES));
    const currentBundle = await verifyResultBundleIndex(runRoot);
    const currentBundleIndexSha256 = sha256Bytes(await readContained(runRoot, "bundle.index.json", MAX_INDEX_BYTES));
    const currentOriginalIndexSha256 = sha256Bytes(await readContained(runRoot, DIAGNOSTICS_INDEX_REF, MAX_INDEX_BYTES));
    if (currentBundle.bundle_digest !== bundle.bundle_digest || currentBundleIndexSha256 !== bundleIndexSha256
      || currentOriginalIndexSha256 !== originalIndexSha256) {
      throw repairError("sealed verifier evidence changed during repair", "verifier_diagnostic_repair_conflict");
    }
    const manifest: VerifierDiagnosticRepairManifestV1 = {
      schema_version: "1",
      kind: "verifier-diagnostics-repair",
      run_id: runId,
      parent: {
        eval_id: parent.eval_id,
        trial_id: parent.trial_id,
        attempt: parent.attempt,
        task_id: loaded.record.context.task_id,
      },
      original: {
        bundle_digest: bundle.bundle_digest,
        bundle_index_sha256: bundleIndexSha256,
        diagnostics_index_sha256: originalIndexSha256,
      },
      source: {
        kind: "harbor-trial",
        relative_trial_directory: relativeSource,
        artifacts: sourceIdentities,
      },
      repaired: { diagnostics_index_sha256: repairedIndexSha256 },
      created_at: new Date().toISOString(),
    };
    await atomicWriteJSON(path.join(staging, "repair.json"), manifest);
    const relativeDestination = verifierDiagnosticSupplementRelative(runId, originalIndexSha256);
    const destinationParent = await ensureSafeRelativeDirectory(
      stateRoot,
      path.posix.join("derived", "verifier-diagnostics", runId),
    );
    const destination = path.join(destinationParent, path.basename(relativeDestination));
    const lockDirectory = await ensureSafeRelativeDirectory(stateRoot, path.posix.join("locks", "verifier-diagnostics"));
    const result = await withFileLock(
      lockDirectory,
      runId,
      async (): Promise<RepairVerifierDiagnosticsResultV1> => {
        const already = await loadVerifierDiagnosticSupplement(stateRoot, runRoot, runId).catch((error) => {
          throw repairError("existing verifier diagnostic repair is corrupt", "verifier_diagnostic_repair_conflict", error);
        });
        if (already) return {
          schema_version: "1", kind: "verifier-diagnostics-repair-result", run_id: runId,
          status: "already_repaired", repair_sha256: already.repair_sha256,
          diagnostics_index_sha256: already.manifest.repaired.diagnostics_index_sha256,
        };
        try {
          await stat(destination);
          throw repairError("verifier diagnostic repair destination already exists", "verifier_diagnostic_repair_conflict");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rename(staging, destination);
        const published = await loadVerifierDiagnosticSupplement(stateRoot, runRoot, runId);
        if (!published) throw repairError("verifier diagnostic repair publication is missing", "verifier_diagnostic_repair_conflict");
        return {
          schema_version: "1", kind: "verifier-diagnostics-repair-result", run_id: runId,
          status: "repaired", repair_sha256: published.repair_sha256,
          diagnostics_index_sha256: published.manifest.repaired.diagnostics_index_sha256,
        };
      },
      { timeoutCode: "verifier_diagnostic_repair_locked", timeoutExitCode: 12, ...(options.signal ? { signal: options.signal } : {}) },
    );
    return result;
  } finally {
    await rm(temporaryParent, { recursive: true, force: true });
  }
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

function hasExplicitV2Losses(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).schema_version === "2"
    && Array.isArray((value as Record<string, unknown>).losses)
    && ((value as Record<string, unknown>).losses as unknown[]).length > 0);
}

function hasRetiredCredentialRedactions(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const redactions = (value as Record<string, unknown>).redactions;
  if (!Array.isArray(redactions)) return true;
  return redactions.some((entry) => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)
    && (entry as Record<string, unknown>).rule_id === "known-credential-value-v1"));
}

async function resolveSource(evalDirectory: string, trialId: string, attempt: number, requested?: string): Promise<string> {
  const candidates = [
    path.posix.join("harbor", "job", trialId),
    path.posix.join("harbor", `attempt-${String(attempt).padStart(4, "0")}`, "job", trialId),
  ];
  if (requested !== undefined) {
    const normalized = validateRelativePath(requested, "verifier repair source");
    if (!candidates.includes(normalized)) {
      throw repairError("verifier repair source is outside the run's known Harbor trial paths", "verifier_diagnostic_repair_source_mismatch");
    }
    await safeRelativeDirectory(evalDirectory, normalized).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw repairError("Harbor verifier diagnostic source is missing", "verifier_diagnostic_repair_source_unavailable");
      }
      throw error;
    });
    return normalized;
  }
  const available: string[] = [];
  for (const candidate of candidates) {
    try {
      await safeRelativeDirectory(evalDirectory, candidate);
      available.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (available.length === 0) throw repairError("Harbor verifier diagnostic source is missing", "verifier_diagnostic_repair_source_unavailable");
  if (available.length > 1) throw repairError("Harbor verifier diagnostic source is ambiguous", "verifier_diagnostic_repair_source_ambiguous");
  return available[0]!;
}

async function safeRelativeDirectory(root: string, relative: string): Promise<string> {
  const normalized = validateRelativePath(relative, "verifier repair source");
  const canonicalRoot = await safeDirectory(root, "eval");
  let current = canonicalRoot;
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("verifier repair source path is unsafe");
    if (await realpath(current) !== path.resolve(current)) throw new TypeError("verifier repair source path is unsafe");
  }
  return current;
}

async function safeDirectory(directory: string, label: string): Promise<string> {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError(`${label} directory is unsafe`);
  const canonical = await realpath(directory);
  if (canonical !== path.resolve(directory)) throw new TypeError(`${label} directory is unsafe`);
  return canonical;
}

async function ensureSafeRelativeDirectory(root: string, relative: string): Promise<string> {
  const normalized = validateRelativePath(relative, "Hitch state directory");
  let current = await safeDirectory(root, "Hitch state root");
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(current) !== path.resolve(current)) {
      throw new TypeError("Hitch state directory is unsafe");
    }
  }
  return current;
}

async function readContained(root: string, relative: string, maximumBytes: number): Promise<Buffer> {
  const opened = await openContainedRegularFile(root, relative, maximumBytes);
  try {
    const bytes = Buffer.allocUnsafe(opened.size);
    let position = 0;
    while (position < bytes.length) {
      const read = await opened.handle.read(bytes, position, bytes.length - position, position);
      if (read.bytesRead === 0) throw new TypeError("verifier diagnostic repair evidence changed while being read");
      position += read.bytesRead;
    }
    if ((await opened.handle.read(Buffer.allocUnsafe(1), 0, 1, bytes.length)).bytesRead !== 0) {
      throw new TypeError("verifier diagnostic repair evidence changed while being read");
    }
    await opened.assertUnchanged();
    return bytes;
  } finally {
    await opened.handle.close();
  }
}

function repairError(message: string, code: string, cause?: unknown): HitchError {
  return new HitchError(message, { code, exitCode: 12, ...(cause === undefined ? {} : { cause }) });
}
