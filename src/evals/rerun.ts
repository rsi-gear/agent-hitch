import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  runHarborBackend,
} from "../backends/index.js";
import type { HarborBackendResult } from "../backends/index.js";
import { useControllerRuntimeById } from "../controller-runtime/index.js";
import type { EvalExecutionPlanV1, EvalProgressV1, EvalRequest, EvalTrialRefV1, ModelCapturePlanV1 } from "../domain/index.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, ensureDir, invalidInput, readJSON, statePaths, withFileLock } from "../foundation/index.js";
import { readEvalProgress, replaceInvalidEvalProgressTrial, writeEvalProgress } from "./progress.js";
import { validateEvalId, validateEvalRequest } from "./request.js";
import { assertEvalRerunTypeSupported, evalRerunSemantics, parseEvalRerunType } from "./rerun-types.js";
import type { EvalRerunResult, EvalRerunType, RerunEvalOptions } from "./rerun-types.js";
import {
  attemptDirectoryName,
  formatSlot,
  invalidTrialSlots,
  selectRerunTrialSlots,
  slotKey,
  sortSlots,
  uniqueTasks,
  validateProgressPlan,
} from "./rerun-slots.js";
import type { EvalTrialSlot, RerunSelector } from "./rerun-slots.js";
import { summarizeTrialRefs } from "./result-helpers.js";
import { importEvalTrialRun, importEvalTrialRuns, TrialBundlePendingError, validateEvalTrialReferences } from "./trial-import.js";
import { collectOnlyEvalRerun } from "./collect-only-rerun.js";
import { loadRerunLocalTransport, loadRerunPreparedArtifacts, loadRerunResolvedRevision } from "./rerun-inputs.js";
import { parseEvalExecutionPlan } from "./execution-plan.js";
import { startEvalModelCaptureRuntime } from "./model-capture-runtime.js";
import type { EvalModelCaptureRuntime } from "./model-capture-runtime.js";
export { selectRerunTasks, selectRerunTrialSlots } from "./rerun-slots.js";
export type { EvalTrialSlot, RerunSelector } from "./rerun-slots.js";
interface RerunPlan {
  tasks: string[];
  attempts: number;
  attemptExecution: "legacy-single-attempt-v1" | "harbor-attempt-shards-v1" | "harbor-task-slots-v1";
  candidate: Record<string, unknown>;
  preparedArtifacts: Record<string, unknown>[];
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
  const selectedTrials = selectRerunTrialSlots(plan.tasks, plan.attempts, progress, options.selector, {
    // A candidate restart intentionally creates a clean trial and reruns the
    // Candidate Agent, so verifier-invalid slots are valid selections. Only
    // rerun modes that promise to preserve the original candidate execution
    // need the verifier-only guard.
    allowVerifierFailures: options.rerunType === "candidate-restart" || options.rerunType === "collect-only",
  });
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
  let captureRuntime: EvalModelCaptureRuntime | undefined;
  try {
    if (options.rerunType === "collect-only") return collectOnlyEvalRerun({ root: options.root, evalId: options.evalId, evalDirectory: options.evalDirectory, rerunId, rerunDirectory, startedAt, request, plan, progress, previousResult, selectedTrials, env: options.env ?? process.env });
    if (selectedTrials.length > 0) {
      const executionPlan = parseEvalExecutionPlan(await readJSON<unknown>(path.join(options.evalDirectory, "execution-plan.json")));
      if (executionPlan.eval_id !== options.evalId) throw unavailable("eval execution plan identity changed");
      captureRuntime = await startEvalModelCaptureRuntime({
        plan: executionPlan.model_capture ?? defaultModelCapturePlan(),
        evalId: options.evalId,
        evalDirectory: rerunDirectory,
        env: options.env ?? process.env,
      });
      const activeCaptureRuntime = captureRuntime;
      const resolvedRevision = await loadRerunResolvedRevision(options.evalDirectory, plan);
      const preparedArtifacts = await loadRerunPreparedArtifacts(options.root, plan);
      const runtimeId = requiredString(plan.controllerRuntime.runtime_id, "plan controller runtime id");
      const runtime = await useControllerRuntimeById(statePaths(options.root), runtimeId.replace(/^sha256:/, ""));
      if (runtime.runtime_id !== runtimeId
        || runtime.manifest_digest !== requiredString(plan.controllerRuntime.manifest_digest, "plan controller runtime digest")) {
        throw unavailable("controller runtime identity changed");
      }
      const localTransport = await loadRerunLocalTransport(options.evalDirectory, plan, resolvedRevision, options.env, options.signal);
      const groups = groupRerunSlotsByArtifact(selectedTrials, executionPlan, [...preparedArtifacts.keys()]);
      for (const { logicalAttempt, slots, artifactId, splitAttempt } of groups) {
        if (options.signal?.aborted) throw new HitchError("eval rerun was aborted", { code: "eval_rerun_aborted", exitCode: 9 });
        const taskNames = slots.map((slot) => slot.task_id);
        const selectedKeys = new Set(slots.map(slotKey));
        const attemptDirectory = plan.attempts === 1
          ? path.join(rerunDirectory, "harbor")
          : path.join(rerunDirectory, "harbor", attemptDirectoryName(logicalAttempt));
        const backendDirectory = splitAttempt ? path.join(attemptDirectory, `artifact-${artifactId.slice("sha256:".length, "sha256:".length + 16)}`) : attemptDirectory;
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
          preparedArtifact: preparedArtifacts.get(artifactId) ?? (() => { throw unavailable(`rerun artifact is unavailable: ${artifactId}`); })(),
          ...(options.executionResources ? { executionResources: options.executionResources } : {}),
          ...(activeCaptureRuntime.route ? { modelProxy: activeCaptureRuntime.route } : {}),
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
                publicationMode: "replace-invalid",
                runtimeId: runtime.runtime_id,
                env: options.env ?? process.env,
                modelCapturePlan: activeCaptureRuntime.plan,
                ...(activeCaptureRuntime.exporter ? { interactionCaptureExporter: activeCaptureRuntime.exporter } : {}),
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
          publicationMode: "replace-invalid",
          runtimeId: runtime.runtime_id,
          env: options.env ?? process.env,
          modelCapturePlan: activeCaptureRuntime.plan,
          ...(activeCaptureRuntime.exporter ? { interactionCaptureExporter: activeCaptureRuntime.exporter } : {}),
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
  } finally {
    await captureRuntime?.close().catch(() => undefined);
  }
}

function defaultModelCapturePlan(): ModelCapturePlanV1 {
  return { requested_mode: "native", effective_mode: "native", required: false };
}

export function groupRerunSlotsByArtifact(
  selected: readonly EvalTrialSlot[],
  plan: EvalExecutionPlanV1,
  persistedArtifactIds: readonly string[],
): Array<{ logicalAttempt: number; slots: EvalTrialSlot[]; artifactId: string; splitAttempt: boolean }> {
  const fallbackIds = [...new Set([
    ...plan.work_items.map((item) => item.artifact_id).filter((value): value is NonNullable<typeof value> => value !== undefined),
    ...persistedArtifactIds,
  ])];
  const groups = new Map<string, { logicalAttempt: number; slots: EvalTrialSlot[]; artifactId: string }>();
  for (const slot of selected) {
    const plannedSlot = plan.slots.find((entry) => entry.task_id === slot.task_id && entry.attempt === slot.attempt);
    const work = plannedSlot ? plan.work_items.find((entry) => entry.slots.includes(plannedSlot.slot_id)) : undefined;
    const artifactId = work?.artifact_id ?? (fallbackIds.length === 1 ? fallbackIds[0] : undefined);
    if (!artifactId) throw unavailable(`rerun slot has no artifact assignment: ${slot.task_id}#${slot.attempt}`);
    const key = `${slot.attempt}\0${artifactId}`;
    const group = groups.get(key) ?? { logicalAttempt: slot.attempt, slots: [], artifactId };
    group.slots.push(slot);
    groups.set(key, group);
  }
  const perAttempt = new Map<number, number>();
  for (const group of groups.values()) perAttempt.set(group.logicalAttempt, (perAttempt.get(group.logicalAttempt) ?? 0) + 1);
  return [...groups.values()]
    .map((group) => ({ ...group, slots: sortSlots(group.slots), splitAttempt: (perAttempt.get(group.logicalAttempt) ?? 0) > 1 }))
    .sort((left, right) => left.logicalAttempt - right.logicalAttempt || Buffer.compare(Buffer.from(left.artifactId), Buffer.from(right.artifactId)));
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
  const preparedArtifacts = Array.isArray(plan.prepared_artifacts)
    ? plan.prepared_artifacts.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : plan.prepared_artifact && typeof plan.prepared_artifact === "object" && !Array.isArray(plan.prepared_artifact)
      ? [plan.prepared_artifact as Record<string, unknown>]
      : [];
  if (!plan.candidate || typeof plan.candidate !== "object" || Array.isArray(plan.candidate)
    || preparedArtifacts.length === 0 || Array.isArray(plan.prepared_artifacts) && preparedArtifacts.length !== plan.prepared_artifacts.length
    || !plan.controller_runtime || typeof plan.controller_runtime !== "object" || Array.isArray(plan.controller_runtime)) {
    throw unavailable("eval plan is incomplete");
  }
  return {
    tasks: [...plan.tasks as string[]],
    attempts: plan.attempts as number,
    attemptExecution,
    candidate: plan.candidate as Record<string, unknown>,
    preparedArtifacts,
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
