import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { getAdapter, normalizeRequest } from "./adapters.js";
import type { AdapterRequest, NormalizedEvent } from "./adapters.js";
import { EventSink } from "./events.js";
import { HitchError, invalidInput } from "./errors.js";
import { atomicWriteJSON, ensureDir, readJSON } from "./fs.js";
import { consumeLines } from "./line-stream.js";
import { terminateProcess } from "./process.js";
import { SCHEMA_VERSION } from "./config.js";
import { parseHarnessReference } from "./harness-reference.js";
import { prepareHarness, resolveHarness } from "./artifacts.js";
import type { ResolvedRevision, PreparedArtifact } from "./artifacts.js";
import type { VerifiedLocalGitSource } from "./local-git-transport.js";
import {
  abandonPlannedWorkspace,
  finalizeWorkspace,
  inspectWorkspace,
  markWorkspaceRunning,
  markWorkspaceFinalizationFailed,
  planWorkspace,
  prepareWorkspace,
  WORKSPACE_MODES,
  workspaceManifestFields,
  workspaceRecordPath,
  workspaceDigest,
} from "./workspaces.js";
import type { WorkspacePlan } from "./workspaces.js";
import { TrajectoryProjector } from "./trajectories/projector.js";
import {
  TrajectoryWriter,
  canonicalTrajectoryFileRef,
  trajectoryRefPath,
  trajectoryRefV2,
} from "./trajectories/store.js";
import { ProviderCaptureWriter, redactProviderText } from "./trajectories/native.js";
import { importDeepseekNativeSession } from "./trajectories/deepseek-native.js";
import type { EvalRunParentV1, ModelIdentityV1, ProtocolIdentityV1, RunContextV1, RunId, Sha256 } from "./domain/types.js";
import type { TrajectoryFidelity } from "./domain/types.js";
import { asBoolean, asOptionalString, asRecord, asSha256, asString, validateEvalRunParent, validateRunContext } from "./domain/validate.js";
import { canonicalJSON, defaultModelIdentity, looksImmutableModelId, sha256JSON } from "./run-records.js";

export interface RunRequestInput {
  schema_version?: unknown;
  harness_ref?: unknown;
  agent?: unknown;
  model?: unknown;
  cwd?: unknown;
  workspace_mode?: unknown;
  prompt?: unknown;
  timeout_ms?: unknown;
  agent_args?: unknown;
  context?: unknown;
  parent?: unknown;
  model_identity?: unknown;
  protocol_identity?: unknown;
  /** Internal eval handoff: the host verifier will seal the observation. */
  defer_benchmark_observation?: unknown;
}

export interface ValidatedRunRequest extends AdapterRequest {
  context: RunContextV1;
  parent?: EvalRunParentV1;
  model_identity: ModelIdentityV1;
  protocol_identity: Pick<ProtocolIdentityV1, "environment_identity" | "tool_policy_sha256">;
  defer_benchmark_observation: boolean;
}

