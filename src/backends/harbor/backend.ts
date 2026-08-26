import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { HitchError, atomicWriteJSON, consumeLines, detectVersion, ensureDir, fingerprintExecutable, invalidInput, packageRoot, readJSON, sha256JSON, statePaths, terminateProcess } from "../../foundation/index.js";
import type { EvalRequest, ResolvedRevision } from "../../domain/index.js";
import type { LocalGitTransportUse } from "./local-git-transport.js";
import { HARBOR_CREDENTIAL_ENV, locateHarbor } from "./tools.js";

const BRIDGE_DIRECTORY = path.join(packageRoot(), "integrations", "harbor");

export interface RunHarborBackendOptions {
  evalId: string;
  evalDirectory: string;
  request: EvalRequest;
  root: string;
  resolvedRevision: ResolvedRevision;
  runtimeDirectory: string;
  runtimeId?: string;
  preparedArtifact?: HarborPreparedArtifactUse;
  localTransport?: LocalGitTransportUse;
  env?: NodeJS.ProcessEnv;
  harborExecutable?: string;
  signal?: AbortSignal;
  emit?: (event: Record<string, unknown>) => void;
}

export interface HarborPreparedArtifactUse {
  directory: string;
  artifact_id: string;
  artifact_integrity: string;
  entrypoint_integrity: string;
  harness_id: string;
  revision_identity: string;
  adapter_version: string;
  recipe_version: string;
  platform: string;
  node_version: string;
  source_type: string;
}

export interface HarborBackendResult {
  backend: {
    name: string;
    executable: string;
    version: string | null;
    identity: string;
    config_path: string;
    result_path: string | null;
    stdout_path: string;
    stderr_path: string;
    process_exit_code: number | null;
    signal: NodeJS.Signals | null;
    job_directory: string;
  };
  rawResult: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
}

export async function runHarborBackend({
  evalId,
  evalDirectory,
  request,
  root,
  resolvedRevision,
  runtimeDirectory,
  runtimeId,
  preparedArtifact,
  localTransport,
  env = process.env,
  harborExecutable,
  signal,
  emit = () => {},
}: RunHarborBackendOptions): Promise<HarborBackendResult> {
  const backendDirectory = await ensureDir(path.join(evalDirectory, "harbor"));
  const harnessArtifactCacheDirectory = await ensureDir(path.join(statePaths(root).store, "harbor-artifacts"));
  const executable = await discoverHarbor(harborExecutable, root, env);
  const version = await detectVersion(executable, ["--version"]);
  const identity = await fingerprintExecutable(executable);
  const jobName = "job";
  const configPath = path.join(backendDirectory, "job.json");
  const jobDirectory = path.join(backendDirectory, jobName);
  const resultPath = path.join(jobDirectory, "result.json");
  const config = await buildHarborJobConfig({
    evalId,
    request,
    resolvedRevision,
    runtimeDirectory,
    runtimeId,
    preparedArtifact,
    harnessArtifactCacheDirectory,
    localTransport,
    backendDirectory,
    jobName,
    env,
  });
  await atomicWriteJSON(configPath, config);
  emit({ type: "eval.backend.started", backend: "harbor", executable, version: version || null });

  const invocation = await invokeHarbor(executable, ["run", "--config", configPath, "--yes"], {
    cwd: evalDirectory,
    env: withBridgePythonPath(env),
    stdoutPath: path.join(backendDirectory, "stdout.log"),
    stderrPath: path.join(backendDirectory, "stderr.log"),
    ...(signal ? { signal } : {}),
    emit,
  });
  const jobResult = await readJSON<Record<string, unknown> | null>(resultPath, null);
  const rawResult = jobResult ? await attachTrialResults(jobDirectory, jobResult) : null;
  emit({
    type: "eval.backend.completed",
    backend: "harbor",
    process_exit_code: invocation.code,
    signal: invocation.signal,
    result_available: rawResult !== null,
  });

  return {
    backend: {
      name: "harbor",
      executable,
      version: version || null,
      identity,
      config_path: path.relative(evalDirectory, configPath).split(path.sep).join("/"),
      result_path: rawResult ? path.relative(evalDirectory, resultPath).split(path.sep).join("/") : null,
      stdout_path: path.relative(evalDirectory, path.join(backendDirectory, "stdout.log")).split(path.sep).join("/"),
      stderr_path: path.relative(evalDirectory, path.join(backendDirectory, "stderr.log")).split(path.sep).join("/"),
      process_exit_code: invocation.code,
      signal: invocation.signal,
      job_directory: path.relative(evalDirectory, jobDirectory).split(path.sep).join("/"),
    },
    rawResult,
    summary: rawResult ? normalizeHarborResult(rawResult) : null,
  };
}

