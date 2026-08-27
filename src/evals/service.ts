import path from "node:path";
import { mkdir } from "node:fs/promises";
import { prepareHarness, preparedArtifactDirectory, resolveHarness } from "../artifacts/index.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, ensureDir, invalidInput, readJSON, statePaths } from "../foundation/index.js";
import { parseHarnessReference } from "../revisions/index.js";
import { buildLocalGitTransport, lockedHarnessRef, runHarborBackend, verifyLocalGitTransport } from "../backends/index.js";
import type { HarborPreparedArtifactUse, LocalGitTransportUse } from "../backends/index.js";
import { ensureControllerRuntime, writeRuntimeReference } from "../controller-runtime/index.js";
import type { ControllerRuntimeUseResult } from "../controller-runtime/index.js";
import type { EvalId, EvalProgressV1, EvalTrialRefV1 } from "../domain/index.js";
import { importEvalTrialRun, importEvalTrialRuns, TrialBundlePendingError, validateEvalTrialReferences } from "./trial-import.js";
import { EvalEventSink } from "./events.js";
import { createEvalProgress, mergeEvalProgressTrial, writeEvalProgress } from "./progress.js";
import { newEvalId, resolveLocalDatasetTaskIds, validateEvalId, validateEvalRequest } from "./request.js";
import { invalidTrialSlots } from "./rerun-slots.js";
import type { EvalRequestInput } from "./request.js";

export interface RunEvalOptions {
  evalId?: EvalId;
  request: EvalRequestInput;
  root: string;
  env?: NodeJS.ProcessEnv;
  harborExecutable?: string;
  signal?: AbortSignal;
  onEvent?: (event: Record<string, unknown>) => void;
  trialBundleGraceMs?: number;
}

export interface EvalResult extends Record<string, unknown> {
  schema_version: string;
  eval_id: EvalId;
  status: string;
  exit_code: number;
  error?: { code: string; message: string };
  started_at: string;
  completed_at: string;
}