export async function validateRunRequest(input: RunRequestInput): Promise<ValidatedRunRequest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidInput("run request must be a JSON object");
  }
  const allowedFields = new Set([
    "schema_version", "harness_ref", "agent", "model", "cwd", "workspace_mode", "prompt", "timeout_ms", "agent_args",
    "context", "parent", "model_identity", "protocol_identity", "defer_benchmark_observation",
  ]);
  const unexpectedField = Object.keys(input).find((field) => !allowedFields.has(field));
  if (unexpectedField) throw invalidInput(`unknown run request field: ${unexpectedField}`);
  if (input.schema_version !== undefined && input.schema_version !== SCHEMA_VERSION) {
    throw invalidInput(`unsupported schema_version: ${input.schema_version}`);
  }
  if (input.harness_ref !== undefined && input.agent !== undefined) {
    throw invalidInput("use only one of harness_ref and the legacy agent field");
  }
  if (typeof input.agent === "string" && input.agent.includes("@")) {
    throw invalidInput("the legacy agent field accepts only a harness name; use harness_ref for revision selection");
  }
  const referenceValue = input.harness_ref ?? input.agent;
  if (typeof referenceValue !== "string" || !referenceValue.trim()) {
    throw invalidInput("harness_ref must be a non-empty string");
  }
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw invalidInput("prompt must be a non-empty string");
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || !input.cwd.trim())) {
    throw invalidInput("cwd must be a non-empty string");
  }
  if (input.workspace_mode !== undefined && !WORKSPACE_MODES.has(input.workspace_mode as string)) {
    throw invalidInput(`workspace_mode must be one of: ${[...WORKSPACE_MODES].join(", ")}`);
  }
  if (input.model !== undefined && typeof input.model !== "string") throw invalidInput("model must be a string");
  if (input.timeout_ms !== undefined && (typeof input.timeout_ms !== "number" || !Number.isFinite(input.timeout_ms) || input.timeout_ms < 0)) {
    throw invalidInput("timeout_ms must be a non-negative number");
  }
  if (input.agent_args !== undefined && (!Array.isArray(input.agent_args) || input.agent_args.some((arg) => typeof arg !== "string"))) {
    throw invalidInput("agent_args must be an array of strings");
  }
  const request = normalizeRequest(input as Record<string, unknown>);
  const reference = parseHarnessReference(request.harness_ref);
  getAdapter(reference.harness_id);
  let workspace: Awaited<ReturnType<typeof stat>>;
  try {
    workspace = await stat(request.cwd);
  } catch (error) {
    throw invalidInput(`workspace does not exist: ${request.cwd}`, { cause: error });
  }
  if (!workspace.isDirectory()) throw invalidInput(`workspace is not a directory: ${request.cwd}`);
  let parent: EvalRunParentV1 | undefined;
  try {
    if (input.parent !== undefined) parent = validateEvalRunParent(input.parent);
  } catch (error) {
    throw invalidInput((error as Error).message, { cause: error });
  }
  let context: RunContextV1;
  try {
    context = validateRunContext(input.context ?? { kind: "ad_hoc" });
  } catch (error) {
    throw invalidInput((error as Error).message, { cause: error });
  }
  if (parent && context.kind !== "benchmark_task") throw invalidInput("eval parent requires a benchmark_task context");
  let deferObservation = false;
  try {
    if (input.defer_benchmark_observation !== undefined) {
      deferObservation = asBoolean(input.defer_benchmark_observation, "defer_benchmark_observation");
    }
  } catch (error) {
    throw invalidInput((error as Error).message, { cause: error });
  }
  if (deferObservation && (!parent || context.kind !== "benchmark_task")) {
    throw invalidInput("defer_benchmark_observation is only valid for eval benchmark runs");
  }
  let modelIdentity: ModelIdentityV1;
  let protocolIdentity: Pick<ProtocolIdentityV1, "environment_identity" | "tool_policy_sha256"> = {};
  try {
    modelIdentity = validateModelIdentity(input.model_identity, request.model, reference.harness_id, request.agent_args);
    protocolIdentity = validateProtocolIdentityInput(input.protocol_identity);
  } catch (error) {
    throw invalidInput((error as Error).message, { cause: error });
  }
  return {
    ...request,
    context,
    ...(parent ? { parent } : {}),
    model_identity: modelIdentity,
    protocol_identity: protocolIdentity,
    defer_benchmark_observation: deferObservation,
  };
}

function validateModelIdentity(value: unknown, requestedId: string, harnessId: string, agentArgs: string[]): ModelIdentityV1 {
  const derivedParameters = modelParameterDigest(agentArgs);
  if (value === undefined) return defaultModelIdentity(requestedId, harnessId, {
    ...(derivedParameters ? { parametersSha256: derivedParameters } : {}),
  });
  const record = asRecord(value, "model_identity");
  const allowed = new Set(["provider", "requested_id", "effective_id", "parameters_sha256", "identity_resolved"]);
  const unexpected = Object.keys(record).find((field) => !allowed.has(field));
  if (unexpected) throw new TypeError(`model_identity has unknown field: ${unexpected}`);
  const declaredRequested = asString(record.requested_id ?? requestedId, "model_identity.requested_id");
  if (declaredRequested !== requestedId) throw new TypeError("model_identity.requested_id must match model");
  const effective = asString(record.effective_id ?? requestedId, "model_identity.effective_id");
  const resolved = record.identity_resolved === undefined ? undefined : asBoolean(record.identity_resolved, "model_identity.identity_resolved");
  const provider = asOptionalString(record.provider, "model_identity.provider");
  const parameters = record.parameters_sha256 === undefined
    ? derivedParameters
    : asSha256(record.parameters_sha256, "model_identity.parameters_sha256");
  return defaultModelIdentity(requestedId, harnessId, {
    ...(provider ? { provider } : {}),
    effectiveId: effective,
    ...(parameters ? { parametersSha256: parameters } : {}),
    ...(resolved !== undefined ? { resolved } : {}),
  });
}

function modelParameterDigest(agentArgs: string[]): Sha256 | undefined {
  const safeFlags = new Set([
    "--temperature", "--top-p", "--max-tokens", "--max-output-tokens", "--reasoning-effort",
  ]);
  const parameters: Record<string, string> = {};
  for (let index = 0; index < agentArgs.length; index += 1) {
    const argument = agentArgs[index] as string;
    const [flag, inline] = argument.split("=", 2);
    if (!flag || !safeFlags.has(flag)) continue;
    const value = inline ?? agentArgs[index + 1];
    if (value === undefined || (!inline && value.startsWith("--"))) continue;
    parameters[flag] = value;
    if (inline === undefined) index += 1;
  }
  return Object.keys(parameters).length ? sha256JSON(parameters) : undefined;
}

