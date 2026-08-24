import path from "node:path";
import { spawn } from "node:child_process";
import { getAdapter } from "../adapters/index.js";
import type { NormalizedEvent } from "../adapters/index.js";
import { EventSink } from "./events.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, consumeLines, ensureDir, readJSON, terminateProcess } from "../foundation/index.js";
import { parseHarnessReference } from "../revisions/index.js";
import { prepareHarness, resolveHarness } from "../artifacts/index.js";
import type { PreparedArtifact, ResolvedRevision } from "../artifacts/index.js";
import type { VerifiedLocalGitSource } from "../revisions/index.js";
import {
  abandonPlannedWorkspace,
  finalizeWorkspace,
  inspectWorkspace,
  markWorkspaceRunning,
  markWorkspaceFinalizationFailed,
  planWorkspace,
  prepareWorkspace,
  workspaceManifestFields,
  workspaceRecordPath,
  workspaceDigest,
} from "../workspaces/index.js";
import type { WorkspacePlan } from "../workspaces/index.js";
import { TrajectoryProjector, importDeepseekNativeSession } from "../trajectories/index.js";
import {
  TrajectoryWriter,
  canonicalTrajectoryFileRef,
  trajectoryRefPath,
  trajectoryRefV2,
} from "../trajectories/index.js";
import { ProviderCaptureWriter, redactProviderText } from "../trajectories/index.js";
import type { ModelIdentityV1, RunId } from "../domain/index.js";
import { looksImmutableModelId } from "./identity.js";
import { validateRunRequest } from "./request.js";
import type { RunRequestInput } from "./request.js";
import { buildManifest, safeAgentArgsForPersistence } from "./manifest.js";
import { assertQueuedRunIdentity } from "./queued.js";
import { adapterFidelity, failureResult, mergeRedactions, providerModelId } from "./outcome.js";
export interface ExecuteRunOptions {
  runId: RunId;
  request: RunRequestInput;
  runsRoot: string;
  root?: string;
  resolvedRevision?: ResolvedRevision;
  verifiedLocalGitSource?: VerifiedLocalGitSource;
  workspacePlan?: WorkspacePlan;
  onEvent?: (event: Record<string, unknown>) => void;
  onProcess?: (control: { child?: import("node:child_process").ChildProcess } | null) => void;
  signal?: AbortSignal;
}
export async function executeRun({
  runId,
  request,
  runsRoot,
  root = path.dirname(runsRoot),
  resolvedRevision,
  verifiedLocalGitSource,
  workspacePlan,
  onEvent,
  onProcess,
  signal,
}: ExecuteRunOptions): Promise<Record<string, unknown>> {
  const normalized = await validateRunRequest(request);
  workspacePlan ||= await planWorkspace({ runId, sourceCwd: normalized.cwd, mode: normalized.workspace_mode, root });
  const runDirectory = path.join(runsRoot, runId);
  const runtimeHome = path.join(runDirectory, "runtime-home");
  const priorManifest = await readJSON<Record<string, unknown> | null>(path.join(runDirectory, "manifest.json"), null);
  if (priorManifest && ["succeeded", "failed", "timed_out", "cancelled"].includes(String(priorManifest.status))) {
    throw new HitchError(`run ${runId} is sealed and cannot be overwritten`, { code: "run_sealed", exitCode: 11 });
  }
  if (priorManifest) assertQueuedRunIdentity(priorManifest, buildManifest(runId, normalized, workspacePlan));
  await ensureDir(runDirectory);
  const workspacePath = workspaceRecordPath(root, runId);
  await atomicWriteJSON(workspacePath, workspacePlan);
  const manifestPath = path.join(runDirectory, "manifest.json");
  const resultPath = path.join(runDirectory, "result.json");
  const existingManifest = priorManifest || buildManifest(runId, normalized, workspacePlan);
  let manifest: Record<string, unknown> = existingManifest;
  const startedAt = new Date();
  await atomicWriteJSON(path.join(runDirectory, "request.json"), {
    schema_version: SCHEMA_VERSION,
    ...normalized,
    prompt: redactProviderText(normalized.prompt),
    agent_args: safeAgentArgsForPersistence(normalized.agent_args),
  });
  await atomicWriteJSON(manifestPath, existingManifest);
  let sink: EventSink | undefined;
  let sinkOpened = false;
  let child: import("node:child_process").ChildProcess | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  let cancelled = false;
  let finalMessage: string | undefined;
  let observedEffectiveModel: string | undefined;
  let abortHandler: (() => void) | undefined;
  let result: Record<string, unknown> | undefined;
  let stage = "event_setup";
  let resolution: ResolvedRevision | undefined = resolvedRevision;
  let artifact: PreparedArtifact | undefined;
  let workspaceLease: WorkspacePlan | null | undefined;
  const projector = new TrajectoryProjector({
    runId,
    cwd: normalized.cwd,
    prompt: redactProviderText(normalized.prompt),
    model: normalized.model,
    fidelity: adapterFidelity(normalized.harness_ref),
  });
  let trajectoryWriter: TrajectoryWriter | undefined;
  let trajectoryPathValue: string | undefined;
  let providerCapture: ProviderCaptureWriter | undefined;
  const reference = parseHarnessReference(normalized.harness_ref);
  const adapter = getAdapter(reference.harness_id);
  try {
    sink = new EventSink(runDirectory, runId, onEvent);
    await sink.open();
    sinkOpened = true;
    providerCapture = await ProviderCaptureWriter.open({ runDirectory, structured: Boolean(adapter.translate) });
    stage = "resolution";
    resolution ||= await resolveHarness(reference, { root });
    await atomicWriteJSON(path.join(runDirectory, "resolution.json"), resolution);
    manifest = {
      ...existingManifest,
      status: "preparing",
      resolved_revision: resolution,
      revision_identity: resolution.identity,
      harness: {
        ...(existingManifest.harness as Record<string, unknown>),
        revision_identity: resolution.identity,
      },
    };
    await atomicWriteJSON(manifestPath, manifest);
    stage = "preparation";
    artifact = await prepareHarness(resolution, { root, ...(signal ? { signal } : {}), ...(verifiedLocalGitSource ? { verifiedLocalGitSource } : {}) });
    stage = "workspace_preparation";
    workspaceLease = await prepareWorkspace(workspacePlan, { recordPath: workspacePath, ...(signal ? { signal } : {}) });
    manifest = {
      ...manifest,
      status: "running",
      artifact_id: artifact.artifact_id,
      artifact_source_type: artifact.source_type,
      executable: artifact.executable,
      artifact_entrypoint: artifact.entrypoint_args?.[0] || artifact.executable,
      agent_version: artifact.observed_version || resolution.revision.version || null,
      agent_identity: resolution.identity,
      harness: {
        ...(manifest.harness as Record<string, unknown>),
        revision_identity: resolution.identity,
        artifact_id: artifact.artifact_id,
      },
      ...workspaceManifestFields(workspaceLease),
      started_at: startedAt.toISOString(),
    };
    const initialWorkspaceDigest = workspaceLease.baseline_digest
      || await workspaceDigest(workspaceLease.execution_workspace, { ...(signal ? { signal } : {}) });
    manifest.protocol = {
      ...(manifest.protocol as Record<string, unknown>),
      initial_workspace_digest: initialWorkspaceDigest,
    };
    manifest.initial_workspace_digest = initialWorkspaceDigest;
    await atomicWriteJSON(manifestPath, manifest);
    sink.emit({
      type: "workspace.ready",
      mode: workspaceLease.mode,
      workspace: workspaceLease.execution_workspace,
      retained: workspaceLease.retained,
    });
    sink.emit({
      type: "run.started",
      harness: reference.harness_id,
      agent: reference.harness_id,
      model: normalized.model || null,
      revision_identity: resolution.identity,
      artifact_id: artifact.artifact_id,
      workspace_mode: workspaceLease.mode,
      workspace: workspaceLease.execution_workspace,
    });
    stage = "adapter_setup";
    const adapterState: Record<string, unknown> = {};
    const executionRequest = { ...normalized, cwd: workspaceLease.execution_workspace };
    const specification = await adapter.process(executionRequest, artifact.executable, {
      observed_version: artifact.observed_version ?? undefined,
      resolution,
      run_directory: runDirectory,
      runtime_home: runtimeHome,
    });
    if (artifact.entrypoint_args?.length) specification.args.unshift(...artifact.entrypoint_args);
    if (signal?.aborted) {
      result = failureResult(runId, startedAt, "cancelled", "agent run cancelled before launch", 9);
      sink.emit({ type: "run.failed", status: "cancelled", error: (result.error as { code: string; message: string }) });
    } else {
      stage = "launch";
      workspaceLease = await markWorkspaceRunning(workspaceLease, { recordPath: workspacePath });
      const childEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        ...specification.env,
        PWD: workspaceLease.execution_workspace,
      };
      delete childEnvironment.OLDPWD;
      child = spawn(specification.executable, specification.args, {
        cwd: workspaceLease.execution_workspace,
        env: childEnvironment,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      const launched = child;
      launched.stdin?.on("error", () => { /* Process-level error/exit determines the typed result. */ });
      onProcess?.({ child: launched });
      abortHandler = () => {
        cancelled = true;
        terminateProcess(launched).catch(() => {});
      };
      signal?.addEventListener("abort", abortHandler, { once: true });
      consumeLines(launched.stdout as import("node:stream").Readable, (line) => {
        if (adapter.translateLine) {
          const safeLine = providerCapture?.appendText(line) ?? redactProviderText(line);
          sink?.writeStdout(safeLine);
          for (const event of adapter.translateLine(safeLine, adapterState)) {
            if (event.type === "message.delta" && event.text) {
              finalMessage = (finalMessage ?? "") + event.text;
            }
            if (event.type === "message.completed" && typeof event.text === "string") finalMessage = event.text;
            projector.feed(event);
            sink?.emit(event);
          }
          return;
        }
        let native: unknown;
        try {
          native = JSON.parse(line);
        } catch {
          const safeLine = providerCapture?.appendUnparsed(line) ?? redactProviderText(line);
          sink?.writeStdout(safeLine);
          sink?.emit({ type: "process.stdout", text: safeLine });
          projector.feedText(`${safeLine}\n`);
          return;
        }
        const safeNative = providerCapture?.appendJSON(native) ?? native;
        sink?.writeStdout(JSON.stringify(safeNative));
        const record = typeof safeNative === "object" && safeNative !== null && !Array.isArray(safeNative)
          ? safeNative as Record<string, unknown>
          : { raw: safeNative };
        observedEffectiveModel ||= providerModelId(record);
        if (adapter.translate) {
          for (const event of adapter.translate(record, adapterState)) {
            if (event.type === "message.delta" && event.text) {
              finalMessage = (finalMessage ?? "") + event.text;
            }
            if (event.type === "message.completed" && typeof event.text === "string") finalMessage = event.text;
            projector.feed(event);
            sink?.emit(event);
          }
        } else {
          projector.feedText(line);
        }
      });
      consumeLines(launched.stderr as import("node:stream").Readable, (line) => {
        const safeLine = redactProviderText(line);
        sink?.writeStderr(safeLine);
        sink?.emit({ type: "process.stderr", text: safeLine });
      });
      await new Promise<void>((resolve, reject) => {
        launched.once("spawn", resolve);
        launched.once("error", reject);
      });
      stage = "running";
      const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        launched.once("error", reject);
        launched.once("close", (code, processSignal) => resolve({ code, signal: processSignal }));
      });
      if (normalized.timeout_ms > 0) {
        timeout = setTimeout(async () => {
          timedOut = true;
          await terminateProcess(launched).catch(() => {});
        }, normalized.timeout_ms);
        timeout.unref?.();
      }
      launched.stdin?.end(specification.input);
      const exit = await close;
      if (timeout) clearTimeout(timeout);
      if (timedOut) {
        result = failureResult(runId, startedAt, "timed_out", "agent run timed out", 8, exit);
        sink.emit({ type: "run.failed", status: "timed_out", error: (result.error as { code: string; message: string }) });
      } else if (cancelled) {
        result = failureResult(runId, startedAt, "cancelled", "agent run cancelled", 9, exit);
        sink.emit({ type: "run.failed", status: "cancelled", error: (result.error as { code: string; message: string }) });
      } else if (exit.code !== 0) {
        const message = `agent exited with code ${exit.code ?? "null"}${exit.signal ? ` (${exit.signal})` : ""}`;
        result = failureResult(runId, startedAt, "agent_failed", message, 7, exit);
        sink.emit({ type: "run.failed", status: "failed", error: (result.error as { code: string; message: string }) });
      } else {
        result = {
          schema_version: SCHEMA_VERSION,
          run_id: runId,
          status: "succeeded",
          exit_code: 0,
          process_exit_code: exit.code,
          output: finalMessage ?? "",
          harness_id: reference.harness_id,
          revision_identity: resolution.identity,
          artifact_id: artifact.artifact_id,
          started_at: startedAt.toISOString(),
          completed_at: new Date().toISOString(),
        };
        sink.emit({ type: "run.completed", status: "succeeded", exit_code: 0 });
      }
    }
  } catch (error) {
    if (timeout) clearTimeout(timeout);
    if (child) await terminateProcess(child).catch(() => {});
    const launchStage = stage === "adapter_setup" || stage === "launch";
    const code = error instanceof HitchError ? error.code : launchStage ? "launch_failed" : "internal_error";
    const exitCode = error instanceof HitchError ? error.exitCode : launchStage ? 6 : 12;
    result = failureResult(runId, startedAt, code, (error as Error)?.message || String(error), exitCode);
    if (sinkOpened) {
      try { sink?.emit({ type: "run.failed", status: (result as { status: string }).status, error: (result as { error: { code: string; message: string } }).error }); } catch { /* Finalization below remains authoritative. */ }
    }
  } finally {
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    onProcess?.(null);
  }
  if (workspaceLease) {
    try {
      stage = "workspace_finalization";
      const finalized = await finalizeWorkspace(workspaceLease, { recordPath: workspacePath });
      if (finalized) workspaceLease = finalized;
      manifest = { ...manifest, ...workspaceManifestFields(workspaceLease) };
      (result as Record<string, unknown>).workspace = {
        mode: workspaceLease.mode,
        source: workspaceLease.source_workspace,
        execution: workspaceLease.execution_workspace,
        retained: workspaceLease.retained,
        changed: workspaceLease.changed ?? null,
      };
    } catch (error) {
      const warning = { code: "workspace_finalization_failed", message: (error as Error)?.message || String(error) };
      try {
        const marked = await markWorkspaceFinalizationFailed(workspaceLease, {
          recordPath: workspacePath,
          warning,
        });
        if (marked) workspaceLease = marked;
      } catch {
        workspaceLease = { ...workspaceLease, retained: workspaceLease.mode !== "shared", changed: null };
      }
      manifest = { ...manifest, ...workspaceManifestFields(workspaceLease), workspace_warning: warning };
      (result as Record<string, unknown>).workspace = {
        mode: workspaceLease.mode,
        source: workspaceLease.source_workspace,
        execution: workspaceLease.execution_workspace,
        retained: workspaceLease.retained,
        changed: workspaceLease.changed ?? null,
      };
      (result as Record<string, unknown>).workspace_warning = warning;
    }
  } else {
    const workspaceStatus = await inspectWorkspace({ root, runId }).catch(() => null);
    const currentWorkspace = workspaceStatus?.status === "planned"
      ? await abandonPlannedWorkspace({ root, runId, status: (result as { status: string }).status === "cancelled" ? "cancelled" : "unused" })
      : workspaceStatus;
    manifest = { ...manifest, ...workspaceManifestFields(currentWorkspace) };
  }
  // Seal the provider-native evidence together with its canonical projection.
  try {
    const status = (result as { status: string }).status;
    const captured = providerCapture ? await providerCapture.close() : null;
    providerCapture = undefined;
    const deepseekNative = reference.harness_id === "deepseek"
      ? await importDeepseekNativeSession({
          runtimeHome,
          runDirectory,
          runId,
          status: status === "cancelled" ? "cancelled" : status === "timed_out" ? "timed_out" : status === "succeeded" ? "succeeded" : "failed",
        })
      : null;
    const projected = deepseekNative
      ? {
          header: deepseekNative.header,
          events: deepseekNative.events,
          finalOutput: deepseekNative.finalOutput,
          providerSessionId: deepseekNative.providerSessionId,
          fidelity: "provider_native" as const,
        }
      : projector.finalize(status === "cancelled" ? "cancelled" : status === "timed_out" ? "timed_out" : status === "succeeded" ? "succeeded" : "failed");
    observedEffectiveModel ||= deepseekNative?.effectiveModel;
    trajectoryWriter = await TrajectoryWriter.open({
      runDirectory,
      cwd: normalized.cwd,
      sessionId: projected.header.id,
      fidelity: projected.fidelity,
      header: projected.header,
    });
    for (const event of projected.events) trajectoryWriter.append(event);
    trajectoryPathValue = await trajectoryWriter.close();
    const canonicalFile = await canonicalTrajectoryFileRef(runDirectory, trajectoryPathValue);
    const fidelity = deepseekNative
      ? "provider_native" as const
      : captured && adapter.translate
      ? "provider_native" as const
      : projected.fidelity === "native" || projected.fidelity === "provider_native"
        ? "normalized" as const
        : projected.fidelity;
    const redactions = mergeRedactions(captured?.redactions, deepseekNative?.redactions);
    const ref = trajectoryRefV2({
      runId,
      fidelity,
      provider: reference.harness_id,
      ...(projected.providerSessionId ? { providerSessionId: projected.providerSessionId } : {}),
      files: [
        ...(captured ? [captured.file] : []),
        ...(deepseekNative ? deepseekNative.providerFiles : []),
        canonicalFile,
      ],
      ...(redactions.length ? { redactions } : {}),
    });
    await atomicWriteJSON(trajectoryRefPath(runDirectory), ref);
    (result as Record<string, unknown>).trajectory = {
      session_id: projected.header.id,
      path: canonicalFile.path,
      fidelity,
      sha256: canonicalFile.sha256,
    };
    if (status === "succeeded") {
      // §5.6: `result.output` is the text of the last non-empty assistant
      // message in the canonical trajectory.
      (result as Record<string, unknown>).output = projected.finalOutput || finalMessage || "";
    }
    manifest = { ...manifest, trajectory_ref: "trajectory.ref.json" };
    sink?.emit({ type: "trajectory.recorded", path: canonicalFile.path, fidelity });
  } catch (error) {
    if (providerCapture) await providerCapture.close().catch(() => {});
    providerCapture = undefined;
    const warning = {
      code: "trajectory_recording_failed",
      message: (error as Error)?.message || String(error),
    };
    if ((result as { status?: string } | undefined)?.status === "timed_out") {
      // The agent timeout is the authoritative terminal cause. Recording is a
      // secondary failure and must not turn an attributable timeout into an
      // infrastructure failure for downstream evaluators.
      (result as Record<string, unknown>).trajectory_warning = warning;
      manifest = { ...manifest, trajectory_warning: warning };
      sink?.emit({ type: "trajectory.recording_failed", status: "timed_out", error: warning });
    } else {
      result = failureResult(runId, startedAt, warning.code, warning.message, 12);
    }
  }
  if (sinkOpened) {
    try {
      await sink?.close();
    } catch (error) {
      result = failureResult(runId, startedAt, "event_recording_failed", (error as Error).message, 12);
    }
  }
  if (!result) result = failureResult(runId, startedAt, "internal_error", "run ended without a result", 12);
  if (!await readJSON<unknown | null>(path.join(runDirectory, "resolution.json"), null)) {
    await atomicWriteJSON(path.join(runDirectory, "resolution.json"), {
      schema_version: SCHEMA_VERSION,
      status: "unresolved",
      requested_harness_ref: normalized.harness_ref,
      error_code: ((result as { error?: { code?: string } }).error?.code) || "resolution_unavailable",
    });
  }
  if (observedEffectiveModel) {
    const currentModel = (manifest.model || normalized.model_identity) as ModelIdentityV1;
    manifest.model = {
      ...currentModel,
      effective_id: observedEffectiveModel,
      identity_resolved: currentModel.identity_resolved === true || looksImmutableModelId(observedEffectiveModel),
    };
    (result as Record<string, unknown>).effective_model = observedEffectiveModel;
  }
  await atomicWriteJSON(resultPath, result);
  const terminalStatus = (result as { status: string }).status;
  const observation = normalized.context.kind === "benchmark_task" && !normalized.defer_benchmark_observation
    ? {
        status: "invalid",
        invalid_reason: terminalStatus === "succeeded"
          ? "verifier_result_missing"
          : terminalStatus === "cancelled"
            ? "cancelled"
            : "infrastructure_failure",
      }
    : undefined;
  await atomicWriteJSON(manifestPath, {
    ...manifest,
    status: terminalStatus,
    result_ref: "result.json",
    ...(observation ? { observation } : {}),
    completed_at: (result as { completed_at?: string }).completed_at,
    sealed: !normalized.defer_benchmark_observation,
  });
  return result;
}
export type { NormalizedEvent };
