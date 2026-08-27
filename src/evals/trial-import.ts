import { cp, lstat, mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJSON, ensureDir, readJSON, statePaths, writePrivateFile } from "../foundation/index.js";
import type { ResolvedRevision } from "../artifacts/index.js";
import type { EvalRequest } from "../domain/index.js";
import type { EvalTrialRefV1, RunObservationV1, Sha256 } from "../domain/index.js";
import { validateRunContext } from "../domain/index.js";
import { newRunId, safeAgentArgsForPersistence } from "../runs/index.js";
import {
  benchmarkTaskDigest,
  benchmarkVerifierIdentity,
  defaultModelIdentity,
  loadRunRecord,
  projectRunRecord,
  sha256JSON,
} from "../runs/index.js";
import { readHarborBridgeError } from "./harbor-bridge-error.js";

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
}

export interface ImportEvalRunOptions extends Omit<ImportEvalRunsOptions, "rawResult"> {
  requireCompleteMarker?: boolean;
  allowMissingBundleDiagnostic?: boolean;
}

/** Import every Harbor trial into the authoritative runs/ store. */
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

/** Import one settled Harbor trial, reusing an already-published ref idempotently. */
export async function importEvalTrialRun(
  options: ImportEvalRunOptions,
  trial: Record<string, unknown>,
  index = 0,
  existingRefs: readonly EvalTrialRefV1[] = [],
): Promise<EvalTrialRefV1> {
  // Harbor's result task_name may be display-qualified (for example,
  // terminal-bench/regex-log), while the persisted trial lock contains the
  // canonical task id used by the in-container bridge and exported run.
  const fallbackTaskId = nonEmpty(trial.task_name) || `trial-${index + 1}`;
  const trialId = nonEmpty(trial.trial_name) || `${fallbackTaskId}__${index + 1}`;
  const attempt = options.expectedAttempt ?? trialAttempt(trialId);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError("expected eval attempt must be a positive safe integer");
  const trialDirectory = path.join(options.harborJobDirectory ?? path.join(options.evalDirectory, "harbor", "job"), trialId);
  const taskId = await lockedTaskId(trialDirectory) || fallbackTaskId;
  const existing = existingRefs.find((ref) => ref.trial_id === trialId);
  if (existing !== undefined) {
    if (existing.task_id !== taskId || existing.attempt !== attempt) throw new TrialIdentityConflictError(`existing eval trial identity changed: ${trialId}`);
    await validateEvalTrialReferences(options.root, options.evalId, [existing], {
      benchmarkId: options.benchmarkId,
      benchmarkRevision: options.benchmarkRevision,
    });
    return existing;
  }
  const bundle = await findRunBundle(trialDirectory, 0, options.requireCompleteMarker === true);
  let published = false;
  try {
    if (options.requireCompleteMarker && !bundle && !options.allowMissingBundleDiagnostic) throw new TrialBundlePendingError(trialId);
    const ref = bundle
      ? await importRunBundle({ ...options, trial, taskId, trialId, attempt, trialDirectory, bundle })
      : await createDiagnosticRun({ ...options, trial, taskId, trialId, attempt, trialDirectory });
    published = bundle !== null;
    return ref;
  } catch (error) {
    if (error instanceof TrialBundlePendingError || error instanceof TrialIdentityConflictError) throw error;
    if (bundle) {
      await atomicWriteJSON(path.join(path.dirname(bundle), "hitch-run-import-error.json"), {
        schema_version: "1",
        trial_id: trialId,
        code: "run_bundle_import_failed",
        message: (error as Error).message,
        recorded_at: new Date().toISOString(),
      }).catch(() => {});
    }
    return createDiagnosticRun({
      ...options,
      trial: {
        ...trial,
        exception_info: "hitch-run-bundle-import-failed",
        hitch_import_error: (error as Error).message,
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

async function lockedTaskId(trialDirectory: string): Promise<string | null> {
  const lockPath = path.join(trialDirectory, "lock.json");
  let lock: unknown;
  try {
    lock = await readJSON(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Harbor trial lock is unreadable: ${lockPath}`, { cause: error });
  }
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) {
    throw new Error(`Harbor trial lock is invalid: ${lockPath}`);
  }
  const task = (lock as Record<string, unknown>).task;
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error(`Harbor trial lock has no task.name: ${lockPath}`);
  }
  const taskId = nonEmpty((task as Record<string, unknown>).name);
  if (!taskId) throw new Error(`Harbor trial lock has no task.name: ${lockPath}`);
  return taskId;
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
    await readJSON(path.join(staging, "resolution.json"));
    await validateJSONLines(path.join(staging, "events.jsonl"));
    const verifier = verifierResult(input.trial);
    const verifierRef = verifier ? "verifier/result.json" : undefined;
    if (verifier) await atomicWriteJSON(path.join(staging, verifierRef as string), verifier);
    const beforeObservation = await loadRunRecord(staging, { verifyTrajectory: true });
    const observation = trialObservation(
      input.trial,
      beforeObservation.record.status,
      beforeObservation.trajectory_status,
      beforeObservation.record_status,
      verifierRef,
    );
    const manifest = await readJSON<Record<string, unknown>>(path.join(staging, "manifest.json"));
    const portableManifest = withoutKeys(manifest, [
      "workspace", "source_workspace", "execution_workspace",
      "managed_workspace", "executable", "artifact_entrypoint",
    ]);
    const request = await readJSON<Record<string, unknown>>(path.join(staging, "request.json"));
    await atomicWriteJSON(path.join(staging, "request.json"), { ...request, cwd: "." });
    const result = await readJSON<Record<string, unknown>>(path.join(staging, "result.json"));
    await atomicWriteJSON(path.join(staging, "result.json"), withoutKeys(result, ["workspace"]));
    await atomicWriteJSON(path.join(staging, "manifest.json"), {
      ...portableManifest,
      observation,
      result_ref: "result.json",
      ...(manifest.trajectory_ref ? {} : { trajectory_ref: "trajectory.ref.json" }),
      sealed: true,
    });
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
    return evalTrialRef(input, record.run_id, observation);
  } finally {
    await rm(stagingParent, { recursive: true, force: true });
  }
}

async function createDiagnosticRun(input: TrialInput): Promise<EvalTrialRefV1> {
  const runId = newRunId();
  const runDirectory = await ensureDir(path.join(statePaths(input.root).runs, runId));
  const now = new Date().toISOString();
  const verifier = verifierResult(input.trial);
  const verifierRef = verifier ? "verifier/result.json" : undefined;
  if (verifier) await atomicWriteJSON(path.join(runDirectory, verifierRef as string), verifier);
  const bridgeError = input.trial.exception_info
    ? await readHarborBridgeError(input.trialDirectory)
    : null;
  const bridgeErrorRef = bridgeError ? "diagnostics/harbor-bridge-error.json" : undefined;
  if (bridgeError && bridgeErrorRef) {
    await ensureDir(path.dirname(path.join(runDirectory, bridgeErrorRef)));
    await writePrivateFile(
      path.join(runDirectory, bridgeErrorRef),
      bridgeError.raw.endsWith("\n") ? bridgeError.raw : `${bridgeError.raw}\n`,
    );
  }
  const reason = input.trial.exception_info
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
  return evalTrialRef(input, runId, observation);
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

function trialObservation(
  trial: Record<string, unknown>,
  runStatus: string,
  trajectoryStatus: "valid" | "missing" | "corrupt",
  recordStatus: "valid" | "corrupt",
  verifierRef: string | undefined,
): RunObservationV1 {
  if (trial.exception_info) return { status: "invalid", invalid_reason: "infrastructure_failure", ...(verifierRef ? { verifier_result_ref: verifierRef } : {}) };
  if (runStatus === "cancelled") return { status: "invalid", invalid_reason: "cancelled", ...(verifierRef ? { verifier_result_ref: verifierRef } : {}) };
  if (runStatus !== "succeeded") return { status: "invalid", invalid_reason: "infrastructure_failure", ...(verifierRef ? { verifier_result_ref: verifierRef } : {}) };
  if (recordStatus !== "valid") return { status: "invalid", invalid_reason: "infrastructure_failure", ...(verifierRef ? { verifier_result_ref: verifierRef } : {}) };
  if (trajectoryStatus !== "valid") return { status: "invalid", invalid_reason: "trajectory_missing_or_corrupt", ...(verifierRef ? { verifier_result_ref: verifierRef } : {}) };
  const reward = primaryReward(trial);
  if (reward === undefined || !verifierRef) return { status: "invalid", invalid_reason: "verifier_result_missing" };
  return { status: "valid", reward, verifier_result_ref: verifierRef };
}

function verifierResult(trial: Record<string, unknown>): Record<string, unknown> | null {
  return trial.verifier_result && typeof trial.verifier_result === "object" && !Array.isArray(trial.verifier_result)
    ? trial.verifier_result as Record<string, unknown>
    : null;
}

function primaryReward(trial: Record<string, unknown>): number | undefined {
  const rewards = (verifierResult(trial)?.rewards || {}) as Record<string, unknown>;
  const preferred = rewards.reward;
  if (typeof preferred === "number" && Number.isFinite(preferred)) return preferred;
  return Object.values(rewards).find((value): value is number => typeof value === "number" && Number.isFinite(value));
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

function trialAttempt(trialId: string): number {
  const match = trialId.match(/__(\d+)$/);
  const value = Number(match?.[1]);
  // Modern Harbor trial ids carry a random suffix. Each such id identifies a
  // distinct trial, whose execution attempt starts at one.
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

async function validateJSONLines(file: string): Promise<void> {
  const content = await readFile(file, "utf8");
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line) continue;
    try { JSON.parse(line); } catch (error) {
      throw new Error(`invalid JSONL at ${path.basename(file)}:${index + 1}: ${(error as Error).message}`);
    }
  }
}

export async function validateEvalTrialReferences(
  root: string,
  evalId: string,
  trials: EvalTrialRefV1[],
  expected?: { benchmarkId: string; benchmarkRevision: string },
): Promise<void> {
  for (const trial of trials) {
    const loaded = await loadRunRecord(path.join(statePaths(root).runs, trial.run_id), { verifyTrajectory: false });
    const record = loaded.record;
    if (record.context.kind !== "benchmark_task") throw new Error(`eval trial ${trial.trial_id} references a non-benchmark run`);
    if (expected && (
      record.context.benchmark_id !== expected.benchmarkId
      || record.context.benchmark_revision !== expected.benchmarkRevision
      || record.context.verifier_identity !== benchmarkVerifierIdentity(expected.benchmarkId, expected.benchmarkRevision)
    )) throw new Error(`eval trial ${trial.trial_id} benchmark identity mismatch`);
    if (record.parent?.eval_id !== evalId || record.parent.trial_id !== trial.trial_id || record.parent.attempt !== trial.attempt) {
      throw new Error(`eval trial ${trial.trial_id} parent mismatch`);
    }
    if (record.context.task_id !== trial.task_id) throw new Error(`eval trial ${trial.trial_id} task mismatch`);
    if (record.observation?.status !== trial.observation_status) throw new Error(`eval trial ${trial.trial_id} observation status mismatch`);
    if (record.observation?.reward !== trial.reward) throw new Error(`eval trial ${trial.trial_id} reward mismatch`);
    if (record.observation?.verifier_result_ref !== trial.verifier_result_ref) throw new Error(`eval trial ${trial.trial_id} verifier ref mismatch`);
    if (record.observation?.invalid_reason !== trial.invalid_reason) throw new Error(`eval trial ${trial.trial_id} invalid reason mismatch`);
  }
}
