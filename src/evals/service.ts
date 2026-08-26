import path from "node:path";
import { prepareHarness, preparedArtifactDirectory, resolveHarness } from "../artifacts/index.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, ensureDir, invalidInput, readJSON, statePaths } from "../foundation/index.js";
import { parseHarnessReference } from "../revisions/index.js";
import { buildLocalGitTransport, lockedHarnessRef, runHarborBackend, verifyLocalGitTransport } from "../backends/index.js";
import type { HarborPreparedArtifactUse, LocalGitTransportUse } from "../backends/index.js";
import { ensureControllerRuntime, writeRuntimeReference } from "../controller-runtime/index.js";
import type { ControllerRuntimeUseResult } from "../controller-runtime/index.js";
import type { EvalId } from "../domain/index.js";
import { importEvalTrialRuns, validateEvalTrialReferences } from "./trial-import.js";
import { EvalEventSink } from "./events.js";
import { newEvalId, validateEvalRequest } from "./request.js";
import type { EvalRequestInput } from "./request.js";

export interface RunEvalOptions {
  evalId?: EvalId;
  request: EvalRequestInput;
  root: string;
  env?: NodeJS.ProcessEnv;
  harborExecutable?: string;
  signal?: AbortSignal;
  onEvent?: (event: Record<string, unknown>) => void;
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

export async function runEval({ evalId = newEvalId(), request, root, env = process.env, harborExecutable, signal, onEvent }: RunEvalOptions): Promise<EvalResult> {
  if (!root) throw invalidInput("a Hitch state root is required for eval");
  const normalized = await validateEvalRequest(request);
  const evalDirectory = await ensureDir(path.join(statePaths(root).evals, evalId));
  const startedAt = new Date();
  const sink = new EvalEventSink(evalDirectory, evalId, onEvent);
  await sink.open();
  await atomicWriteJSON(path.join(evalDirectory, "request.json"), normalized);
  let result: EvalResult;
  let trialRefs: import("../domain/index.js").EvalTrialRefV1[] = [];
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
      max_concurrent: normalized.max_concurrent,
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
    sink.emit({
      type: "eval.planned",
      harness: resolvedRevision.harness_id,
      revision_identity: resolvedRevision.identity,
      attempts: normalized.attempts,
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
    const backendRun = await runHarborBackend({
      evalId,
      evalDirectory,
      request: normalized,
      root,
      resolvedRevision,
      runtimeDirectory: controllerRuntime.directory,
      runtimeId: controllerRuntime.runtime_id,
      preparedArtifact,
      ...(localTransport ? { localTransport } : {}),
      env,
      ...(harborExecutable !== undefined ? { harborExecutable } : {}),
      ...(signal ? { signal } : {}),
      emit: (event) => sink.emit(event),
    });
    trialRefs = await importEvalTrialRuns({
      root,
      evalId,
      evalDirectory,
      request: normalized,
      resolvedRevision,
      benchmarkId: normalized.benchmark_id,
      benchmarkRevision: normalized.benchmark_revision,
      runtimeId: controllerRuntime.runtime_id,
      rawResult: backendRun.rawResult,
    });
    await validateEvalTrialReferences(root, evalId, trialRefs, {
      benchmarkId: normalized.benchmark_id,
      benchmarkRevision: normalized.benchmark_revision,
    });
    const cancelled = signal?.aborted;
    const localSourceFailure = localTransport ? localSourceBackendFailure(backendRun.rawResult) : false;
    const succeeded = !cancelled && !localSourceFailure && backendRun.backend.process_exit_code === 0 && backendRun.rawResult !== null;
    result = {
      schema_version: SCHEMA_VERSION,
      eval_id: evalId,
      status: cancelled ? "cancelled" : succeeded ? "succeeded" : "failed",
      exit_code: cancelled ? 9 : succeeded ? 0 : 13,
      backend: backendRun.backend,
      candidate: plan.candidate,
      dataset: normalized.dataset,
      benchmark_id: normalized.benchmark_id,
      benchmark_revision: normalized.benchmark_revision,
      trials: trialRefs,
      summary: summarizeTrialRefs(trialRefs),
      backend_summary: backendRun.summary,
      prepared_artifact: preparedArtifactSummary(preparedArtifact),
      ...(localTransport ? { local_source_transport: transportSummary(localTransport) } : {}),
      ...(succeeded ? {} : {
        error: {
          code: cancelled ? "cancelled" : localSourceFailure ? "local_source_materialize_failed" : "harbor_failed",
          message: cancelled
            ? "eval was cancelled"
            : localSourceFailure
              ? "Harbor rejected the transported local Git source before candidate execution"
            : backendRun.rawResult === null
              ? `Harbor exited without a result (code ${backendRun.backend.process_exit_code ?? "null"})`
              : `Harbor exited with code ${backendRun.backend.process_exit_code ?? "null"}`,
        },
      }),
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
    };
  } catch (error) {
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

function summarizeTrialRefs(trials: import("../domain/index.js").EvalTrialRefV1[]): Record<string, unknown> {
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