function validateProtocolIdentityInput(value: unknown): Pick<ProtocolIdentityV1, "environment_identity" | "tool_policy_sha256"> {
  if (value === undefined) return {};
  const record = asRecord(value, "protocol_identity");
  const allowed = new Set(["environment_identity", "tool_policy_sha256"]);
  const unexpected = Object.keys(record).find((field) => !allowed.has(field));
  if (unexpected) throw new TypeError(`protocol_identity has unknown field: ${unexpected}`);
  const result: Pick<ProtocolIdentityV1, "environment_identity" | "tool_policy_sha256"> = {};
  if (record.environment_identity !== undefined) result.environment_identity = asSha256(record.environment_identity, "environment_identity");
  if (record.tool_policy_sha256 !== undefined) result.tool_policy_sha256 = asSha256(record.tool_policy_sha256, "tool_policy_sha256");
  return result;
}

export function newRunId(): RunId {
  return `run_${randomUUID().replaceAll("-", "")}` as RunId;
}

export function sealTerminalManifest(
  manifest: Record<string, unknown>,
  status: "succeeded" | "failed" | "cancelled" | "timed_out",
  completedAt: string,
): Record<string, unknown> {
  const context = (() => {
    try { return validateRunContext(manifest.context ?? { kind: "ad_hoc" }); } catch { return { kind: "ad_hoc" } as RunContextV1; }
  })();
  return {
    ...manifest,
    status,
    result_ref: "result.json",
    ...(context.kind === "benchmark_task" && manifest.observation === undefined
      ? { observation: { status: "invalid", invalid_reason: status === "cancelled" ? "cancelled" : "infrastructure_failure" } }
      : {}),
    completed_at: completedAt,
    sealed: true,
  };
}

export interface RunManifest extends Record<string, unknown> {
  schema_version: string;
  run_id: RunId;
  status: string;
  harness_id: string;
  requested_harness_ref: string;
  canonical_harness_ref: string;
  agent: string;
  requested_model: string | null;
  effective_model: string | null;
  workspace: string;
  workspace_mode: string;
  timeout_ms: number;
  agent_args_count: number;
  agent_args_sha256: string | null;
  created_at: string;
  context: RunContextV1;
  harness: Record<string, unknown>;
  model: ModelIdentityV1;
  protocol: ProtocolIdentityV1;
  request_ref: string;
  resolution_ref: string;
}

export function buildManifest(runId: RunId, request: ValidatedRunRequest, workspacePlan: WorkspacePlan | null): RunManifest {
  const reference = parseHarnessReference(request.harness_ref);
  const safeAgentArgs = safeAgentArgsForPersistence(request.agent_args);
  const argsDigest = safeAgentArgs.length > 0 ? sha256JSON(safeAgentArgs) : undefined;
  const environmentIdentity = request.protocol_identity.environment_identity
    ?? sha256JSON({ platform: process.platform, arch: process.arch, node: process.versions.node });
  return {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    status: "queued",
    harness_id: reference.harness_id,
    requested_harness_ref: reference.raw,
    canonical_harness_ref: reference.canonical,
    agent: reference.harness_id,
    requested_model: request.model || null,
    effective_model: request.model || null,
    workspace: request.cwd,
    workspace_mode: request.workspace_mode,
    ...workspaceManifestFields(workspacePlan),
    timeout_ms: request.timeout_ms,
    agent_args_count: request.agent_args.length,
    agent_args_sha256: argsDigest ?? null,
    context: request.context,
    ...(request.parent ? { parent: request.parent } : {}),
    harness: {
      harness_id: reference.harness_id,
      requested_ref: reference.raw,
      revision_identity: null,
      ...(argsDigest ? { agent_args_sha256: argsDigest } : {}),
    },
    model: request.model_identity,
    protocol: {
      timeout_ms: request.timeout_ms,
      workspace_mode: request.workspace_mode,
      environment_identity: environmentIdentity,
      ...(request.protocol_identity.tool_policy_sha256 ? { tool_policy_sha256: request.protocol_identity.tool_policy_sha256 } : {}),
    },
    request_ref: "request.json",
    resolution_ref: "resolution.json",
    created_at: new Date().toISOString(),
  };
}

