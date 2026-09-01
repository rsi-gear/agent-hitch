import path from "node:path";
import { prepareHarness, resolveHarness } from "../artifacts/index.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, ensureDir, invalidInput, statePaths } from "../foundation/index.js";
import { parseHarnessReference } from "../revisions/index.js";
import { buildLocalGitTransport, lockedHarnessRef, runHarborBackend, verifyLocalGitTransport } from "../backends/index.js";
import type { HarborBackendResult, LocalGitTransportUse } from "../backends/index.js";
import { ensureControllerRuntime, writeRuntimeReference } from "../controller-runtime/index.js";
import type { ControllerRuntimeUseResult } from "../controller-runtime/index.js";
import type { EvalProgressV1, EvalTrialRefV1 } from "../domain/index.js";
import { importEvalTrialRun, importEvalTrialRuns, TrialBundlePendingError, validateEvalTrialReferences } from "./trial-import.js";
import { EvalEventSink } from "./events.js";
import { createEvalProgress, mergeEvalProgressTrial, writeEvalProgress } from "./progress.js";
import { infrastructureFailureTrials, runInfrastructureRetries } from "./infrastructure-retry.js";
import type { InfrastructureRetryRun } from "./infrastructure-retry.js";
import { newEvalId, resolveLocalDatasetTaskIds, validateEvalId, validateEvalRequest } from "./request.js";
import { invalidTrialSlots } from "./rerun-slots.js";
import { prepareEvalDirectory } from "./directory.js";
import { buildEvalExecutionPlan, DEFAULT_EVAL_TRIAL_RESOURCES } from "./execution-plan.js";
import { planLocalEvalInputs } from "./local-eval-planning.js";
import { resolvedImageMapping } from "./environment-image-planning.js";
import { assertBackendTrialSet, attemptDirectoryName, localSourceBackendFailure, preparedArtifactSummary, summarizeTrialRefs, transportSummary } from "./result-helpers.js";
import { executePlannedHarborTasks } from "./planned-execution.js";
import { assertEvalResumeState, executionPlanWorkState, loadEvalResumeState } from "./resume-state.js";
import type { EvalResult, RunEvalOptions } from "./service-types.js";
import { modelCaptureDegradationEvent, resolveEvalModelCapturePlan } from "./model-capture-plan.js";
import { finalizeEvalResult } from "./eval-finalization.js";
import { harborPreparedArtifact, preparedHarnessEvent } from "./prepared-harness.js";
import { startEvalModelCaptureRuntime } from "./model-capture-runtime.js";
export async function runEval({ evalId = newEvalId(), request, root, env = process.env, harborExecutable, signal, onEvent, trialBundleGraceMs, precreated = false, normalizedRequest, maxConcurrentOverride, executionResources, executionResourceSource = "operator-default", executionStrategy = "legacy-attempt-shards", executionWorker, modelCapturePlan, workItemAdmission, remoteWorkExecutor, resumeExisting = false, onControlPhase, onWorkItemState, dockerResourceReaper, environmentBuildMode = "backend", environmentImageResolver, environmentImageBuilder, environmentImageManifestLoader }: RunEvalOptions): Promise<EvalResult> {
  if (!root) throw invalidInput("a Hitch state root is required for eval");
  evalId = validateEvalId(evalId);
  const persistedRequest = normalizedRequest || await validateEvalRequest(request);
  if (maxConcurrentOverride !== undefined && (!Number.isSafeInteger(maxConcurrentOverride) || maxConcurrentOverride < 1 || maxConcurrentOverride > persistedRequest.max_concurrent)) {
    throw invalidInput("control-plane max concurrency override is invalid");
  }
  const normalized = maxConcurrentOverride === undefined ? persistedRequest : { ...persistedRequest, max_concurrent: maxConcurrentOverride };
  const evalsDirectory = await ensureDir(statePaths(root).evals);
  const evalDirectory = await prepareEvalDirectory({ evalsDirectory, evalId, request: persistedRequest, precreated });
  let startedAt = new Date();
  const sink = new EvalEventSink(evalDirectory, evalId, onEvent);
  await sink.open();
  let result: EvalResult;
  let trialRefs: import("../domain/index.js").EvalTrialRefV1[] = [];
  let progress: EvalProgressV1 | null = null;
  let captureRuntime: Awaited<ReturnType<typeof startEvalModelCaptureRuntime>> | undefined;
  try {
    sink.emit({ type: "eval.started", backend: normalized.backend, dataset: normalized.dataset });
    await onControlPhase?.("planning");
    const requestedReference = parseHarnessReference(normalized.harness_ref);
    const resolvedRevision = await resolveHarness(normalized.harness_ref, { root, env });
    await onControlPhase?.("preparing");
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
    const preparedArtifact = harborPreparedArtifact(root, artifact);
    sink.emit(preparedHarnessEvent(artifact));
    const controllerRuntime: ControllerRuntimeUseResult = await ensureControllerRuntime({ root });
    const runtimeRefFile = await writeRuntimeReference(evalDirectory, controllerRuntime);
    sink.emit({
      type: "eval.controller-runtime",
      runtime_id: controllerRuntime.runtime_id,
      cache_hit: controllerRuntime.cache_hit,
      reference: runtimeRefFile,
    });
    const localTaskIds = await resolveLocalDatasetTaskIds(normalized.dataset);
    const resume = resumeExisting ? await loadEvalResumeState(evalDirectory) : null;
    const localPlanning = await planLocalEvalInputs({ root, dataset: normalized.dataset, taskIds: localTaskIds, defaultResources: executionResources ?? DEFAULT_EVAL_TRIAL_RESOURCES, defaultSource: executionResourceSource, benchmarkId: normalized.benchmark_id, benchmarkRevision: normalized.benchmark_revision, buildMode: environmentBuildMode, ...(environmentImageResolver ? { resolver: environmentImageResolver } : {}), ...(environmentImageBuilder ? { builder: environmentImageBuilder } : {}), ...(resume ? { resumePlan: resume.executionPlan } : {}), ...(harborExecutable ? { harborExecutable } : {}), env, ...(signal ? { signal } : {}) });
    const taskResources = localPlanning.taskResources;
    const plannedTasks = localTaskIds?.length ?? null;
    const plannedTrials = plannedTasks === null ? null : plannedTasks * normalized.attempts;
    if (plannedTrials !== null && !Number.isSafeInteger(plannedTrials)) throw invalidInput("planned trial count exceeds the safe integer range");
    if (resume) startedAt = new Date(resume.progress.started_at);
    const capture = resolveEvalModelCapturePlan({ requested: modelCapturePlan, resumed: resume?.executionPlan.model_capture, resuming: Boolean(resume) });
    const activeCaptureRuntime = await startEvalModelCaptureRuntime({ plan: capture.plan, evalId, evalDirectory, env });
    captureRuntime = activeCaptureRuntime;
    capture.plan = activeCaptureRuntime.plan;
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
      attempt_execution: executionStrategy === "local-task-slots-v1" && localTaskIds !== null
        ? "harbor-task-slots-v1"
        : "harbor-attempt-shards-v1",
      max_concurrent: normalized.max_concurrent,
      ...(capture.persist ? { model_capture: capture.plan } : {}),
      infrastructure_retries: normalized.infrastructure_retries,
      infrastructure_retry_backoff_ms: normalized.infrastructure_retry_backoff_ms,
      ...(localTaskIds === null ? {} : { tasks: localTaskIds }),
      controller_runtime: {
        runtime_id: controllerRuntime.runtime_id,
        manifest_digest: controllerRuntime.manifest_digest,
      },
      prepared_artifact: preparedArtifactSummary(preparedArtifact),
      ...(localTransport ? { local_source_transport: transportSummary(localTransport) } : {}),
      created_at: typeof resume?.plan.created_at === "string" ? resume.plan.created_at : new Date().toISOString(),
    };
    const expectedExecutionPlan = buildEvalExecutionPlan({
      evalId,
      request: normalized,
      candidate: {
        revisionIdentity: resolvedRevision.identity,
        artifactId: artifact.artifact_id,
      },
      tasks: localTaskIds,
      maxParallelism: normalized.max_concurrent,
      ...(executionResources ? { trialResources: executionResources } : {}),
      ...(taskResources ? { taskResources } : {}),
      ...(localPlanning.environmentImages.length > 0 ? { environmentImages: localPlanning.environmentImages } : {}),
      ...(localPlanning.environmentImageFallbacks.length > 0 ? { environmentImageFallbacks: localPlanning.environmentImageFallbacks } : {}),
      ...(executionWorker ? { provider: executionWorker.provider } : {}),
      modelCapture: capture.persist ? capture.plan : null,
      ...(executionStrategy === "local-task-slots-v1" && localTaskIds !== null ? { workItemMode: "task-slots" as const } : {}),
      createdAt: plan.created_at,
    });
    if (resume) assertEvalResumeState({ state: resume, expectedPlan: plan, expectedExecutionPlan, expectedResolutionIdentity: resolvedRevision.identity, plannedTasks, plannedTrials });
    else await Promise.all([
      atomicWriteJSON(path.join(evalDirectory, "resolution.json"), resolvedRevision),
      atomicWriteJSON(path.join(evalDirectory, "plan.json"), plan),
      atomicWriteJSON(path.join(evalDirectory, "execution-plan.json"), expectedExecutionPlan),
    ]);
    const executionPlan = resume?.executionPlan ?? expectedExecutionPlan;
    const captureDegradation = modelCaptureDegradationEvent(executionPlan.model_capture); if (captureDegradation) sink.emit(captureDegradation);
    progress = resume?.progress ?? createEvalProgress({
      evalId,
      benchmarkId: normalized.benchmark_id,
      benchmarkRevision: normalized.benchmark_revision,
      plannedTasks,
      plannedTrials,
      startedAt: startedAt.toISOString(),
    });
    if (!resume) await writeEvalProgress(evalDirectory, progress);
    sink.emit({
      type: "eval.planned",
      harness: resolvedRevision.harness_id,
      revision_identity: resolvedRevision.identity,
      attempts: normalized.attempts,
      planned_tasks: plannedTasks,
      planned_trials: plannedTrials,
      work_items: executionPlan.work_items.length,
      membership: executionPlan.membership,
    });
    await onControlPhase?.("running", executionPlanWorkState(executionPlan, progress));
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
    const backendRuns: Array<{ attempt: number; run: HarborBackendResult; workId?: string; tasks?: string[]; leaseId?: string }> = [];
    const infrastructureRetryRuns: InfrastructureRetryRun[] = [];
    const plannedTaskExecution = executionStrategy === "local-task-slots-v1" && localTaskIds !== null;
    if (plannedTaskExecution) {
      const execution = await executePlannedHarborTasks({
        evalId,
        evalDirectory,
        plan: executionPlan,
        progress,
        request: normalized,
        root,
        resolvedRevision,
        controllerRuntime,
        preparedArtifact,
        ...(localTransport ? { localTransport } : {}),
        env,
        ...(harborExecutable !== undefined ? { harborExecutable } : {}),
        ...(signal ? { signal } : {}),
        ...(trialBundleGraceMs === undefined ? {} : { trialBundleGraceMs }),
        sink,
        worker: executionWorker || {
          workerId: `worker_process_${process.pid}`,
          provider: "local-docker",
          collisionDomainId: `local-process:${process.pid}`,
        },
        ...(workItemAdmission ? { admission: workItemAdmission } : {}),
        ...(onWorkItemState ? { onWorkItemState } : {}),
        ...(dockerResourceReaper ? { dockerResourceReaper } : {}),
        ...(environmentImageManifestLoader ? { environmentImageManifestLoader } : {}),
        ...(activeCaptureRuntime.exporter ? { interactionCaptureExporter: activeCaptureRuntime.exporter } : {}),
        ...(remoteWorkExecutor ? { remoteWorkExecutor } : {}),
      });
      progress = execution.progress;
      backendRuns.push(...execution.backendRuns.map((entry) => ({
        attempt: entry.attempt,
        run: entry.run,
        workId: entry.workId,
        tasks: entry.tasks,
        leaseId: entry.leaseId,
      })));
      infrastructureRetryRuns.push(...execution.infrastructureRetryRuns);
    } else for (let logicalAttempt = 1; logicalAttempt <= normalized.attempts; logicalAttempt += 1) {
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
        ...(activeCaptureRuntime.exporter ? { modelProxy: activeCaptureRuntime.exporter.route } : {}),
        resolvedImages: resolvedImageMapping(executionPlan.work_items.find((item) => item.logical_attempt === logicalAttempt)?.image_refs ?? []),
        ...(executionResources ? { executionResources } : {}),
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
              modelCapturePlan: activeCaptureRuntime.plan,
              ...(activeCaptureRuntime.exporter ? { interactionCaptureExporter: activeCaptureRuntime.exporter } : {}),
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
        modelCapturePlan: activeCaptureRuntime.plan,
        ...(activeCaptureRuntime.exporter ? { interactionCaptureExporter: activeCaptureRuntime.exporter } : {}),
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
      if (progress === null) throw new Error("eval progress was not initialized");
      const retries = await runInfrastructureRetries({
        evalId,
        evalDirectory,
        logicalAttempt,
        initialRefs: shardRefs,
        progress,
        request: normalized,
        root,
        resolvedRevision,
        controllerRuntime,
        preparedArtifact,
        resolvedImages: resolvedImageMapping(executionPlan.work_items.find((item) => item.logical_attempt === logicalAttempt)?.image_refs ?? []),
        ...(executionResources ? { executionResources } : {}),
        modelCapturePlan: activeCaptureRuntime.plan,
        ...(activeCaptureRuntime.exporter ? { interactionCaptureExporter: activeCaptureRuntime.exporter } : {}),
        ...(localTransport ? { localTransport } : {}),
        env,
        ...(harborExecutable !== undefined ? { harborExecutable } : {}),
        ...(signal ? { signal } : {}),
        ...(trialBundleGraceMs === undefined ? {} : { trialBundleGraceMs }),
        sink,
        ...(localTransport ? { stopAfterResult: localSourceBackendFailure } : {}),
      });
      progress = retries.progress;
      infrastructureRetryRuns.push(...retries.runs);
    }
    if (progress === null) throw new Error("eval progress was not initialized");
    await onControlPhase?.("finalizing");
    trialRefs = progress.trials;
    const cancelled = signal?.aborted === true;
    const localSourceFailure = localTransport
      ? backendRuns.some(({ run }) => localSourceBackendFailure(run.rawResult))
        || infrastructureRetryRuns.some(({ run }) => localSourceBackendFailure(run.rawResult))
      : false;
    const expectedBackendRuns = plannedTaskExecution ? executionPlan.work_items.length : normalized.attempts;
    const backendsSucceeded = backendRuns.every(({ run }) => run.backend.process_exit_code === 0 && run.rawResult !== null)
      && (plannedTaskExecution ? progress.trials.length === plannedTrials : backendRuns.length === expectedBackendRuns);
    const invalidTrials = localTaskIds === null
      ? trialRefs.filter((trial) => trial.observation_status !== "valid").map((trial) => ({ task_id: trial.task_id, attempt: trial.attempt }))
      : invalidTrialSlots(localTaskIds, normalized.attempts, progress);
    const infrastructureFailures = infrastructureFailureTrials(trialRefs);
    const infrastructureFailureSlots = infrastructureFailures.map((trial) => ({ task_id: trial.task_id, attempt: trial.attempt }));
    const verifierRetriesExhausted = normalized.infrastructure_retries > 0 && infrastructureFailures.some((trial) => trial.invalid_reason === "verifier_infrastructure_failure");
    const infrastructureErrorCode = verifierRetriesExhausted || (normalized.infrastructure_retries > 0 && infrastructureRetryRuns.length > 0)
      ? "eval_infrastructure_retries_exhausted"
      : "eval_has_infrastructure_failures";
    const succeeded = !cancelled && !localSourceFailure && backendsSucceeded && invalidTrials.length === 0;
    const singleBackend = backendRuns.length === 1 ? backendRuns[0]!.run : undefined;
    result = {
      schema_version: SCHEMA_VERSION,
      eval_id: evalId,
      status: cancelled ? "cancelled" : succeeded ? "succeeded" : "failed",
      exit_code: cancelled ? 9 : succeeded ? 0 : 13,
      ...(singleBackend ? { backend: singleBackend.backend, backend_summary: singleBackend.summary } : {}),
      ...(plannedTaskExecution ? {
        backend_work_items: backendRuns.map(({ attempt, workId, tasks, leaseId, run }) => ({
          work_id: workId,
          lease_id: leaseId,
          attempt,
          tasks,
          backend: run.backend,
          backend_summary: run.summary,
        })),
      } : normalized.attempts > 1 ? {
        backend_runs: backendRuns.map(({ attempt, run }) => ({
          attempt,
          backend: run.backend,
          backend_summary: run.summary,
        })),
      } : {}),
      infrastructure_retry_policy: {
        max_retries: normalized.infrastructure_retries,
        backoff_ms: normalized.infrastructure_retry_backoff_ms,
        verifier_execution: "same_trial_verifier_only",
        candidate_rerun_on_verifier_failure: false,
      },
      ...(infrastructureRetryRuns.length > 0 ? {
        infrastructure_retry_runs: infrastructureRetryRuns.map(({ attempt, retry, tasks, triggers, refs, run, leaseId, workId }) => ({
          execution_kind: "physical-infrastructure-retry", ...(leaseId ? { lease_id: leaseId } : {}), ...(workId ? { work_id: workId } : {}), attempt,
          retry,
          tasks,
          trigger_trials: triggers,
          trials: refs,
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
                : infrastructureFailures.length > 0
                  ? infrastructureErrorCode
                : "eval_has_invalid_tasks",
          message: cancelled
            ? "eval was cancelled"
            : localSourceFailure
              ? "Harbor rejected the transported local Git source before candidate execution"
              : !backendsSucceeded
                ? `Harbor work items completed ${backendRuns.length}/${expectedBackendRuns}`
                : infrastructureFailures.length > 0
                  ? `${infrastructureErrorCode === "eval_infrastructure_retries_exhausted" ? "infrastructure retries exhausted" : "verifier infrastructure failure"}: ${infrastructureFailureSlots.map(trial => `${trial.task_id}#${trial.attempt}`).join(", ")}`
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
  if (captureRuntime) await captureRuntime.close().catch((error) => sink.emit({ type: "interaction.capture.close-failed", code: (error as { code?: string }).code || "model_capture_close_failed" }));
  return finalizeEvalResult(evalDirectory, sink, result);
}
