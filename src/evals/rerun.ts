import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadPreparedArtifact, preparedArtifactDirectory } from "../artifacts/index.js";
import type { ResolvedRevision } from "../artifacts/index.js";
import {
  runHarborBackend,
  validateLocalGitTransportManifest,
  verifyLocalGitTransport,
} from "../backends/index.js";
import type { HarborBackendResult, HarborPreparedArtifactUse, LocalGitTransportUse } from "../backends/index.js";
import { useControllerRuntimeById } from "../controller-runtime/index.js";
import type { EvalProgressV1, EvalRequest, EvalTrialRefV1 } from "../domain/index.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, ensureDir, invalidInput, readJSON, statePaths, withFileLock } from "../foundation/index.js";
import { readEvalProgress, replaceInvalidEvalProgressTrial, writeEvalProgress } from "./progress.js";
import { validateEvalId, validateEvalRequest } from "./request.js";
import { assertEvalRerunTypeSupported, evalRerunSemantics, parseEvalRerunType } from "./rerun-types.js";
import type { EvalRerunResult, EvalRerunType, RerunEvalOptions } from "./rerun-types.js";
import {
  attemptDirectoryName,
  formatSlot,
  groupSlotsByAttempt,
  invalidTrialSlots,
  selectRerunTrialSlots,
  slotKey,
  sortSlots,
  uniqueTasks,
  validateProgressPlan,
} from "./rerun-slots.js";
import type { EvalTrialSlot, RerunSelector } from "./rerun-slots.js";
import { summarizeTrialRefs } from "./service.js";
import { importEvalTrialRun, importEvalTrialRuns, TrialBundlePendingError, validateEvalTrialReferences } from "./trial-import.js";

export { selectRerunTasks, selectRerunTrialSlots } from "./rerun-slots.js";
export type { EvalTrialSlot, RerunSelector } from "./rerun-slots.js";
interface RerunPlan {
  tasks: string[];
  attempts: number;
  attemptExecution: "legacy-single-attempt-v1" | "harbor-attempt-shards-v1" | "harbor-task-slots-v1";
  candidate: Record<string, unknown>;
  preparedArtifact: Record<string, unknown>;
  controllerRuntime: Record<string, unknown>;
  localSourceTransport?: Record<string, unknown>;
}

export async function rerunEval(options: RerunEvalOptions): Promise<EvalRerunResult> {
  if (!options.root) throw invalidInput("a Hitch state root is required for eval rerun");
  const rerunType = parseEvalRerunType(options.rerunType ?? "candidate-restart");
  assertEvalRerunTypeSupported(rerunType);
  const evalId = validateEvalId(options.evalId);
  const rerunId = options.rerunId ?? `rerun_${randomUUID().replaceAll("-", "")}`;
  if (!/^rerun_[a-f0-9]{32}$/.test(rerunId)) throw invalidInput("eval rerun id is invalid");
  const evalDirectory = path.join(statePaths(options.root).evals, evalId);
  return withFileLock(
    path.join(evalDirectory, "reruns"),
    "active",
    () => rerunEvalLocked({ ...options, rerunId, rerunType, evalId, evalDirectory }),
    { timeoutCode: "eval_rerun_active", timeoutExitCode: 2, ...(options.signal ? { signal: options.signal } : {}) },
  );
}

