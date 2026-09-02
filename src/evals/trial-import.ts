import { validateEvalTrialReferences } from "./trial-reference-validation.js";
export { validateEvalTrialReferences } from "./trial-reference-validation.js";
import { cp, lstat, mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJSON, credentialValuesFromEnv, ensureDir, readJSON, safeDiagnosticMessage, statePaths, writePrivateFile } from "../foundation/index.js";
import type { ResolvedRevision } from "../artifacts/index.js";
import { validateRunContext } from "../domain/index.js";
import type { EvalRequest, EvalTrialRefV1, ExecutionEvidenceV1, ModelCapturePlanV1, RunObservationV1, Sha256 } from "../domain/index.js";
import { newRunId, safeAgentArgsForPersistence } from "../runs/index.js";
import {
  benchmarkTaskDigest,
  benchmarkVerifierIdentity,
  defaultModelIdentity,
  loadRunRecord,
  projectRunRecord,
  sha256JSON,
  writeResultBundleIndex,
} from "../runs/index.js";
import { readHarborBridgeError } from "./harbor-bridge-error.js";
import { detectVerifierInfrastructureFailure, primaryVerifierReward, verifierObservation, verifierResult, writeVerifierInfrastructureDiagnostic } from "./verifier-diagnostics.js";
import { writeTrialExecutionEvidence } from "./trial-execution-evidence.js";
import { writeTrialEnvironmentImageEvidence } from "./trial-environment-evidence.js";
import type { TrialEnvironmentImagesV1 } from "./trial-environment-evidence.js";
import type { EvalInteractionCaptureExporter } from "./service-types.js";
import { importTrialInteractionCapture, writeTrialCapturePolicy } from "./interaction-capture-import.js";
import { lockedHarborTaskId, nonEmptyString, trialAttemptFromId } from "./trial-import-identity.js";
import { writeEvalTrialPublication } from "./trial-publication.js";
import type { EvalTrialPublicationMode } from "./trial-publication.js";
import { importNativePhaseTrial, nativePhaseDescriptor, NativePhaseBundlePendingError } from "./native-phase-evidence.js";
export interface ImportEvalRunsOptions {
  root: string;
  evalId: string;
  evalDirectory: string;
  request: EvalRequest;
  resolvedRevision: ResolvedRevision;
  benchmarkId: string;
  benchmarkRevision: string;
  runtimeId?: string;
  harborJobDirectory?: string;
  expectedAttempt?: number;
  rawResult: Record<string, unknown> | null;
  executionEvidence?: ExecutionEvidenceV1;
  environmentImages?: TrialEnvironmentImagesV1;
  modelCapturePlan?: ModelCapturePlanV1;
  interactionCaptureExporter?: EvalInteractionCaptureExporter;
  publicationMode?: EvalTrialPublicationMode;
  env?: NodeJS.ProcessEnv;
}

export interface ImportEvalRunOptions extends Omit<ImportEvalRunsOptions, "rawResult"> {
  requireCompleteMarker?: boolean;
  allowMissingBundleDiagnostic?: boolean;
}
export async function importEvalTrialRuns(
  options: ImportEvalRunsOptions,
  existingRefs: readonly EvalTrialRefV1[] = [],
): Promise<EvalTrialRefV1[]> {
  const trials = Array.isArray(options.rawResult?.trial_results)
    ? options.rawResult.trial_results as Record<string, unknown>[]
    : [];
  const refs: EvalTrialRefV1[] = [...existingRefs];
  for (const [index, trial] of trials.entries()) {
    const ref = await importEvalTrialRun(options, trial, index, refs);
    if (!refs.some((current) => current.trial_id === ref.trial_id)) refs.push(ref);
  }
  return refs;
}