async function attachTrialResults(jobDirectory: string, jobResult: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (Array.isArray(jobResult.trial_results)) return jobResult;
  let entries;
  try {
    entries = await readdir(jobDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return jobResult;
    throw error;
  }
  const trialResults: Record<string, unknown>[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const trial = await readJSON<Record<string, unknown> | null>(path.join(jobDirectory, entry.name, "result.json"), null);
    if (trial?.trial_name && trial?.task_name) trialResults.push(trial);
  }
  return { ...jobResult, trial_results: trialResults };
}

export interface BuildHarborJobConfigOptions {
  evalId?: string;
  request: EvalRequest;
  resolvedRevision: ResolvedRevision;
  runtimeDirectory: string;
  runtimeId?: string | undefined;
  preparedArtifact?: HarborPreparedArtifactUse | undefined;
  harnessArtifactCacheDirectory?: string | undefined;
  localTransport?: LocalGitTransportUse | undefined;
  backendDirectory: string;
  jobName?: string;
  env?: NodeJS.ProcessEnv;
}

export async function buildHarborJobConfig({
  evalId,
  request,
  resolvedRevision,
  runtimeDirectory,
  runtimeId,
  preparedArtifact,
  harnessArtifactCacheDirectory,
  localTransport,
  backendDirectory,
  jobName = "job",
  env = process.env,
}: BuildHarborJobConfigOptions): Promise<Record<string, unknown>> {
  const timeoutSeconds = request.timeout_ms > 0 ? Math.ceil(request.timeout_ms / 1_000) : null;
  const setupTimeoutSeconds = request.setup_timeout_ms > 0 ? Math.ceil(request.setup_timeout_ms / 1_000) : null;
  const agent: Record<string, unknown> = {
    import_path: "hitch_harbor_agent:HitchHarborAgent",
    model_name: request.model || null,
    kwargs: {
      candidate_id: "candidate-1",
      ...(evalId ? {
        eval_id: evalId,
        benchmark_id: request.benchmark_id,
        benchmark_revision: request.benchmark_revision,
        verifier_identity: sha256JSON({
          backend: "harbor",
          benchmark_id: request.benchmark_id,
          benchmark_revision: request.benchmark_revision,
          verifier: "dataset",
        }),
      } : {}),
      harness_ref: lockedHarnessRef(resolvedRevision),
      revision_identity: resolvedRevision.identity,
      // The bridge consumes the shared compiled runtime cache. The local
      // absolute cache path is diagnostic machine-local state, not identity
      // (spec §4.2); `runtime_id` records the exact execution payload.
      hitch_runtime_dir: runtimeDirectory,
      ...(runtimeId ? { controller_runtime_id: runtimeId } : {}),
      ...(harnessArtifactCacheDirectory ? { harness_artifact_cache_dir: harnessArtifactCacheDirectory } : {}),
      ...(preparedArtifact ? {
        harness_artifact: {
          directory: preparedArtifact.directory,
          artifact_id: preparedArtifact.artifact_id,
          artifact_integrity: preparedArtifact.artifact_integrity,
          entrypoint_integrity: preparedArtifact.entrypoint_integrity,
          harness_id: preparedArtifact.harness_id,
          revision_identity: preparedArtifact.revision_identity,
          adapter_version: preparedArtifact.adapter_version,
          recipe_version: preparedArtifact.recipe_version,
          platform: preparedArtifact.platform,
          node_version: preparedArtifact.node_version,
          source_type: preparedArtifact.source_type,
        },
      } : {}),
      ...(localTransport ? {
        local_source_transport: {
          kind: localTransport.manifest.kind,
          manifest_path: localTransport.manifestPath,
          payload_path: localTransport.payloadPath,
          locked_resolution_path: localTransport.resolutionPath,
          harness_id: localTransport.manifest.harness_id,
          resolution_identity: localTransport.manifest.resolution_identity,
          commit: localTransport.manifest.commit,
          tree: localTransport.manifest.tree,
          payload_sha256: localTransport.manifest.payload_sha256,
          payload_bytes: localTransport.manifest.payload_bytes,
          object_count: localTransport.manifest.object_count,
          file_count: localTransport.manifest.file_count,
        },
      } : {}),
      hitch_timeout_ms: request.timeout_ms,
      agent_args: request.agent_args,
      workdir: "/app",
    },
    env: credentialEnvironment(request.pass_env, env),
    include_logs: ["hitch-*"],
  };
  if (timeoutSeconds !== null) agent.override_timeout_sec = timeoutSeconds + 30;
  if (setupTimeoutSeconds !== null) agent.override_setup_timeout_sec = setupTimeoutSeconds;

  return compact({
    job_name: jobName,
    jobs_dir: backendDirectory,
    n_attempts: request.attempts,
    n_concurrent_trials: request.max_concurrent,
    environment: { type: "docker", delete: true },
    agents: [agent],
    datasets: [await datasetConfig(request.dataset)],
    tasks: [],
  });
}

export function lockedHarnessRef(resolvedRevision: ResolvedRevision): string {
  if (resolvedRevision?.revision?.type === "version" && resolvedRevision.revision.version) {
    return `${resolvedRevision.harness_id}@version:${resolvedRevision.revision.version}`;
  }
  if (resolvedRevision?.revision?.type === "commit" && resolvedRevision.revision.commit) {
    return `${resolvedRevision.harness_id}@commit:${resolvedRevision.revision.commit}`;
  }
  throw invalidInput("Harbor eval requires a resolved exact version or commit");
}

export function normalizeHarborResult(raw: Record<string, unknown>): Record<string, unknown> {
  const trials = Array.isArray(raw?.trial_results) ? raw.trial_results as Record<string, unknown>[] : [];
  const rewardValues = new Map<string, number[]>();
  const normalizedTrials = trials.map((trial) => {
    const verifier = (trial?.verifier_result || {}) as Record<string, unknown>;
    const rewards = (verifier.rewards || {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(rewards)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const values = rewardValues.get(name) || [];
      values.push(value);
      rewardValues.set(name, values);
    }
    return {
      task_name: trial?.task_name || null,
      trial_name: trial?.trial_name || null,
      status: trial?.exception_info ? "errored" : "completed",
      rewards,
      exception: trial?.exception_info || null,
    };
  });
  const rewards = Object.fromEntries([...rewardValues.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, values]) => [name, {
    count: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  }]));
  const rewardEntries = Object.entries(rewards);
  const primary = (rewards.reward as Record<string, unknown>) || rewardEntries[0]?.[1] || null;
  const stats = (raw?.stats || {}) as Record<string, unknown>;
  return {
    n_trials: raw?.n_total_trials ?? trials.length,
    n_completed: stats.n_completed_trials ?? normalizedTrials.filter((trial) => trial.status === "completed").length,
    n_errored: stats.n_errored_trials ?? normalizedTrials.filter((trial) => trial.status === "errored").length,
    n_cancelled: stats.n_cancelled_trials ?? 0,
    primary_reward: (primary as Record<string, unknown>)?.mean ?? null,
    rewards,
    trials: normalizedTrials,
  };
}