async function rerunEvalLocked(options: RerunEvalOptions & { rerunId: string; rerunType: EvalRerunType; evalId: string; evalDirectory: string }): Promise<EvalRerunResult> {
  const startedAt = new Date().toISOString();
  const rerunId = options.rerunId;
  const rerunDirectory = path.join(options.evalDirectory, "reruns", rerunId);
  const statePath = path.join(rerunDirectory, "state.json");
  const existingState = await readJSON<{ status?: unknown } | null>(statePath, null);
  if (existingState && existingState.status !== "queued" && existingState.status !== "running") throw new HitchError("eval rerun id already reached a terminal state", { code: "eval_rerun_id_conflict", exitCode: 2 });
  await ensureDir(rerunDirectory);
  const requestValue = await readJSON<unknown | null>(path.join(options.evalDirectory, "request.json"), null);
  if (requestValue === null) throw new HitchError(`eval not found: ${options.evalId}`, { code: "eval_not_found", exitCode: 3 });
  const request = await loadPersistedRequest(requestValue);
  if (options.maxConcurrentOverride !== undefined && (!Number.isSafeInteger(options.maxConcurrentOverride)
    || options.maxConcurrentOverride < 1 || options.maxConcurrentOverride > request.max_concurrent)) {
    throw invalidInput("eval rerun concurrency override is invalid");
  }
  const plan = parseRerunPlan(await readJSON<unknown>(path.join(options.evalDirectory, "plan.json")), options.evalId, request);
  const initialProgress = await readEvalProgress(options.evalDirectory);
  if (initialProgress === null) throw unavailable("eval has no task-level progress");
  let progress: EvalProgressV1 = initialProgress;
  validateProgressPlan(progress, plan, request, options.evalId);
  const previousResult = await readJSON<Record<string, unknown> | null>(path.join(options.evalDirectory, "result.json"), null);
  if (previousResult?.status === "cancelled") throw new HitchError("cancelled eval cannot be rerun", { code: "eval_rerun_cancelled", exitCode: 2 });
  const selectedTrials = selectRerunTrialSlots(plan.tasks, plan.attempts, progress, options.selector);
  const selectedTasks = uniqueTasks(selectedTrials);
  await atomicWriteJSON(path.join(rerunDirectory, "request.json"), {
    schema_version: SCHEMA_VERSION,
    rerun_id: rerunId,
    eval_id: options.evalId,
    rerun_type: options.rerunType,
    semantics: evalRerunSemantics(options.rerunType),
    mode: options.selector.mode,
    tasks: selectedTasks,
    trials: selectedTrials,
    base_generation: progress.generation,
    created_at: startedAt,
  });
  await writeRerunState(statePath, {
    rerunId,
    evalId: options.evalId,
    rerunType: options.rerunType,
    status: "running",
    tasks: selectedTasks,
    trials: selectedTrials,
    repairedTasks: [],
    repairedTrials: [],
    startedAt,
  });

  const repaired = new Map<string, EvalTrialSlot>();
  const backendRuns: Array<{ attempt: number; run: HarborBackendResult }> = [];
  try {
    if (selectedTrials.length > 0) {
      const resolvedRevision = await loadResolvedRevision(options.evalDirectory, plan);
      const preparedArtifact = await loadRerunArtifact(options.root, plan);
      const runtimeId = requiredString(plan.controllerRuntime.runtime_id, "plan controller runtime id");
      const runtime = await useControllerRuntimeById(statePaths(options.root), runtimeId.replace(/^sha256:/, ""));
      if (runtime.runtime_id !== runtimeId
        || runtime.manifest_digest !== requiredString(plan.controllerRuntime.manifest_digest, "plan controller runtime digest")) {
        throw unavailable("controller runtime identity changed");
      }
      const localTransport = await loadLocalTransport(options.evalDirectory, plan, resolvedRevision, options.env, options.signal);
      const groups = groupSlotsByAttempt(selectedTrials);
      for (const [logicalAttempt, slots] of groups) {
        if (options.signal?.aborted) throw new HitchError("eval rerun was aborted", { code: "eval_rerun_aborted", exitCode: 9 });
        const taskNames = slots.map((slot) => slot.task_id);
        const selectedKeys = new Set(slots.map(slotKey));
        const backendDirectory = plan.attempts === 1
          ? path.join(rerunDirectory, "harbor")
          : path.join(rerunDirectory, "harbor", attemptDirectoryName(logicalAttempt));
        const harborJobDirectory = path.join(backendDirectory, "job");
        const rerunRefs: EvalTrialRefV1[] = [];
        const publish = async (ref: EvalTrialRefV1): Promise<void> => {
          const slot = { task_id: ref.task_id, attempt: ref.attempt };
          const key = slotKey(slot);
          if (!selectedKeys.has(key)) {
            throw new HitchError(`Harbor rerun returned an unselected trial: ${ref.task_id} attempt ${ref.attempt}`, {
              code: "eval_rerun_trial_mismatch",
              exitCode: 12,
            });
          }
          if (!rerunRefs.some((current) => current.trial_id === ref.trial_id)) rerunRefs.push(ref);
          if (ref.observation_status !== "valid") return;
          await validateEvalTrialReferences(options.root, options.evalId, [ref], {
            benchmarkId: request.benchmark_id,
            benchmarkRevision: request.benchmark_revision,
          });
          const previousGeneration = progress.generation;
          progress = replaceInvalidEvalProgressTrial(progress, ref);
          if (progress.generation === previousGeneration) return;
          repaired.set(key, slot);
          await writeEvalProgress(options.evalDirectory, progress);
          await writeRerunState(statePath, {
            rerunId,
            evalId: options.evalId,
            rerunType: options.rerunType,
            status: "running",
            tasks: selectedTasks,
            trials: selectedTrials,
            repairedTasks: uniqueTasks([...repaired.values()]),
            repairedTrials: sortSlots([...repaired.values()]),
            startedAt,
          });
        };
        const backendRun = await runHarborBackend({
          evalId: options.evalId,
          evalDirectory: options.evalDirectory,
          backendDirectory,
          logicalAttempt,
          taskNames,
          request: { ...request, attempts: 1, max_concurrent: options.maxConcurrentOverride ?? request.max_concurrent },
          root: options.root,
          resolvedRevision,
          runtimeDirectory: runtime.directory,
          runtimeId: runtime.runtime_id,
          preparedArtifact,
          ...(options.executionResources ? { executionResources: options.executionResources } : {}),
          ...(localTransport ? { localTransport } : {}),
          env: options.env ?? process.env,
          ...(options.harborExecutable === undefined ? {} : { harborExecutable: options.harborExecutable }),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.trialBundleGraceMs === undefined ? {} : { trialBundleGraceMs: options.trialBundleGraceMs }),
          onTrialSettled: async (trial, context): Promise<boolean> => {
            try {
              const ref = await importEvalTrialRun({
                root: options.root,
                evalId: options.evalId,
                evalDirectory: options.evalDirectory,
                harborJobDirectory,
                expectedAttempt: logicalAttempt,
                request,
                resolvedRevision,
                benchmarkId: request.benchmark_id,
                benchmarkRevision: request.benchmark_revision,
                runtimeId: runtime.runtime_id,
                requireCompleteMarker: true,
                allowMissingBundleDiagnostic: context.bundleWaitExpired,
              }, trial, rerunRefs.length, rerunRefs);
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
          root: options.root,
          evalId: options.evalId,
          evalDirectory: options.evalDirectory,
          harborJobDirectory,
          expectedAttempt: logicalAttempt,
          request,
          resolvedRevision,
          benchmarkId: request.benchmark_id,
          benchmarkRevision: request.benchmark_revision,
          runtimeId: runtime.runtime_id,
          rawResult: backendRun.rawResult,
        }, rerunRefs);
        for (const ref of terminalRefs) await publish(ref);
        if (backendRun.backend.process_exit_code !== 0 || backendRun.rawResult === null) {
          throw new HitchError("Harbor rerun failed before producing a complete result", { code: "eval_rerun_harbor_failed", exitCode: 13 });
        }
      }
    }

    const result = await finalizeRerun(options.evalDirectory, request, plan, progress, previousResult, backendRuns);
    const remainingTrials = invalidTrialSlots(plan.tasks, plan.attempts, progress);
    const remaining = uniqueTasks(remainingTrials);
    const repairedTrials = sortSlots([...repaired.values()]);
    const completedAt = new Date().toISOString();
    const output: EvalRerunResult = {
      schema_version: "1",
      kind: "eval-rerun",
      rerun_id: rerunId,
      rerun_type: options.rerunType,
      semantics: evalRerunSemantics(options.rerunType),
      eval_id: options.evalId,
      status: "completed",
      selected_tasks: selectedTasks,
      repaired_tasks: uniqueTasks(repairedTrials),
      remaining_invalid_tasks: remaining,
      selected_trials: selectedTrials,
      repaired_trials: repairedTrials,
      remaining_invalid_trials: remainingTrials,
      eval_status: result.status as "succeeded" | "failed",
      started_at: startedAt,
      completed_at: completedAt,
    };
    await writeRerunState(statePath, {
      rerunId,
      evalId: options.evalId,
      rerunType: options.rerunType,
      status: "completed",
      tasks: selectedTasks,
      trials: selectedTrials,
      repairedTasks: output.repaired_tasks,
      repairedTrials,
      startedAt,
      completedAt,
      evalStatus: output.eval_status,
      remainingInvalidTasks: remaining,
      remainingInvalidTrials: remainingTrials,
    });
    return output;
  } catch (error) {
    await finalizeRerun(options.evalDirectory, request, plan, progress, previousResult, backendRuns).catch(() => {});
    await writeRerunState(statePath, {
      rerunId,
      evalId: options.evalId,
      rerunType: options.rerunType,
      status: "failed",
      tasks: selectedTasks,
      trials: selectedTrials,
      repairedTasks: uniqueTasks([...repaired.values()]),
      repairedTrials: sortSlots([...repaired.values()]),
      startedAt,
      completedAt: new Date().toISOString(),
      errorCode: error instanceof HitchError ? error.code : "eval_rerun_failed",
    }).catch(() => {});
    throw error;
  }
}

function parseRerunPlan(value: unknown, evalId: string, request: EvalRequest): RerunPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable("eval plan is missing");
  const plan = value as Record<string, unknown>;
  if (plan.eval_id !== evalId || plan.schema_version !== "1") {
    throw unavailable("eval rerun requires a schema v1 plan");
  }
  if (!Number.isSafeInteger(plan.attempts) || (plan.attempts as number) < 1 || plan.attempts !== request.attempts) {
    throw unavailable("eval request and attempt plan differ");
  }
  let attemptExecution: RerunPlan["attemptExecution"];
  if (plan.attempt_execution === undefined && plan.attempts === 1) {
    attemptExecution = "legacy-single-attempt-v1";
  } else if (plan.attempt_execution === "harbor-attempt-shards-v1") {
    attemptExecution = "harbor-attempt-shards-v1";
  } else if (plan.attempt_execution === "harbor-task-slots-v1") {
    attemptExecution = "harbor-task-slots-v1";
  } else if (plan.attempt_execution === undefined) {
    throw new HitchError(
      "eval was created without explicit logical-attempt identity; create a new eval with agent-hitch >= 0.2.5",
      { code: "eval_rerun_legacy_attempt_identity", exitCode: 2 },
    );
  } else {
    throw unavailable(`unsupported eval attempt execution: ${String(plan.attempt_execution)}`);
  }
  if (plan.dataset !== request.dataset || plan.benchmark_id !== request.benchmark_id
    || plan.benchmark_revision !== request.benchmark_revision) throw unavailable("eval request and plan identity differ");
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0 || plan.tasks.some((task) => typeof task !== "string" || task.length === 0)) {
    throw unavailable("eval rerun requires a frozen local task plan");
  }
  if (!plan.candidate || typeof plan.candidate !== "object" || Array.isArray(plan.candidate)
    || !plan.prepared_artifact || typeof plan.prepared_artifact !== "object" || Array.isArray(plan.prepared_artifact)
    || !plan.controller_runtime || typeof plan.controller_runtime !== "object" || Array.isArray(plan.controller_runtime)) {
    throw unavailable("eval plan is incomplete");
  }
  return {
    tasks: [...plan.tasks as string[]],
    attempts: plan.attempts as number,
    attemptExecution,
    candidate: plan.candidate as Record<string, unknown>,
    preparedArtifact: plan.prepared_artifact as Record<string, unknown>,
    controllerRuntime: plan.controller_runtime as Record<string, unknown>,
    ...(plan.local_source_transport && typeof plan.local_source_transport === "object" && !Array.isArray(plan.local_source_transport)
      ? { localSourceTransport: plan.local_source_transport as Record<string, unknown> }
      : {}),
  };
}