export async function importEvalTrialRun(
  options: ImportEvalRunOptions,
  trial: Record<string, unknown>,
  index = 0,
  existingRefs: readonly EvalTrialRefV1[] = [],
): Promise<EvalTrialRefV1> {
  const fallbackTaskId = nonEmptyString(trial.task_name) || `trial-${index + 1}`;
  const trialId = nonEmptyString(trial.trial_name) || `${fallbackTaskId}__${index + 1}`;
  const attempt = options.expectedAttempt ?? trialAttemptFromId(trialId);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError("expected eval attempt must be a positive safe integer");
  const trialDirectory = path.join(options.harborJobDirectory ?? path.join(options.evalDirectory, "harbor", "job"), trialId);
  const taskId = await lockedHarborTaskId(trialDirectory) || fallbackTaskId;
  const existing = existingRefs.find((ref) => ref.trial_id === trialId);
  if (existing !== undefined) {
    if (existing.task_id !== taskId || existing.attempt !== attempt) throw new TrialIdentityConflictError(`existing eval trial identity changed: ${trialId}`);
    await validateEvalTrialReferences(options.root, options.evalId, [existing], {
      benchmarkId: options.benchmarkId,
      benchmarkRevision: options.benchmarkRevision,
    });
    return existing;
  }
  let bundle: string | null = null;
  let published = false;
  try {
    const descriptor = await nativePhaseDescriptor(options, taskId);
    if (descriptor) return await importNativePhaseTrial({ ...options, trial, taskId, trialId, attempt, trialDirectory }, descriptor);
    bundle = await findRunBundle(trialDirectory, 0, options.requireCompleteMarker === true);
    if (options.requireCompleteMarker && !bundle && !options.allowMissingBundleDiagnostic) throw new TrialBundlePendingError(trialId);
    const ref = bundle
      ? await importRunBundle({ ...options, trial, taskId, trialId, attempt, trialDirectory, bundle })
      : await createDiagnosticRun({ ...options, trial, taskId, trialId, attempt, trialDirectory });
    published = bundle !== null;
    return ref;
  } catch (error) {
    if (error instanceof NativePhaseBundlePendingError) throw new TrialBundlePendingError(trialId);
    if (error instanceof TrialBundlePendingError || error instanceof TrialIdentityConflictError) throw error;
    const safeMessage = safeDiagnosticMessage(error, credentialValuesFromEnv(options.request.pass_env ?? [], options.env ?? process.env));
    {
      await atomicWriteJSON(path.join(bundle ? path.dirname(bundle) : trialDirectory, "hitch-run-import-error.json"), {
        schema_version: "1",
        trial_id: trialId,
        code: "run_bundle_import_failed",
        message: safeMessage,
        recorded_at: new Date().toISOString(),
      }).catch(() => {});
    }
    return createDiagnosticRun({
      ...options,
      trial: {
        ...trial,
        exception_info: "hitch-run-bundle-import-failed",
        hitch_import_error: safeMessage,
      },
      taskId,
      trialId,
      attempt,
      trialDirectory,
    });
  } finally {
    if (bundle && published && isWithin(options.evalDirectory, bundle)) {
      await rm(bundle, { recursive: true, force: true });
    }
  }
}
export class TrialBundlePendingError extends Error {
  constructor(readonly trialId: string) {
    super(`Harbor trial bundle is not ready: ${trialId}`);
    this.name = "TrialBundlePendingError";
  }
}
export class TrialIdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrialIdentityConflictError";
  }
}

interface TrialInput extends ImportEvalRunOptions {
  trial: Record<string, unknown>;
  taskId: string;
  trialId: string;
  attempt: number;
  trialDirectory: string;
}