async function discoverHarbor(explicit: string | undefined, root: string, env: NodeJS.ProcessEnv): Promise<string> {
  const located = await locateHarbor({ root, explicit, env });
  if (!located.executable) {
    throw new HitchError(`Harbor executable not found: ${located.requested}`, {
      code: "harbor_unavailable",
      exitCode: 3,
    });
  }
  return located.executable;
}

async function datasetConfig(value: string): Promise<Record<string, unknown>> {
  if (typeof value !== "string" || !value.trim()) throw invalidInput("dataset must be a non-empty string");
  const raw = value.trim();
  const localPath = path.resolve(raw);
  try {
    if ((await stat(localPath)).isDirectory()) return { path: localPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const separator = raw.lastIndexOf("@");
  const name = separator > 0 ? raw.slice(0, separator) : raw;
  const version = separator > 0 ? raw.slice(separator + 1) : "";
  if (!name) throw invalidInput(`invalid Harbor dataset: ${value}`);
  return name.includes("/")
    ? { name, ref: version || "latest" }
    : compact({ name, version: version || undefined });
}

function credentialEnvironment(explicitNames: string[], env: NodeJS.ProcessEnv): Record<string, string> {
  const names = new Set(HARBOR_CREDENTIAL_ENV.filter((name) => env[name] !== undefined));
  for (const name of explicitNames || []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw invalidInput(`invalid environment variable name: ${name}`);
    if (env[name] === undefined) throw invalidInput(`environment variable is not set: ${name}`);
    names.add(name);
  }
  return Object.fromEntries([...names].sort().map((name) => [name, `\${${name}}`]));
}

function withBridgePythonPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    PYTHONPATH: [BRIDGE_DIRECTORY, env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };
}

function invokeHarbor(
  executable: string,
  args: string[],
  { cwd, env, stdoutPath, stderrPath, signal, emit }: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdoutPath: string;
    stderrPath: string;
    signal?: AbortSignal;
    emit: (event: Record<string, unknown>) => void;
  },
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const stdout = createWriteStream(stdoutPath, { flags: "w", mode: 0o600 });
    const stderr = createWriteStream(stderrPath, { flags: "w", mode: 0o600 });
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    consumeLines(child.stdout, (line) => emit({ type: "eval.backend.output", stream: "stdout", text: line }));
    consumeLines(child.stderr, (line) => emit({ type: "eval.backend.output", stream: "stderr", text: line }));
    let settled = false;
    const abort = () => terminateProcess(child).catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      stdout.destroy();
      stderr.destroy();
      reject(new HitchError(`failed to launch Harbor: ${error.message}`, {
        code: "harbor_launch_failed",
        exitCode: 6,
        cause: error,
      }));
    });
    child.once("close", (code: number | null, processSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      Promise.all([closeWriteStream(stdout), closeWriteStream(stderr)])
        .then(() => resolve({ code, signal: processSignal }))
        .catch(reject);
    });
    if (signal?.aborted) abort();
  });
}

function closeWriteStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stream.closed) return resolve();
    stream.once("error", reject);
    stream.once("close", resolve);
    stream.end();
  });
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}