async function loadPersistedRequest(value: unknown): Promise<EvalRequest> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable("eval request is invalid");
  const persisted = value as Record<string, unknown>;
  const input = Object.fromEntries(Object.entries(persisted).filter(([key]) => key !== "benchmark_id" && key !== "benchmark_revision"));
  const request = await validateEvalRequest(input);
  if (persisted.benchmark_id !== request.benchmark_id || persisted.benchmark_revision !== request.benchmark_revision) {
    throw unavailable("eval dataset identity changed since the original run");
  }
  return request;
}

async function loadResolvedRevision(evalDirectory: string, plan: RerunPlan): Promise<ResolvedRevision> {
  const resolution = await readJSON<ResolvedRevision>(path.join(evalDirectory, "resolution.json"));
  if (!resolution || resolution.identity !== requiredString(plan.candidate.revision_identity, "candidate revision identity")
    || resolution.harness_id !== requiredString(plan.candidate.harness_id, "candidate harness id")) {
    throw unavailable("eval resolution identity changed");
  }
  return resolution;
}

async function loadRerunArtifact(root: string, plan: RerunPlan): Promise<HarborPreparedArtifactUse> {
  const summary = plan.preparedArtifact;
  const artifactId = requiredString(summary.artifact_id, "prepared artifact id");
  const artifact = await loadPreparedArtifact(preparedArtifactDirectory(root, artifactId), {
    artifact_id: artifactId,
    artifact_integrity: requiredString(summary.artifact_integrity, "prepared artifact integrity"),
    entrypoint_integrity: requiredString(summary.entrypoint_integrity, "prepared artifact entrypoint integrity"),
    harness_id: requiredString(summary.harness_id, "prepared artifact harness id"),
    revision_identity: requiredString(summary.revision_identity, "prepared artifact revision identity"),
    platform: requiredString(summary.platform, "prepared artifact platform"),
  });
  return {
    directory: preparedArtifactDirectory(root, artifact.artifact_id),
    artifact_id: artifact.artifact_id,
    artifact_integrity: requiredString(artifact.artifact_integrity, "artifact integrity"),
    entrypoint_integrity: requiredString(artifact.entrypoint_integrity, "artifact entrypoint integrity"),
    harness_id: artifact.harness_id,
    revision_identity: artifact.revision_identity,
    adapter_version: artifact.adapter_version,
    recipe_version: artifact.recipe_version,
    platform: artifact.platform,
    node_version: artifact.toolchain.node || process.version,
    source_type: artifact.source_type,
  };
}