export function safeAgentArgsForPersistence(agentArgs: string[]): string[] {
  const sensitiveFlag = /(?:api[-_]?key|authorization|token|secret|password|credential|cookie)/i;
  const result: string[] = [];
  for (let index = 0; index < agentArgs.length; index += 1) {
    const argument = agentArgs[index] as string;
    const separator = argument.indexOf("=");
    const flag = separator >= 0 ? argument.slice(0, separator) : argument;
    if (sensitiveFlag.test(flag)) {
      result.push(separator >= 0 ? `${flag}=[REDACTED]` : flag);
      if (separator < 0 && agentArgs[index + 1] !== undefined && !String(agentArgs[index + 1]).startsWith("--")) {
        result.push("[REDACTED]");
        index += 1;
      }
      continue;
    }
    result.push(redactProviderText(argument));
  }
  return result;
}

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
      ? await importDeepseekNativeSession({ runtimeHome, runDirectory, runId })
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
    result = failureResult(runId, startedAt, "trajectory_recording_failed", (error as Error)?.message || String(error), 12);
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

function assertQueuedRunIdentity(existing: Record<string, unknown>, requested: RunManifest): void {
  const fields = ["context", "parent", "harness", "model", "protocol"] as const;
  for (const field of fields) {
    const left = existing[field];
    const right = requested[field];
    if (field === "harness") {
      const leftHarness = { ...(left as Record<string, unknown>), revision_identity: null, artifact_id: undefined };
      const rightHarness = { ...(right as Record<string, unknown>), revision_identity: null, artifact_id: undefined };
      if (canonicalJSON(leftHarness) === canonicalJSON(rightHarness)) continue;
    } else if (canonicalJSON(left) === canonicalJSON(right)) {
      continue;
    }
    throw new HitchError(`queued run identity does not match the execution request (${field})`, {
      code: "run_identity_mismatch",
      exitCode: 11,
    });
  }
}

export interface QueuedRun {
  runId: RunId;
  request: ValidatedRunRequest;
  resolvedRevision: ResolvedRevision;
  workspacePlan: WorkspacePlan;
  directory: string;
}

export async function createQueuedRun({
  runId = newRunId(),
  request,
  runsRoot,
  root = path.dirname(runsRoot),
}: { runId?: RunId; request: RunRequestInput; runsRoot: string; root?: string }): Promise<QueuedRun> {
  const normalized = await validateRunRequest(request);
  const resolvedRevision = await resolveHarness(normalized.harness_ref, { root });
  const workspacePlan = await planWorkspace({ runId, sourceCwd: normalized.cwd, mode: normalized.workspace_mode, root });
  const directory = await ensureDir(path.join(runsRoot, runId));
  await atomicWriteJSON(workspaceRecordPath(root, runId), workspacePlan);
  const manifest = buildManifest(runId, normalized, workspacePlan);
  await atomicWriteJSON(path.join(directory, "manifest.json"), {
    ...manifest,
    resolved_revision: resolvedRevision,
    revision_identity: resolvedRevision.identity,
    harness: {
      ...(manifest.harness as Record<string, unknown>),
      revision_identity: resolvedRevision.identity,
    },
  });
  await atomicWriteJSON(path.join(directory, "request.json"), {
    ...normalized,
    prompt: redactProviderText(normalized.prompt),
    agent_args: safeAgentArgsForPersistence(normalized.agent_args),
    schema_version: SCHEMA_VERSION,
  });
  await atomicWriteJSON(path.join(directory, "resolution.json"), resolvedRevision);
  return { runId, request: normalized, resolvedRevision, workspacePlan, directory };
}

function failureResult(
  runId: RunId,
  startedAt: Date,
  code: string,
  message: string,
  exitCode: number,
  processExit: { code?: number | null; signal?: NodeJS.Signals | null } = {},
): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    status: code === "cancelled" ? "cancelled" : code === "timed_out" ? "timed_out" : "failed",
    exit_code: exitCode,
    process_exit_code: processExit.code ?? null,
    signal: processExit.signal ?? null,
    error: { code, message },
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
  };
}

function adapterFidelity(harnessRef: string): TrajectoryFidelity {
  const reference = parseHarnessReference(harnessRef);
  // DeepSeek normally replaces this fallback with the native session imported
  // after exit. Older builds that do not persist sessions still get an honest
  // minimal stdout projection instead of fabricated structured events.
  return reference.harness_id === "deepseek" ? "minimal" : "normalized";
}

function providerModelId(event: Record<string, unknown>): string | undefined {
  const direct = [event.model, event.model_id, event.modelId, event.model_snapshot, event.snapshot];
  for (const value of direct) if (typeof value === "string" && value.trim()) return value.trim();
  for (const container of [event.message, event.response, event.session]) {
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    const record = container as Record<string, unknown>;
    for (const value of [record.model, record.model_id, record.modelId, record.model_snapshot]) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function mergeRedactions(
  ...groups: Array<Array<{ rule_id: string; count: number }> | undefined>
): Array<{ rule_id: string; count: number }> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const item of group || []) counts.set(item.rule_id, (counts.get(item.rule_id) || 0) + item.count);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rule_id, count]) => ({ rule_id, count }));
}

export type { NormalizedEvent };
