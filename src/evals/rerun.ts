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
import { evalTrialKey, readEvalProgress, replaceInvalidEvalProgressTrial, writeEvalProgress } from "./progress.js";
import { validateEvalId, validateEvalRequest } from "./request.js";
import { summarizeTrialRefs } from "./service.js";
import { importEvalTrialRun, importEvalTrialRuns, TrialBundlePendingError, validateEvalTrialReferences } from "./trial-import.js";

export type RerunSelector =
  | { mode: "invalid" }
  | { mode: "tasks"; taskNames: readonly string[] };

export interface RerunEvalOptions {
  evalId: string;
  selector: RerunSelector;
  root: string;
  env?: NodeJS.ProcessEnv;
  harborExecutable?: string;
  signal?: AbortSignal;
  trialBundleGraceMs?: number;
}

export interface EvalRerunResult {
  schema_version: "1";
  kind: "eval-rerun";
  rerun_id: string;
  eval_id: string;
  status: "completed";
  selected_tasks: string[];
  repaired_tasks: string[];
  remaining_invalid_tasks: string[];
  eval_status: "succeeded" | "failed";
  started_at: string;
  completed_at: string;
}

interface RerunPlan {
  tasks: string[];
  candidate: Record<string, unknown>;
  preparedArtifact: Record<string, unknown>;
  controllerRuntime: Record<string, unknown>;
  localSourceTransport?: Record<string, unknown>;
}

export async function rerunEval(options: RerunEvalOptions): Promise<EvalRerunResult> {
  if (!options.root) throw invalidInput("a Hitch state root is required for eval rerun");
  const evalId = validateEvalId(options.evalId);
  const evalDirectory = path.join(statePaths(options.root).evals, evalId);
  return withFileLock(
    path.join(evalDirectory, "reruns"),
    "active",
    () => rerunEvalLocked({ ...options, evalId, evalDirectory }),
    { timeoutCode: "eval_rerun_active", timeoutExitCode: 2, ...(options.signal ? { signal: options.signal } : {}) },
  );
}