async function loadLocalTransport(
  evalDirectory: string,
  plan: RerunPlan,
  resolution: ResolvedRevision,
  env: NodeJS.ProcessEnv | undefined,
  signal: AbortSignal | undefined,
): Promise<LocalGitTransportUse | undefined> {
  if (plan.localSourceTransport === undefined) return undefined;
  const directory = path.join(evalDirectory, "local-source");
  const manifestPath = path.join(directory, "manifest.json");
  const use: LocalGitTransportUse = {
    directory,
    manifestPath,
    payloadPath: path.join(directory, "payload.pack"),
    resolutionPath: path.join(directory, "resolution.json"),
    manifest: validateLocalGitTransportManifest(await readJSON(manifestPath)),
  };
  await verifyLocalGitTransport(use, {
    expected: {
      harnessId: resolution.harness_id,
      resolutionIdentity: resolution.identity,
      commit: requiredString(resolution.revision.commit, "local source commit"),
    },
    env: env ?? process.env,
    ...(signal ? { signal } : {}),
  });
  return use;
}

async function finalizeRerun(
  evalDirectory: string,
  request: EvalRequest,
  plan: RerunPlan,
  progress: EvalProgressV1,
  previousResult: Record<string, unknown> | null,
  backendRuns: ReadonlyArray<{ attempt: number; run: HarborBackendResult }> = [],
): Promise<Record<string, unknown>> {
  const remainingTrials = invalidTrialSlots(plan.tasks, plan.attempts, progress);
  const remaining = uniqueTasks(remainingTrials);
  const succeeded = remainingTrials.length === 0;
  const completedAt = new Date().toISOString();
  const singleBackend = backendRuns.length === 1 ? backendRuns[0]!.run : undefined;
  const result: Record<string, unknown> = {
    ...(previousResult ?? {}),
    schema_version: SCHEMA_VERSION,
    eval_id: progress.eval_id,
    status: succeeded ? "succeeded" : "failed",
    exit_code: succeeded ? 0 : 13,
    ...(singleBackend ? { backend: singleBackend.backend, backend_summary: singleBackend.summary } : {}),
    ...(backendRuns.length > 1 ? {
      backend_runs: backendRuns.map(({ attempt, run }) => ({
        attempt,
        backend: run.backend,
        backend_summary: run.summary,
      })),
    } : {}),
    candidate: plan.candidate,
    dataset: request.dataset,
    benchmark_id: request.benchmark_id,
    benchmark_revision: request.benchmark_revision,
    generation: progress.generation,
    trials: progress.trials,
    summary: summarizeTrialRefs(progress.trials),
    ...(succeeded ? { error: undefined } : {
      error: {
        code: "eval_has_invalid_tasks",
        message: `eval has invalid or missing trials: ${remainingTrials.map(formatSlot).join(", ")}`,
      },
    }),
    started_at: typeof previousResult?.started_at === "string" ? previousResult.started_at : progress.started_at,
    completed_at: completedAt,
  };
  if (succeeded) delete result.error;
  await atomicWriteJSON(path.join(evalDirectory, "result.json"), result);
  return result;
}