export async function runEval({ evalId = newEvalId(), request, root, env = process.env, harborExecutable, signal, onEvent, trialBundleGraceMs }: RunEvalOptions): Promise<EvalResult> {
  if (!root) throw invalidInput("a Hitch state root is required for eval");
  evalId = validateEvalId(evalId);
  const normalized = await validateEvalRequest(request);
  const evalsDirectory = await ensureDir(statePaths(root).evals);
  const evalDirectory = path.join(evalsDirectory, evalId);
  try {
    await mkdir(evalDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new HitchError(`eval ID already exists: ${evalId}`, { code: "eval_id_conflict", exitCode: 2 });
    }
    throw error;
  }
  const startedAt = new Date();
  const sink = new EvalEventSink(evalDirectory, evalId, onEvent);
  await sink.open();
  await atomicWriteJSON(path.join(evalDirectory, "request.json"), normalized);
  let result: EvalResult;
  let trialRefs: import("../domain/index.js").EvalTrialRefV1[] = [];
  let progress: EvalProgressV1 | null = null;
  try {
    sink.emit({ type: "eval.started", backend: normalized.backend, dataset: normalized.dataset });
    const requestedReference = parseHarnessReference(normalized.harness_ref);
    const resolvedRevision = await resolveHarness(normalized.harness_ref, { root, env });
    let localTransport: LocalGitTransportUse | undefined;
    if (resolvedRevision.source.type === "git" && resolvedRevision.source.registered !== true) {
      const selector = requestedReference.selector;
      if (selector.type !== "commit" || !selector.source?.explicit) throw invalidInput("Harbor local Git eval requires an explicit git+file source");
      if (resolvedRevision.revision.commit !== selector.value) {
        throw new HitchError("local Git exact commit resolved to a different object", { code: "local_source_integrity_mismatch", exitCode: 12 });
      }
      localTransport = await buildLocalGitTransport({
        evalDirectory,
        resolvedRevision,
        sourceDirectory: selector.source.local_path,
        env,
        ...(signal ? { signal } : {}),
      });
      sink.emit({
        type: "eval.local-source.prepared",
        resolution_identity: localTransport.manifest.resolution_identity,
        commit: localTransport.manifest.commit,
        payload_sha256: localTransport.manifest.payload_sha256,
        payload_bytes: localTransport.manifest.payload_bytes,
        status: "verified",
      });
    }
    const selector = requestedReference.selector;
    const verifiedLocalGitSource = localTransport && selector.type === "commit" && selector.source?.explicit
      ? {
          directory: selector.source.local_path,
          commit: localTransport.manifest.commit,
          tree: localTransport.manifest.tree,
          resolutionIdentity: localTransport.manifest.resolution_identity,
          payloadSha256: localTransport.manifest.payload_sha256,
        }
      : undefined;
    const artifact = await prepareHarness(resolvedRevision, {
      root,
      env,
      ...(signal ? { signal } : {}),
      ...(verifiedLocalGitSource ? { verifiedLocalGitSource } : {}),
    });
    if (!artifact.artifact_integrity || !artifact.entrypoint_integrity) {
      throw new HitchError("host-prepared harness artifact has no complete integrity metadata", {
        code: "artifact_integrity_mismatch",
        exitCode: 5,
      });
    }
    const preparedArtifact: HarborPreparedArtifactUse = {
      directory: preparedArtifactDirectory(root, artifact.artifact_id),
      artifact_id: artifact.artifact_id,
      artifact_integrity: artifact.artifact_integrity,
      entrypoint_integrity: artifact.entrypoint_integrity,
      harness_id: artifact.harness_id,
      revision_identity: artifact.revision_identity,
      adapter_version: artifact.adapter_version,
      recipe_version: artifact.recipe_version,
      platform: artifact.platform,
      node_version: artifact.toolchain.node || process.version,
      source_type: artifact.source_type,
    };
    sink.emit({
      type: "eval.harness-artifact.prepared",
      harness: artifact.harness_id,
      artifact_id: artifact.artifact_id,
      platform: artifact.platform,
      cache_hit: artifact.cache_hit,
    });
    // Phase 2: the shared, read-only, SHA-256-addressed controller runtime
    // cache replaces the per-eval Hitch runtime copy (spec §4).
    const controllerRuntime: ControllerRuntimeUseResult = await ensureControllerRuntime({ root });
    const runtimeRefFile = await writeRuntimeReference(evalDirectory, controllerRuntime);
    sink.emit({
      type: "eval.controller-runtime",
      runtime_id: controllerRuntime.runtime_id,
      cache_hit: controllerRuntime.cache_hit,
      reference: runtimeRefFile,
    });
    const localTaskIds = await resolveLocalDatasetTaskIds(normalized.dataset);
    const plannedTasks = localTaskIds?.length ?? null;
    const plannedTrials = plannedTasks === null ? null : plannedTasks * normalized.attempts;
    if (plannedTrials !== null && !Number.isSafeInteger(plannedTrials)) throw invalidInput("planned trial count exceeds the safe integer range");
    const plan = {
      schema_version: SCHEMA_VERSION,
      eval_id: evalId,
      backend: "harbor",
      candidate: {
        id: "candidate-1",
        requested_harness_ref: normalized.harness_ref,
        harness_ref: lockedHarnessRef(resolvedRevision),
        harness_id: resolvedRevision.harness_id,
        revision_identity: resolvedRevision.identity,
        model: normalized.model || null,
      },
      dataset: normalized.dataset,
      benchmark_id: normalized.benchmark_id,
      benchmark_revision: normalized.benchmark_revision,
      attempts: normalized.attempts,
      attempt_execution: "harbor-attempt-shards-v1",
      max_concurrent: normalized.max_concurrent,
      ...(localTaskIds === null ? {} : { tasks: localTaskIds }),
      controller_runtime: {
        runtime_id: controllerRuntime.runtime_id,
        manifest_digest: controllerRuntime.manifest_digest,
      },
      prepared_artifact: preparedArtifactSummary(preparedArtifact),
      ...(localTransport ? { local_source_transport: transportSummary(localTransport) } : {}),
      created_at: new Date().toISOString(),
    };
    await atomicWriteJSON(path.join(evalDirectory, "resolution.json"), resolvedRevision);
    await atomicWriteJSON(path.join(evalDirectory, "plan.json"), plan);
    progress = createEvalProgress({
      evalId,
      benchmarkId: normalized.benchmark_id,
      benchmarkRevision: normalized.benchmark_revision,
      plannedTasks,
      plannedTrials,
      startedAt: startedAt.toISOString(),
    });
    await writeEvalProgress(evalDirectory, progress);
    sink.emit({
      type: "eval.planned",
      harness: resolvedRevision.harness_id,
      revision_identity: resolvedRevision.identity,
      attempts: normalized.attempts,
      planned_tasks: plannedTasks,
      planned_trials: plannedTrials,
    });
    if (localTransport) {
      await verifyLocalGitTransport(localTransport, {
        expected: {
          harnessId: resolvedRevision.harness_id,
          resolutionIdentity: resolvedRevision.identity,
          commit: resolvedRevision.revision.commit as string,
        },
        env,
        ...(signal ? { signal } : {}),
      });
    }
    const backendRuns: Array<{ attempt: number; run: Awaited<ReturnType<typeof runHarborBackend>> }> = [];
    for (let logicalAttempt = 1; logicalAttempt <= normalized.attempts; logicalAttempt += 1) {
      if (signal?.aborted) break;
      const backendDirectory = normalized.attempts === 1
        ? path.join(evalDirectory, "harbor")
        : path.join(evalDirectory, "harbor", attemptDirectoryName(logicalAttempt));
      const harborJobDirectory = path.join(backendDirectory, "job");
      const shardRefs: EvalTrialRefV1[] = [];
      const publish = async (ref: EvalTrialRefV1): Promise<void> => {
        if (ref.attempt !== logicalAttempt) {
          throw new HitchError(`Harbor returned attempt ${ref.attempt}, expected ${logicalAttempt}`, {
            code: "eval_trial_attempt_mismatch",
            exitCode: 12,
          });
        }
        if (!shardRefs.some((current) => current.trial_id === ref.trial_id)) shardRefs.push(ref);
        if (progress === null) throw new Error("eval progress was not initialized");
        const previousGeneration = progress.generation;
        progress = mergeEvalProgressTrial(progress, ref);
        if (progress.generation === previousGeneration) return;
        await validateEvalTrialReferences(root, evalId, [ref], {
          benchmarkId: normalized.benchmark_id,
          benchmarkRevision: normalized.benchmark_revision,
        });
        await writeEvalProgress(evalDirectory, progress);
        sink.emit({
          type: "eval.trial.published",
          trial_id: ref.trial_id,
          task_id: ref.task_id,
          attempt: ref.attempt,
          run_id: ref.run_id,
          observation_status: ref.observation_status,
          settled_trials: progress.trials.length,
          generation: progress.generation,
        });
      };
      const backendRun = await runHarborBackend({
        evalId,
        evalDirectory,
        backendDirectory,
        logicalAttempt,
        request: { ...normalized, attempts: 1 },
        root,
        resolvedRevision,
        runtimeDirectory: controllerRuntime.directory,
        runtimeId: controllerRuntime.runtime_id,
        preparedArtifact,
        ...(localTransport ? { localTransport } : {}),
        env,
        ...(harborExecutable !== undefined ? { harborExecutable } : {}),
        ...(signal ? { signal } : {}),
        ...(trialBundleGraceMs === undefined ? {} : { trialBundleGraceMs }),
        emit: (event) => sink.emit(event),
        onTrialSettled: async (trial, context): Promise<boolean> => {
          try {
            const ref = await importEvalTrialRun({
              root,
              evalId,
              evalDirectory,
              harborJobDirectory,
              expectedAttempt: logicalAttempt,
              request: normalized,
              resolvedRevision,
              benchmarkId: normalized.benchmark_id,
              benchmarkRevision: normalized.benchmark_revision,
              runtimeId: controllerRuntime.runtime_id,
              requireCompleteMarker: true,
              allowMissingBundleDiagnostic: context.bundleWaitExpired,
            }, trial, shardRefs.length, shardRefs);
            await publish(ref);
            return true;
          } catch (error) {
            if (error instanceof TrialBundlePendingError) return false;
            throw error;
          }
        },
      });
      backendRuns.push({ attempt: logicalAttempt, run: backendRun });
      const terminalRefs = await importEvalTrialRuns({
        root,
        evalId,
        evalDirectory,
        harborJobDirectory,
        expectedAttempt: logicalAttempt,
        request: normalized,
        resolvedRevision,
        benchmarkId: normalized.benchmark_id,
        benchmarkRevision: normalized.benchmark_revision,
        runtimeId: controllerRuntime.runtime_id,
        rawResult: backendRun.rawResult,
      }, shardRefs);
      for (const ref of terminalRefs) await publish(ref);
      assertBackendTrialSet(backendRun.rawResult, shardRefs);
      await validateEvalTrialReferences(root, evalId, shardRefs, {
        benchmarkId: normalized.benchmark_id,
        benchmarkRevision: normalized.benchmark_revision,
      });
      if (backendRun.backend.process_exit_code !== 0 || backendRun.rawResult === null) break;
      if (localTransport && localSourceBackendFailure(backendRun.rawResult)) break;
    }
    if (progress === null) throw new Error("eval progress was not initialized");
    trialRefs = progress.trials;
    const cancelled = signal?.aborted === true;
    const localSourceFailure = localTransport
      ? backendRuns.some(({ run }) => localSourceBackendFailure(run.rawResult))
      : false;
    const backendsSucceeded = backendRuns.length === normalized.attempts
      && backendRuns.every(({ run }) => run.backend.process_exit_code === 0 && run.rawResult !== null);
    const invalidTrials = localTaskIds === null
      ? trialRefs.filter((trial) => trial.observation_status !== "valid").map((trial) => ({ task_id: trial.task_id, attempt: trial.attempt }))
      : invalidTrialSlots(localTaskIds, normalized.attempts, progress);
    const succeeded = !cancelled && !localSourceFailure && backendsSucceeded && invalidTrials.length === 0;
    const singleBackend = backendRuns.length === 1 ? backendRuns[0]!.run : undefined;
    result = {
      schema_version: SCHEMA_VERSION,
      eval_id: evalId,
      status: cancelled ? "cancelled" : succeeded ? "succeeded" : "failed",
      exit_code: cancelled ? 9 : succeeded ? 0 : 13,
      ...(singleBackend ? { backend: singleBackend.backend, backend_summary: singleBackend.summary } : {}),
      ...(normalized.attempts > 1 ? {
        backend_runs: backendRuns.map(({ attempt, run }) => ({
          attempt,
          backend: run.backend,
          backend_summary: run.summary,
        })),
      } : {}),
      candidate: plan.candidate,
      dataset: normalized.dataset,
      benchmark_id: normalized.benchmark_id,
      benchmark_revision: normalized.benchmark_revision,
      generation: progress.generation,
      trials: trialRefs,
      summary: summarizeTrialRefs(trialRefs),
      prepared_artifact: preparedArtifactSummary(preparedArtifact),
      ...(localTransport ? { local_source_transport: transportSummary(localTransport) } : {}),
      ...(succeeded ? {} : {
        error: {
          code: cancelled
            ? "cancelled"
            : localSourceFailure
              ? "local_source_materialize_failed"
              : !backendsSucceeded
                ? "harbor_failed"
                : "eval_has_invalid_tasks",
          message: cancelled
            ? "eval was cancelled"
            : localSourceFailure
              ? "Harbor rejected the transported local Git source before candidate execution"
              : !backendsSucceeded
                ? `Harbor attempt shards completed ${backendRuns.length}/${normalized.attempts}`
                : `eval has invalid or missing trials: ${invalidTrials.map(trial => `${trial.task_id}#${trial.attempt}`).join(", ")}`,
        },
      }),
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
    };
  } catch (error) {
    trialRefs = progress?.trials ?? trialRefs;
    const typed = error instanceof HitchError;
    result = {
      schema_version: SCHEMA_VERSION,
      eval_id: evalId,
      status: signal?.aborted ? "cancelled" : "failed",
      exit_code: signal?.aborted ? 9 : typed ? error.exitCode : 12,
      error: {
        code: signal?.aborted ? "cancelled" : typed ? error.code : "internal_error",
        message: (error as Error)?.message || String(error),
      },
      benchmark_id: normalized.benchmark_id,
      benchmark_revision: normalized.benchmark_revision,
      ...(progress === null ? {} : { generation: progress.generation }),
      trials: trialRefs,
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
    };
  }
  await atomicWriteJSON(path.join(evalDirectory, "result.json"), result);
  sink.emit({ type: result.status === "succeeded" ? "eval.completed" : "eval.failed", status: result.status, exit_code: result.exit_code, error: result.error });
  await sink.close();
  return result;
}