async function importRunBundle(input: TrialInput & { bundle: string }): Promise<EvalTrialRefV1> {
  await validateBundleTree(input.bundle);
  const manifestValue = await readJSON(path.join(input.bundle, "manifest.json"));
  const record = projectRunRecord(manifestValue);
  if (!/^run_[a-f0-9]{32}$/.test(record.run_id)) throw new Error(`invalid exported run_id: ${record.run_id}`);
  const marker = await readJSON<Record<string, unknown> | null>(path.join(input.bundle, "bundle.complete.json"), null).catch(() => null);
  if (marker !== null && (marker.schema_version !== "1" || marker.run_id !== record.run_id
    || marker.eval_id !== input.evalId || marker.trial_id !== input.trialId)) {
    throw new Error(`exported run ${record.run_id} has a mismatched completion marker`);
  }
  const context = validateRunContext(record.context);
  if (
    context.kind !== "benchmark_task"
    || context.benchmark_id !== input.benchmarkId
    || context.benchmark_revision !== input.benchmarkRevision
    || context.task_id !== input.taskId
  ) {
    throw new Error(`exported run ${record.run_id} has a mismatched benchmark context`);
  }
  const expectedVerifier = benchmarkVerifierIdentity(input.benchmarkId, input.benchmarkRevision);
  if (context.verifier_identity !== expectedVerifier) throw new Error(`exported run ${record.run_id} has a mismatched verifier identity`);
  if (
    record.parent?.eval_id !== input.evalId
    || record.parent.trial_id !== input.trialId
    || record.parent.attempt !== input.attempt
  ) {
    throw new Error(`exported run ${record.run_id} has a mismatched eval parent`);
  }

  const destination = path.join(statePaths(input.root).runs, record.run_id);
  try {
    await stat(destination);
    const existing = await loadRunRecord(destination, { verifyTrajectory: true });
    if (existing.record.parent?.eval_id !== input.evalId
      || existing.record.parent.trial_id !== input.trialId
      || existing.record.parent.attempt !== input.attempt
      || existing.record.context.kind !== "benchmark_task"
      || existing.record.context.benchmark_id !== input.benchmarkId
      || existing.record.context.benchmark_revision !== input.benchmarkRevision
      || existing.record.context.task_id !== input.taskId
      || existing.record.observation === undefined) throw new TrialIdentityConflictError(`existing run destination conflicts: ${record.run_id}`);
    return evalTrialRef(input, record.run_id, existing.record.observation);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const stagingParent = await mkdtemp(path.join(await ensureDir(statePaths(input.root).temporary), "eval-run-import-"));
  const staging = path.join(stagingParent, record.run_id);
  try {
    await cp(input.bundle, staging, { recursive: true, errorOnExist: true, force: false });
    await rm(path.join(staging, "bundle.complete.json"), { force: true });
    await rm(path.join(staging, "bundle.index.json"), { force: true });
    await readJSON(path.join(staging, "resolution.json"));
    await validateJSONLines(path.join(staging, "events.jsonl"));
    await importTrialInteractionCapture(input, record.run_id, staging);
    const verifier = verifierResult(input.trial);
    const verifierRef = verifier ? "verifier/result.json" : undefined;
    if (verifier) await atomicWriteJSON(path.join(staging, verifierRef as string), verifier);
    const verifierInfrastructure = await detectVerifierInfrastructureFailure(
      input.trialDirectory,
      primaryVerifierReward(input.trial),
    );
    if (verifierInfrastructure) await writeVerifierInfrastructureDiagnostic(staging, verifierInfrastructure);
    await copyVerifierRetryHistory(input.trialDirectory, staging);
    const beforeObservation = await loadRunRecord(staging, { verifyTrajectory: true });
    const observation = verifierObservation({
      trial: input.trial,
      runStatus: beforeObservation.record.status,
      trajectoryStatus: beforeObservation.trajectory_status,
      recordStatus: beforeObservation.record_status,
      verifierRef,
      infrastructure: verifierInfrastructure,
    });
    const manifest = await readJSON<Record<string, unknown>>(path.join(staging, "manifest.json"));
    const portableManifest = withoutKeys(manifest, [
      "workspace", "source_workspace", "execution_workspace",
      "managed_workspace", "executable", "artifact_entrypoint",
    ]);
    const request = await readJSON<Record<string, unknown>>(path.join(staging, "request.json"));
    await atomicWriteJSON(path.join(staging, "request.json"), { ...request, cwd: "." });
    const result = await readJSON<Record<string, unknown>>(path.join(staging, "result.json"));
    await atomicWriteJSON(path.join(staging, "result.json"), withoutKeys(result, ["workspace"]));
    await writeTrialExecutionEvidence(staging, input.executionEvidence, { evalId: input.evalId, taskId: input.taskId });
    await writeTrialEnvironmentImageEvidence(staging, input.taskId, input.environmentImages);
    await atomicWriteJSON(path.join(staging, "manifest.json"), {
      ...portableManifest,
      observation,
      result_ref: "result.json",
      ...(manifest.trajectory_ref ? {} : { trajectory_ref: "trajectory.ref.json" }),
      sealed: true,
    });
    const ref = evalTrialRef(input, record.run_id, observation);
    await writeEvalTrialPublication(staging, input.evalId, input.publicationMode ?? "settle", ref);
    await writeResultBundleIndex(staging);
    const verified = await loadRunRecord(staging, { verifyTrajectory: true });
    if (verified.record.observation?.status !== observation.status) throw new Error(`failed to seal observation for ${record.run_id}`);
    await ensureDir(path.dirname(destination));
    try {
      await stat(destination);
      throw new TrialIdentityConflictError(`run destination already exists: ${record.run_id}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(staging, destination);
    return ref;
  } finally {
    await rm(stagingParent, { recursive: true, force: true });
  }
}

async function createDiagnosticRun(input: TrialInput): Promise<EvalTrialRefV1> {
  const runId = newRunId();
  const destination = path.join(statePaths(input.root).runs, runId);
  const stagingParent = await mkdtemp(path.join(await ensureDir(statePaths(input.root).temporary), "eval-run-diagnostic-"));
  const runDirectory = await ensureDir(path.join(stagingParent, runId));
  const now = new Date().toISOString();
  try {
    const verifier = verifierResult(input.trial);
    const verifierRef = verifier ? "verifier/result.json" : undefined;
    if (verifier) await atomicWriteJSON(path.join(runDirectory, verifierRef as string), verifier);
    const verifierInfrastructure = await detectVerifierInfrastructureFailure(
      input.trialDirectory,
      primaryVerifierReward(input.trial),
    );
    if (verifierInfrastructure) await writeVerifierInfrastructureDiagnostic(runDirectory, verifierInfrastructure);
    await copyVerifierRetryHistory(input.trialDirectory, runDirectory);
    const bridgeError = input.trial.exception_info
      ? await readHarborBridgeError(
        input.trialDirectory,
        credentialValuesFromEnv(input.request.pass_env ?? [], input.env ?? process.env),
      )
      : null;
    const bridgeErrorRef = bridgeError ? "diagnostics/harbor-bridge-error.json" : undefined;
    if (bridgeError && bridgeErrorRef) {
      await ensureDir(path.dirname(path.join(runDirectory, bridgeErrorRef)));
      await writePrivateFile(
        path.join(runDirectory, bridgeErrorRef),
        bridgeError.raw.endsWith("\n") ? bridgeError.raw : `${bridgeError.raw}\n`,
      );
    }
    const reason = verifierInfrastructure
      ? "verifier_infrastructure_failure"
      : input.trial.exception_info
      ? "infrastructure_failure"
      : verifier ? "trajectory_missing_or_corrupt" : "verifier_result_missing";
    const observation: RunObservationV1 = {
      status: "invalid",
      invalid_reason: reason,
      ...(verifierRef ? { verifier_result_ref: verifierRef } : {}),
    };
    const context = {
      kind: "benchmark_task" as const,
      benchmark_id: input.benchmarkId,
      benchmark_revision: input.benchmarkRevision,
      task_id: input.taskId,
      task_digest: benchmarkTaskDigest(input.benchmarkId, input.benchmarkRevision, input.taskId),
      verifier_identity: benchmarkVerifierIdentity(input.benchmarkId, input.benchmarkRevision),
    };
    const safeAgentArgs = safeAgentArgsForPersistence(input.request.agent_args);
    const argsDigest = safeAgentArgs.length ? sha256JSON(safeAgentArgs) : undefined;
    const artifactId = typeof (input.trial.agent_result as Record<string, unknown> | undefined)?.metadata === "object"
      ? ((input.trial.agent_result as { metadata?: { hitch_artifact_id?: unknown } }).metadata?.hitch_artifact_id as string | undefined)
      : undefined;
    await atomicWriteJSON(path.join(runDirectory, "request.json"), {
      schema_version: "1",
      context,
      parent: { kind: "eval", eval_id: input.evalId, trial_id: input.trialId, attempt: input.attempt },
      task_id: input.taskId,
      prompt: null,
      diagnostic: "trial bundle was not exported",
    });
    await atomicWriteJSON(path.join(runDirectory, "resolution.json"), input.resolvedRevision);
    await writeTrialExecutionEvidence(runDirectory, input.executionEvidence, { evalId: input.evalId, taskId: input.taskId });
    await writeTrialEnvironmentImageEvidence(runDirectory, input.taskId, input.environmentImages);
    await writeTrialCapturePolicy(runDirectory, input.modelCapturePlan);
    await writePrivateFile(path.join(runDirectory, "events.jsonl"), `${JSON.stringify({
      schema_version: "1",
      sequence: 1,
      timestamp: now,
      run_id: runId,
      type: "eval.trial.import_failed",
      reason,
      ...(bridgeError ? { bridge_error_code: bridgeError.code } : {}),
    })}\n`);
    await atomicWriteJSON(path.join(runDirectory, "result.json"), {
      schema_version: "1",
      run_id: runId,
      status: "failed",
      exit_code: 12,
      error: bridgeError
        ? { code: bridgeError.code, message: bridgeError.message }
        : { code: reason, message: "Harbor trial completed without an importable Hitch run bundle" },
      completed_at: now,
    });
    await atomicWriteJSON(path.join(runDirectory, "manifest.json"), {
      schema_version: "1",
      run_id: runId,
      context,
      parent: { kind: "eval", eval_id: input.evalId, trial_id: input.trialId, attempt: input.attempt },
      status: "failed",
      harness: {
        harness_id: input.resolvedRevision.harness_id,
        requested_ref: input.request.harness_ref,
        revision_identity: input.resolvedRevision.identity,
        ...(artifactId && /^sha256:[0-9a-f]{64}$/.test(artifactId) ? { artifact_id: artifactId } : {}),
        ...(argsDigest ? { agent_args_sha256: argsDigest } : {}),
      },
      model: defaultModelIdentity(input.request.model, input.resolvedRevision.harness_id),
      protocol: {
        timeout_ms: input.request.timeout_ms,
        workspace_mode: "shared",
        ...(input.runtimeId && /^sha256:[0-9a-f]{64}$/.test(input.runtimeId)
          ? { environment_identity: input.runtimeId as Sha256 }
          : {}),
      },
      observation,
      request_ref: "request.json",
      resolution_ref: "resolution.json",
      result_ref: "result.json",
      created_at: now,
      completed_at: now,
      sealed: true,
      ...(bridgeErrorRef ? { diagnostics: { harbor_bridge_error_ref: bridgeErrorRef } } : {}),
    });
    const ref = evalTrialRef(input, runId, observation);
    await writeEvalTrialPublication(runDirectory, input.evalId, input.publicationMode ?? "settle", ref);
    await writeResultBundleIndex(runDirectory);
    await ensureDir(path.dirname(destination));
    try {
      await stat(destination);
      throw new TrialIdentityConflictError(`run destination already exists: ${runId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(runDirectory, destination);
    return ref;
  } finally {
    await rm(stagingParent, { recursive: true, force: true });
  }
}

function evalTrialRef(input: TrialInput, runId: string, observation: RunObservationV1): EvalTrialRefV1 {
  return {
    trial_id: input.trialId,
    run_id: runId,
    task_id: input.taskId,
    attempt: input.attempt,
    observation_status: observation.status,
    ...(observation.reward !== undefined ? { reward: observation.reward } : {}),
    ...(observation.verifier_result_ref ? { verifier_result_ref: observation.verifier_result_ref } : {}),
    ...(observation.invalid_reason ? { invalid_reason: observation.invalid_reason } : {}),
  };
}

async function findRunBundle(root: string, depth = 0, requireCompleteMarker = false): Promise<string | null> {
  if (depth > 5) return null;
  try {
    const manifest = path.join(root, "manifest.json");
    if ((await lstat(manifest)).isFile() && path.basename(root) === "hitch-run-bundle") {
      if (!requireCompleteMarker) return root;
      const marker = await readJSON<Record<string, unknown> | null>(path.join(root, "bundle.complete.json"), null).catch(() => null);
      return marker?.schema_version === "1" && typeof marker.run_id === "string" ? root : null;
    }
  } catch { /* Continue scanning. */ }
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const found = await findRunBundle(path.join(root, entry.name), depth + 1, requireCompleteMarker);
    if (found) return found;
  }
  return null;
}

async function validateBundleTree(root: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error(`run bundle contains a symbolic link: ${path.relative(root, target)}`);
      if (info.isDirectory()) {
        await walk(target);
      } else if (info.isFile()) {
        files += 1;
        bytes += info.size;
        if (files > 100_000 || bytes > 1024 * 1024 * 1024) throw new Error("run bundle exceeds import limits");
      } else {
        throw new Error(`run bundle contains a special file: ${path.relative(root, target)}`);
      }
    }
  };
  await walk(root);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function withoutKeys(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result = { ...record };
  for (const key of keys) delete result[key];
  return result;
}

async function copyVerifierRetryHistory(trialDirectory: string, runDirectory: string): Promise<void> {
  const source = path.join(trialDirectory, "verifier", "infrastructure-retry-history.json");
  const history = await readJSON<Record<string, unknown> | null>(source, null).catch(() => null);
  if (history?.schema_version !== "1"
    || history.code !== "verifier_infrastructure_retry_history"
    || history.candidate_rerun !== false
    || !Array.isArray(history.attempts)) return;
  await atomicWriteJSON(path.join(runDirectory, "verifier", "infrastructure-retry-history.json"), history);
}

async function validateJSONLines(file: string): Promise<void> {
  const content = await readFile(file, "utf8");
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line) continue;
    try { JSON.parse(line); } catch (error) {
      throw new Error(`invalid JSONL at ${path.basename(file)}:${index + 1}: ${(error as Error).message}`);
    }
  }
}