async function writeRerunState(file: string, input: {
  rerunId: string;
  evalId: string;
  rerunType: EvalRerunType;
  status: "running" | "completed" | "failed";
  tasks: readonly string[];
  trials?: readonly EvalTrialSlot[];
  repairedTasks: readonly string[];
  repairedTrials?: readonly EvalTrialSlot[];
  startedAt: string;
  completedAt?: string;
  evalStatus?: "succeeded" | "failed";
  remainingInvalidTasks?: readonly string[];
  remainingInvalidTrials?: readonly EvalTrialSlot[];
  errorCode?: string;
}): Promise<void> {
  await atomicWriteJSON(file, {
    schema_version: SCHEMA_VERSION,
    rerun_id: input.rerunId,
    eval_id: input.evalId,
    rerun_type: input.rerunType,
    semantics: evalRerunSemantics(input.rerunType),
    status: input.status,
    tasks: [...input.tasks],
    ...(input.trials ? { trials: sortSlots(input.trials) } : {}),
    repaired_tasks: [...input.repairedTasks],
    ...(input.repairedTrials ? { repaired_trials: sortSlots(input.repairedTrials) } : {}),
    ...(input.evalStatus ? { eval_status: input.evalStatus } : {}),
    ...(input.remainingInvalidTasks ? { remaining_invalid_tasks: [...input.remainingInvalidTasks] } : {}),
    ...(input.remainingInvalidTrials ? { remaining_invalid_trials: sortSlots(input.remainingInvalidTrials) } : {}),
    ...(input.errorCode ? { error: { code: input.errorCode } } : {}),
    started_at: input.startedAt,
    ...(input.completedAt ? { completed_at: input.completedAt } : {}),
    updated_at: input.completedAt ?? new Date().toISOString(),
  });
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw unavailable(`${label} is missing`);
  return value;
}

function unavailable(message: string): HitchError {
  return new HitchError(message, { code: "eval_rerun_unavailable", exitCode: 2 });
}