function assertBackendTrialSet(rawResult: Record<string, unknown> | null, refs: readonly EvalTrialRefV1[]): void {
  const trials = Array.isArray(rawResult?.trial_results) ? rawResult.trial_results as Record<string, unknown>[] : [];
  const backendIds = new Set(trials.map((trial) => typeof trial.trial_name === "string" ? trial.trial_name : null).filter((value): value is string => value !== null));
  const refIds = new Set(refs.map((ref) => ref.trial_id));
  if (backendIds.size !== trials.length || backendIds.size !== refIds.size || [...backendIds].some((id) => !refIds.has(id))) {
    throw new Error("Harbor terminal trial set does not match published eval progress");
  }
}

function attemptDirectoryName(attempt: number): string {
  return `attempt-${String(attempt).padStart(4, "0")}`;
}

export function summarizeTrialRefs(trials: import("../domain/index.js").EvalTrialRefV1[]): Record<string, unknown> {
  const valid = trials.filter((trial) => trial.observation_status === "valid" && typeof trial.reward === "number");
  const rewards = valid.map((trial) => trial.reward as number);
  const aggregate = rewards.length
    ? {
        count: rewards.length,
        mean: rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length,
        min: Math.min(...rewards),
        max: Math.max(...rewards),
      }
    : null;
  return {
    n_trials: trials.length,
    n_completed: valid.length,
    n_invalid: trials.length - valid.length,
    primary_reward: aggregate?.mean ?? null,
    rewards: aggregate ? { reward: aggregate } : {},
  };
}

