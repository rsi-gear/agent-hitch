import path from "node:path";
import { resolveHarness } from "../artifacts/index.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, beginEvalEnvironmentImagePlanning, credentialValuesFromEnv, ensureDir, invalidInput, safeDiagnosticMessage, statePaths, withEnvironmentImageReferenceLock, writeEvalEnvironmentImageReferences } from "../foundation/index.js";
import { parseHarnessReference } from "../revisions/index.js";
import { buildLocalGitTransport, lockedHarnessRef, runHarborBackend, verifyLocalGitTransport } from "../backends/index.js";
import type { HarborBackendResult, LocalGitTransportUse } from "../backends/index.js";
import { ensureControllerRuntime, writeRuntimeReference, type ControllerRuntimeUseResult } from "../controller-runtime/index.js";
import type { EvalProgressV1, EvalTrialRefV1 } from "../domain/index.js";
import { importEvalTrialRun, importEvalTrialRuns, TrialBundlePendingError, validateEvalTrialReferences } from "./trial-import.js";
import { EvalEventSink } from "./events.js";
import { createEvalProgress, mergeEvalProgressTrial, writeEvalProgress } from "./progress.js";
import { runInfrastructureRetries, type InfrastructureRetryRun } from "./infrastructure-retry.js";
import { newEvalId, resolveLocalDatasetTaskIds, validateEvalId, validateEvalRequest } from "./request.js";
import { prepareEvalDirectory } from "./directory.js";
import { buildEvalExecutionPlan, DEFAULT_EVAL_TRIAL_RESOURCES } from "./execution-plan.js";
import { planLocalEvalInputs } from "./local-eval-planning.js";
import { resolvedImageMapping } from "./environment-image-planning.js";
import { assertBackendTrialSet, attemptDirectoryName, localSourceBackendFailure, transportSummary } from "./result-helpers.js";
import { executePlannedHarborTasks } from "./planned-execution.js";
import { assertEvalResumeState, executionPlanWorkState, loadEvalResumeState } from "./resume-state.js";
import type { EvalExecutionPhase, EvalResult, RunEvalOptions } from "./service-types.js";
import { forceLocalInferenceCapturePlan, modelCaptureDegradationEvent, resolveEvalModelCapturePlan } from "./model-capture-plan.js";
import { finalizeEvalResult } from "./eval-finalization.js";
import { prepareHostHarborArtifactForTest } from "./prepared-harness.js";
import { prepareHarborArtifact } from "./harbor-artifact-builder.js";
import { prepareEvalArtifactAssignments, preparedArtifactPlanFields } from "./eval-artifact-planning.js";
import { startEvalModelCaptureRuntime } from "./model-capture-runtime.js";
import { recoverPromotedEvalTrialPublications } from "./trial-publication-recovery.js";
import { emitEvalPlanLifecycle } from "./eval-lifecycle-events.js";
import { materializeEvalPlan, writeEvalPlanningCheckpoint, type EvalLogicalPlanV1 } from "./eval-logical-plan.js";
import { planTaskSchedulingHints, schedulingHintsFromPlan } from "./duration-estimator.js";
import type { EvalSchedulerSummaryV1 } from "../domain/index.js";
import { buildCompletedEvalResult } from "./eval-result-builder.js";
export async function runEval({ evalId = newEvalId(), request, root, env = process.env, harborExecutable, signal, onEvent, trialBundleGraceMs, precreated = false, replaceTerminal = false, normalizedRequest, maxConcurrentOverride, executionResources, executionResourceSource = "operator-default", executionStrategy = "legacy-attempt-shards", executionWorker, modelCapturePlan, workItemAdmission, remoteWorkExecutor, inferenceCoordinator, resumeExisting = false, onControlPhase, onWorkItemState, onWorkItemQueued, evolutionBaselineDurations, dockerResourceReaper, environmentBuildMode = "backend", environmentImageResolver, environmentImageBuilder, environmentImageManifestLoader, harborArtifactBuilder }: RunEvalOptions): Promise<EvalResult> {
  if (!root) throw invalidInput("a Hitch state root is required for eval");
  evalId = validateEvalId(evalId);
  const persistedRequest = normalizedRequest || await validateEvalRequest(request);
  if (maxConcurrentOverride !== undefined && (!Number.isSafeInteger(maxConcurrentOverride) || maxConcurrentOverride < 1 || maxConcurrentOverride > persistedRequest.max_concurrent)) {
    throw invalidInput("control-plane max concurrency override is invalid");
  }
  const normalized = maxConcurrentOverride === undefined ? persistedRequest : { ...persistedRequest, max_concurrent: maxConcurrentOverride };
  const evalsDirectory = await ensureDir(statePaths(root).evals);
  const evalDirectory = await prepareEvalDirectory({ evalsDirectory, evalId, request: persistedRequest, precreated, replaceTerminal });
  let startedAt = new Date();
  const sink = new EvalEventSink(evalDirectory, evalId, onEvent);
  await sink.open();
  let result: EvalResult;
  let trialRefs: import("../domain/index.js").EvalTrialRefV1[] = [];
  let progress: EvalProgressV1 | null = null;
  let schedulerSummary: EvalSchedulerSummaryV1 | undefined;
  let captureRuntime: Awaited<ReturnType<typeof startEvalModelCaptureRuntime>> | undefined;
  let inferenceLease: Awaited<ReturnType<import("../domain/index.js").ManagedInferenceCoordinator["acquire"]>> | undefined;
  let failureStage: EvalExecutionPhase = "planning";
  try {
    const planningStartedAt = Date.now();
    sink.emit({ type: "eval.started", backend: normalized.backend, dataset: normalized.dataset });
    sink.emit({ type: "eval.planning.started" });
    await onControlPhase?.("planning");
    const requestedReference = parseHarnessReference(normalized.harness_ref);
    const resolvedRevision = await resolveHarness(normalized.harness_ref, { root, env });
    failureStage = "preparing";
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
    await withEnvironmentImageReferenceLock(root, () => beginEvalEnvironmentImagePlanning(evalDirectory, evalId));
    const localPlanning = await planLocalEvalInputs({ root, dataset: normalized.dataset, taskIds: localTaskIds, defaultResources: executionResources ?? DEFAULT_EVAL_TRIAL_RESOURCES, defaultSource: executionResourceSource, benchmarkId: normalized.benchmark_id, benchmarkRevision: normalized.benchmark_revision, buildMode: environmentBuildMode, harborTaskResourceInspector: path.join(controllerRuntime.directory, "payload", "integrations", "harbor", "hitch_harbor_task_resources.py"), ...(environmentImageResolver ? { resolver: environmentImageResolver } : {}), ...(environmentImageBuilder ? { builder: environmentImageBuilder } : {}), ...(resume ? { resumePlan: resume.executionPlan } : {}), ...(harborExecutable ? { harborExecutable } : {}), env, ...(signal ? { signal } : {}) });
    await withEnvironmentImageReferenceLock(root, () => writeEvalEnvironmentImageReferences(evalDirectory, evalId, localPlanning.environmentImages));
    const taskResources = localPlanning.taskResources;
    const plannedTasks = localTaskIds?.length ?? null;
    const plannedTrials = plannedTasks === null ? null : plannedTasks * normalized.attempts;
    if (plannedTrials !== null && !Number.isSafeInteger(plannedTrials)) throw invalidInput("planned trial count exceeds the safe integer range");
    if (resume) startedAt = new Date(resume.progress.started_at);
    const capture = resolveEvalModelCapturePlan({ requested: modelCapturePlan, resumed: resume?.executionPlan.model_capture, resuming: Boolean(resume) });
    if (normalized.local_inference) {
      capture.plan = forceLocalInferenceCapturePlan(capture.plan);
      capture.persist = true;
      if (!inferenceCoordinator) throw new HitchError("local eval inference requires the Hitch daemon", { code: "inference_route_unavailable", exitCode: 12 });
      const resumedInferenceId = (resume?.plan.candidate as Record<string, unknown> | undefined)?.inference_id;
      if (resumedInferenceId !== undefined && (typeof resumedInferenceId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(resumedInferenceId))) {
        throw new HitchError("persisted local inference identity is invalid", { code: "inference_lock_mismatch", exitCode: 12 });
      }
      inferenceLease = await inferenceCoordinator.acquire({
        run_id: `run_${evalId.slice("eval_".length)}`,
        harness_ref: normalized.harness_ref,
        selection: resumedInferenceId
          ? { ...normalized.local_inference, inference_id: resumedInferenceId as import("../domain/index.js").Sha256 }
          : normalized.local_inference,
        cache_scope_owner: evalId,
        evidence_owner: { kind: "eval", eval_id: evalId },
        ...(signal ? { signal } : {}),
        on_event: (event) => sink.emit(event),
      });
    }
    const multipleRuntimeContracts = localPlanning.taskRuntimeContracts.length > 1;
    const logicalPlan: EvalLogicalPlanV1 = {
      schema_version: SCHEMA_VERSION,
      kind: "eval-logical-plan",
      eval_id: evalId,
      backend: "harbor",
      candidate: {
        id: "candidate-1", requested_harness_ref: normalized.harness_ref,
        harness_ref: lockedHarnessRef(resolvedRevision), harness_id: resolvedRevision.harness_id,
        revision_identity: resolvedRevision.identity, model: normalized.model || null,
        ...(inferenceLease ? { inference_id: inferenceLease.lock.inference_id } : {}),
      },
      dataset: normalized.dataset,
      benchmark_id: normalized.benchmark_id,
      benchmark_revision: normalized.benchmark_revision,
      attempts: normalized.attempts,
      attempt_execution: (executionStrategy === "local-task-slots-v1" || multipleRuntimeContracts) && localTaskIds !== null
        ? "harbor-task-slots-v1"
        : "harbor-attempt-shards-v1",
      max_concurrent: normalized.max_concurrent,
      ...(capture.persist ? { model_capture: capture.plan } : {}),
      infrastructure_retries: normalized.infrastructure_retries,
      infrastructure_retry_backoff_ms: normalized.infrastructure_retry_backoff_ms,
      ...(localTaskIds === null ? {} : { tasks: localTaskIds }),
      controller_runtime: { runtime_id: controllerRuntime.runtime_id, manifest_digest: controllerRuntime.manifest_digest },
      ...(localTransport ? { local_source_transport: transportSummary(localTransport) } : {}),
      created_at: typeof resume?.plan.created_at === "string" ? resume.plan.created_at : new Date().toISOString(),
    };
    progress = resume?.progress ?? createEvalProgress({
      evalId,
      benchmarkId: normalized.benchmark_id,
      benchmarkRevision: normalized.benchmark_revision,
      plannedTasks,
      plannedTrials,
      startedAt: startedAt.toISOString(),
    });
    if (!resume) await Promise.all([
      atomicWriteJSON(path.join(evalDirectory, "resolution.json"), resolvedRevision),
      writeEvalPlanningCheckpoint(evalDirectory, logicalPlan, progress),
    ]);
    const selectedArtifactBuilder = harborArtifactBuilder ?? (env.NODE_ENV === "test" && env.HITCH_TEST_HOST_ARTIFACT_BUILDER === "1" ? prepareHostHarborArtifactForTest : prepareHarborArtifact);
    const prepared = await prepareEvalArtifactAssignments({ builder: selectedArtifactBuilder, root, resolvedRevision, requestedReference, controllerRuntime, ...(localTransport ? { localTransport } : {}), taskRuntimeContracts: localPlanning.taskRuntimeContracts, sink, env, ...(signal ? { signal } : {}) });
    const preparedAssignments = prepared.assignments;
    const preparedArtifact = prepared.primary;
    const preparedArtifacts = prepared.artifactsById;
    const activeCaptureRuntime = await startEvalModelCaptureRuntime({
      plan: capture.plan, evalId, evalDirectory, env,
      ...(inferenceLease ? { managedInference: {
        binding: inferenceLease.binding, credential: inferenceLease.credential, modelId: inferenceLease.lock.model_id,
      } } : {}),
    });
    captureRuntime = activeCaptureRuntime;
    capture.plan = activeCaptureRuntime.plan;
    const plan = materializeEvalPlan(logicalPlan, capture.persist ? capture.plan : undefined, preparedArtifactPlanFields(preparedAssignments));
    const taskSlotPlanning = (executionStrategy === "local-task-slots-v1" || multipleRuntimeContracts) && localTaskIds !== null;
    const taskScheduling = taskSlotPlanning
      ? resume
        ? schedulingHintsFromPlan(resume.executionPlan)
        : await planTaskSchedulingHints({
          root,
          dataset: normalized.dataset,
          taskIds: localTaskIds,
          benchmarkId: normalized.benchmark_id,
          benchmarkRevision: normalized.benchmark_revision,
          provider: executionWorker?.provider ?? "local-docker",
          model: normalized.model,
          requestTimeoutMs: normalized.timeout_ms,
          infrastructureRetries: normalized.infrastructure_retries,
          ...(evolutionBaselineDurations ? { evolutionBaselineDurations } : {}),
        })
      : undefined;
    const expectedExecutionPlan = buildEvalExecutionPlan({
      evalId,
      request: normalized,
      candidate: {
        revisionIdentity: resolvedRevision.identity,
        artifactId: preparedArtifact.artifact_id,
        ...(inferenceLease ? { inferenceId: inferenceLease.lock.inference_id } : {}),
        artifactAssignments: preparedAssignments.map((entry) => ({
          taskIds: entry.taskIds,
          artifactId: entry.artifact.artifact_id,
          runtimeContract: {
            docker_platform: entry.runtimeContract.dockerPlatform,
            artifact_platform: entry.runtimeContract.artifactPlatform,
            node_version: entry.runtimeContract.nodeVersion,
          },
        })),
      },
      tasks: localTaskIds,
      maxParallelism: normalized.max_concurrent,
      ...(executionResources ? { trialResources: executionResources } : {}),
      ...(taskResources ? { taskResources } : {}),
      ...(localPlanning.environmentImages.length > 0 ? { environmentImages: localPlanning.environmentImages } : {}),
      ...(localPlanning.environmentImageFallbacks.length > 0 ? { environmentImageFallbacks: localPlanning.environmentImageFallbacks } : {}),
      ...(executionWorker ? { provider: executionWorker.provider } : {}),
      modelCapture: capture.persist ? capture.plan : null,
      ...(taskSlotPlanning ? { workItemMode: "task-slots" as const } : {}),
      ...(taskScheduling ? { taskScheduling } : {}),
      createdAt: logicalPlan.created_at,
    });
    if (resume) assertEvalResumeState({ state: resume, expectedPlan: plan, expectedExecutionPlan, expectedResolutionIdentity: resolvedRevision.identity, plannedTasks, plannedTrials });
    else await Promise.all([
      atomicWriteJSON(path.join(evalDirectory, "plan.json"), plan),
      atomicWriteJSON(path.join(evalDirectory, "execution-plan.json"), expectedExecutionPlan),
    ]);
    const executionPlan = resume?.executionPlan ?? expectedExecutionPlan;
    const captureDegradation = modelCaptureDegradationEvent(executionPlan.model_capture); if (captureDegradation) sink.emit(captureDegradation);
    if (resume) progress = (await recoverPromotedEvalTrialPublications({ root, evalDirectory, plan: executionPlan, progress, sink })).progress;
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
    sink.emit({
      type: "eval.execution-strategy.verified",
      execution_strategy: taskSlotPlanning ? "local-task-slots-v1" : "legacy-attempt-shards",
      attempt_execution: plan.attempt_execution,
      controller_runtime_id: controllerRuntime.runtime_id,
      harness_revision_identity: resolvedRevision.identity,
      membership: executionPlan.membership,
      planned_trials: plannedTrials,
      work_items: executionPlan.work_items.length,
    });
    emitEvalPlanLifecycle(sink, executionPlan, planningStartedAt);
    failureStage = "running";
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
    const plannedTaskExecution = (executionStrategy === "local-task-slots-v1" || multipleRuntimeContracts) && localTaskIds !== null;
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
        preparedArtifacts,
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
        ...(onWorkItemQueued ? { onWorkItemQueued } : {}),
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
      schedulerSummary = execution.schedulerSummary;
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
              env, ...(signal ? { signal } : {}),
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
        env, ...(signal ? { signal } : {}),
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
    failureStage = "finalizing";
    await onControlPhase?.("finalizing");
    trialRefs = progress.trials;
    result = buildCompletedEvalResult({
      evalId, request: normalized, plannedTaskExecution, plannedTrials,
      executionWorkItems: executionPlan.work_items.length, localTaskIds, backendRuns,
      infrastructureRetryRuns, candidate: plan.candidate, progress,
      ...(schedulerSummary ? { schedulerSummary } : {}), preparedAssignments,
      ...(localTransport ? { localTransport } : {}), startedAt,
      cancelled: signal?.aborted === true,
    });
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
        message: safeDiagnosticMessage(error, credentialValuesFromEnv(normalized.pass_env, env)),
      },
      failure_stage: failureStage,
      benchmark_id: normalized.benchmark_id,
      benchmark_revision: normalized.benchmark_revision,
      ...(progress === null ? {} : { generation: progress.generation }),
      trials: trialRefs,
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
    };
  }
  if (captureRuntime) await captureRuntime.close().catch((error) => sink.emit({ type: "interaction.capture.close-failed", code: (error as { code?: string }).code || "model_capture_close_failed" }));
  if (inferenceLease) await inferenceLease.release().catch((error) => sink.emit({ type: "inference.release.failed", code: (error as { code?: string }).code || "inference_release_failed" }));
  return finalizeEvalResult(evalDirectory, sink, result);
}