async function rerunEvalLocked(options: RerunEvalOptions & { evalId: string; evalDirectory: string }): Promise<EvalRerunResult> {
  const startedAt = new Date().toISOString();
  const rerunId = `rerun_${randomUUID().replaceAll("-", "")}`;
  const rerunDirectory = await ensureDir(path.join(options.evalDirectory, "reruns", rerunId));
  const statePath = path.join(rerunDirectory, "state.json");
  const requestValue = await readJSON<unknown | null>(path.join(options.evalDirectory, "request.json"), null);
  if (requestValue === null) throw new HitchError(`eval not found: ${options.evalId}`, { code: "eval_not_found", exitCode: 3 });
  const request = await loadPersistedRequest(requestValue);
  const plan = parseRerunPlan(await readJSON<unknown>(path.join(options.evalDirectory, "plan.json")), options.evalId, request);
  const initialProgress = await readEvalProgress(options.evalDirectory);
  if (initialProgress === null) throw unavailable("eval has no task-level progress");
  let progress: EvalProgressV1 = initialProgress;
  validateProgressPlan(progress, plan, request, options.evalId);
  const previousResult = await readJSON<Record<string, unknown> | null>(path.join(options.evalDirectory, "result.json"), null);
  if (previousResult?.status === "cancelled") throw new HitchError("cancelled eval cannot be rerun", { code: "eval_rerun_cancelled", exitCode: 2 });
  const selectedTasks = selectRerunTasks(plan.tasks, progress, options.selector);
  await atomicWriteJSON(path.join(rerunDirectory, "request.json"), {
    schema_version: SCHEMA_VERSION,
    rerun_id: rerunId,
    eval_id: options.evalId,
    mode: options.selector.mode,
    tasks: selectedTasks,
    base_generation: progress.generation,
    created_at: startedAt,
  });
  await writeRerunState(statePath, {
    rerunId,
    evalId: options.evalId,
    status: "running",
    tasks: selectedTasks,
    repairedTasks: [],
    startedAt,
  });

  const repaired = new Set<string>();
  let backendRun: HarborBackendResult | undefined;
  try {
    if (selectedTasks.length > 0) {
      const resolvedRevision = await loadResolvedRevision(options.evalDirectory, plan);
      const preparedArtifact = await loadRerunArtifact(options.root, plan);
      const runtimeId = requiredString(plan.controllerRuntime.runtime_id, "plan controller runtime id");
      const runtime = await useControllerRuntimeById(statePaths(options.root), runtimeId.replace(/^sha256:/, ""));
      if (runtime.runtime_id !== runtimeId
        || runtime.manifest_digest !== requiredString(plan.controllerRuntime.manifest_digest, "plan controller runtime digest")) {
        throw unavailable("controller runtime identity changed");
      }
      const localTransport = await loadLocalTransport(options.evalDirectory, plan, resolvedRevision, options.env, options.signal);
      const backendDirectory = path.join(rerunDirectory, "harbor");
      const harborJobDirectory = path.join(backendDirectory, "job");
      const rerunRefs: EvalTrialRefV1[] = [];
      const publish = async (ref: EvalTrialRefV1): Promise<void> => {
        if (!selectedTasks.includes(ref.task_id) || ref.attempt !== 1) {
          throw new HitchError(`Harbor rerun returned an unselected task: ${ref.task_id}`, { code: "eval_rerun_task_mismatch", exitCode: 12 });
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
        repaired.add(ref.task_id);
        await writeEvalProgress(options.evalDirectory, progress);
        await writeRerunState(statePath, {
          rerunId,
          evalId: options.evalId,
          status: "running",
          tasks: selectedTasks,
          repairedTasks: [...repaired].sort(),
          startedAt,
        });
      };
      backendRun = await runHarborBackend({
        evalId: options.evalId,
        evalDirectory: options.evalDirectory,
        backendDirectory,
        taskNames: selectedTasks,
        request,
        root: options.root,
        resolvedRevision,
        runtimeDirectory: runtime.directory,
        runtimeId: runtime.runtime_id,
        preparedArtifact,
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
      const terminalRefs = await importEvalTrialRuns({
        root: options.root,
        evalId: options.evalId,
        evalDirectory: options.evalDirectory,
        harborJobDirectory,
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

    const result = await finalizeRerun(options.evalDirectory, request, plan, progress, previousResult, backendRun);
    const remaining = invalidTasks(plan.tasks, progress);
    const completedAt = new Date().toISOString();
    const output: EvalRerunResult = {
      schema_version: "1",
      kind: "eval-rerun",
      rerun_id: rerunId,
      eval_id: options.evalId,
      status: "completed",
      selected_tasks: selectedTasks,
      repaired_tasks: [...repaired].sort(),
      remaining_invalid_tasks: remaining,
      eval_status: result.status as "succeeded" | "failed",
      started_at: startedAt,
      completed_at: completedAt,
    };
    await writeRerunState(statePath, {
      rerunId,
      evalId: options.evalId,
      status: "completed",
      tasks: selectedTasks,
      repairedTasks: output.repaired_tasks,
      startedAt,
      completedAt,
      evalStatus: output.eval_status,
      remainingInvalidTasks: remaining,
    });
    return output;
  } catch (error) {
    if (progress.generation > 0) {
      await finalizeRerun(options.evalDirectory, request, plan, progress, previousResult, backendRun).catch(() => {});
    }
    await writeRerunState(statePath, {
      rerunId,
      evalId: options.evalId,
      status: "failed",
      tasks: selectedTasks,
      repairedTasks: [...repaired].sort(),
      startedAt,
      completedAt: new Date().toISOString(),
      errorCode: error instanceof HitchError ? error.code : "eval_rerun_failed",
    }).catch(() => {});
    throw error;
  }
}

export function selectRerunTasks(tasks: readonly string[], progress: EvalProgressV1, selector: RerunSelector): string[] {
  const planned = new Set(tasks);
  if (planned.size !== tasks.length || tasks.some((task) => typeof task !== "string" || task.length === 0)) {
    throw unavailable("eval task plan is invalid");
  }
  const invalid = new Set(invalidTasks(tasks, progress));
  if (selector.mode === "invalid") return [...invalid].sort();
  const requested = [...new Set(selector.taskNames)].sort();
  if (requested.length === 0) throw invalidInput("eval rerun requires at least one --task");
  for (const task of requested) {
    if (!planned.has(task)) throw new HitchError(`eval task is not in the plan: ${task}`, { code: "eval_rerun_unknown_task", exitCode: 2 });
    if (!invalid.has(task)) throw new HitchError(`eval task is already valid: ${task}`, { code: "eval_task_already_valid", exitCode: 2 });
  }
  return requested;
}

function invalidTasks(tasks: readonly string[], progress: EvalProgressV1): string[] {
  const byKey = new Map<string, EvalTrialRefV1>();
  for (const trial of progress.trials) {
    const key = evalTrialKey(trial);
    if (byKey.has(key)) throw unavailable(`eval has duplicate logical task: ${trial.task_id}`);
    byKey.set(key, trial);
  }
  return [...tasks].filter((task) => byKey.get(`${task}\u00001`)?.observation_status !== "valid").sort();
}

function validateProgressPlan(progress: EvalProgressV1, plan: RerunPlan, request: EvalRequest, evalId: string): void {
  if (progress.eval_id !== evalId) throw unavailable("eval progress identity is invalid");
  if (progress.benchmark_id !== request.benchmark_id || progress.benchmark_revision !== request.benchmark_revision) {
    throw unavailable("eval progress benchmark identity changed");
  }
  if (progress.planned_tasks !== plan.tasks.length || progress.planned_trials !== plan.tasks.length) {
    throw unavailable("eval progress does not match the attempts=1 task plan");
  }
  const planned = new Set(plan.tasks);
  for (const trial of progress.trials) {
    if (trial.attempt !== 1 || !planned.has(trial.task_id)) throw unavailable(`eval progress contains an unplanned task: ${trial.task_id}`);
  }
  invalidTasks(plan.tasks, progress);
}

function parseRerunPlan(value: unknown, evalId: string, request: EvalRequest): RerunPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable("eval plan is missing");
  const plan = value as Record<string, unknown>;
  if (plan.eval_id !== evalId || plan.schema_version !== "1" || plan.attempts !== 1) {
    throw unavailable("eval rerun requires a schema v1 attempts=1 plan");
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
  backendRun?: HarborBackendResult,
): Promise<Record<string, unknown>> {
  const remaining = invalidTasks(plan.tasks, progress);
  const succeeded = remaining.length === 0;
  const completedAt = new Date().toISOString();
  const result: Record<string, unknown> = {
    ...(previousResult ?? {}),
    schema_version: SCHEMA_VERSION,
    eval_id: progress.eval_id,
    status: succeeded ? "succeeded" : "failed",
    exit_code: succeeded ? 0 : 13,
    ...(backendRun ? { backend: backendRun.backend, backend_summary: backendRun.summary } : {}),
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
        message: `eval has invalid or missing tasks: ${remaining.join(", ")}`,
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
  status: "running" | "completed" | "failed";
  tasks: readonly string[];
  repairedTasks: readonly string[];
  startedAt: string;
  completedAt?: string;
  evalStatus?: "succeeded" | "failed";
  remainingInvalidTasks?: readonly string[];
  errorCode?: string;
}): Promise<void> {
  await atomicWriteJSON(file, {
    schema_version: SCHEMA_VERSION,
    rerun_id: input.rerunId,
    eval_id: input.evalId,
    status: input.status,
    tasks: [...input.tasks],
    repaired_tasks: [...input.repairedTasks],
    ...(input.evalStatus ? { eval_status: input.evalStatus } : {}),
    ...(input.remainingInvalidTasks ? { remaining_invalid_tasks: [...input.remainingInvalidTasks] } : {}),
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