function localSourceBackendFailure(rawResult: Record<string, unknown> | null): boolean {
  if (!rawResult) return false;
  // The bridge uses this fixed, non-secret marker when setup cannot verify or
  // materialize the uploaded source. Do not surface provider exception text in
  // the durable Hitch error, because it may contain backend diagnostics.
  return JSON.stringify(rawResult).includes("hitch-local-source-materialize:");
}

function transportSummary(transport: LocalGitTransportUse): Record<string, unknown> {
  const manifest = transport.manifest;
  return {
    kind: manifest.kind,
    resolution_identity: manifest.resolution_identity,
    commit: manifest.commit,
    tree: manifest.tree,
    payload_sha256: manifest.payload_sha256,
    payload_bytes: manifest.payload_bytes,
    object_count: manifest.object_count,
    file_count: manifest.file_count,
  };
}

function preparedArtifactSummary(artifact: HarborPreparedArtifactUse): Record<string, unknown> {
  return {
    artifact_id: artifact.artifact_id,
    artifact_integrity: artifact.artifact_integrity,
    entrypoint_integrity: artifact.entrypoint_integrity,
    harness_id: artifact.harness_id,
    revision_identity: artifact.revision_identity,
    platform: artifact.platform,
    source_type: artifact.source_type,
  };
}
