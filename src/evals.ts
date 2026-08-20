import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { resolveHarness } from "./artifacts.js";
import type { ResolvedRevision } from "./artifacts.js";
import { SCHEMA_VERSION, statePaths } from "./config.js";
import { HitchError, invalidInput } from "./errors.js";
import { atomicWriteJSON, ensureDir, readJSON } from "./fs.js";
import { parseHarnessReference } from "./harness-reference.js";
import { lockedHarnessRef, runHarborBackend } from "./harbor-backend.js";
import { ensureControllerRuntime, writeRuntimeReference, inspectEvalRuntimeKind } from "./controller-runtime/store.js";
import type { ControllerRuntimeUseResult } from "./controller-runtime/store.js";
import type { EvalId } from "./domain/types.js";

export const DEFAULT_EVAL_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_EVAL_SETUP_TIMEOUT_MS = 30 * 60 * 1_000;

const HARBOR_EVAL_BYPASS_ARG: Readonly<Record<string, string>> = {
  codex: "--dangerously-bypass-approvals-and-sandbox",
  opencode: "--dangerously-skip-permissions",
};

export function newEvalId(): EvalId {
  return `eval_${randomUUID().replaceAll("-", "")}` as EvalId;
}

export interface EvalRequestInput {
  schema_version?: unknown;
  backend?: unknown;
  dataset?: unknown;
  harness_ref?: unknown;
  model?: unknown;
  attempts?: unknown;
  max_concurrent?: unknown;
  timeout_ms?: unknown;
  setup_timeout_ms?: unknown;
  agent_args?: unknown;
  pass_env?: unknown;
}

export interface EvalRequest {
  schema_version: string;
  backend: "harbor";
  dataset: string;
  harness_ref: string;
  model: string;
  attempts: number;
  max_concurrent: number;
  timeout_ms: number;
  setup_timeout_ms: number;
  agent_args: string[];
  pass_env: string[];
}

export async function validateEvalRequest(input: EvalRequestInput): Promise<EvalRequest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidInput("eval request must be a JSON object");
  const allowed = new Set([
    "schema_version", "backend", "dataset", "harness_ref", "model", "attempts",
    "max_concurrent", "timeout_ms", "setup_timeout_ms", "agent_args", "pass_env",
  ]);
  const unexpected = Object.keys(input).find((field) => !allowed.has(field));
  if (unexpected) throw invalidInput(`unknown eval request field: ${unexpected}`);
  if (input.schema_version !== undefined && input.schema_version !== SCHEMA_VERSION) throw invalidInput(`unsupported schema_version: ${input.schema_version}`);
  if ((input.backend || "harbor") !== "harbor") throw invalidInput("only the harbor eval backend is currently supported");
  if (typeof input.dataset !== "string" || !input.dataset.trim()) throw invalidInput("dataset must be a non-empty string");
  if (typeof input.harness_ref !== "string" || !input.harness_ref.trim()) throw invalidInput("harness_ref must be a non-empty string");
  const reference = parseHarnessReference(input.harness_ref);
  if (reference.selector.type === "installed") {
    throw invalidInput("eval requires an immutable harness ref: version:<exact> or commit:<sha>");
  }
  if (reference.selector.type === "commit" && reference.selector.source?.explicit) {
    throw invalidInput("eval does not yet support local git+file harness refs; use a registered remote commit");
  }
  const attempts = positiveInteger(input.attempts ?? 1, "attempts");
  const maxConcurrent = positiveInteger(input.max_concurrent ?? 4, "max_concurrent");
  const timeout = nonNegativeNumber(input.timeout_ms ?? DEFAULT_EVAL_TIMEOUT_MS, "timeout_ms");
  const setupTimeout = nonNegativeNumber(input.setup_timeout_ms ?? DEFAULT_EVAL_SETUP_TIMEOUT_MS, "setup_timeout_ms");
  if (input.model !== undefined && typeof input.model !== "string") throw invalidInput("model must be a string");
  if (input.agent_args !== undefined && (!Array.isArray(input.agent_args) || input.agent_args.some((value) => typeof value !== "string"))) {
    throw invalidInput("agent_args must be an array of strings");
  }
  if (input.pass_env !== undefined && (!Array.isArray(input.pass_env) || input.pass_env.some((value) => typeof value !== "string"))) {
    throw invalidInput("pass_env must be an array of strings");
  }
  const agentArgs = Array.isArray(input.agent_args) ? [...input.agent_args] as string[] : [];
  const bypassArg = HARBOR_EVAL_BYPASS_ARG[reference.harness_id];
  if (bypassArg && !agentArgs.includes(bypassArg)) agentArgs.unshift(bypassArg);
  return {
    schema_version: SCHEMA_VERSION,
    backend: "harbor",
    dataset: String(input.dataset).trim(),
    harness_ref: reference.canonical,
    model: typeof input.model === "string" ? input.model : "",
    attempts,
    max_concurrent: maxConcurrent,
    timeout_ms: timeout,
    setup_timeout_ms: setupTimeout,
    agent_args: agentArgs,
    pass_env: [...new Set(Array.isArray(input.pass_env) ? input.pass_env as string[] : [])],
  };
}

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
  try {
    sink.emit({ type: "eval.started", backend: normalized.backend, dataset: normalized.dataset });
    const resolvedRevision = await resolveHarness(normalized.harness_ref, { root, env });
    if (resolvedRevision.source.type === "git" && resolvedRevision.source.registered !== true) {
      throw invalidInput("eval requires a registered remote Git source");
    }
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
      attempts: normalized.attempts,
      max_concurrent: normalized.max_concurrent,
      controller_runtime: {
        runtime_id: controllerRuntime.runtime_id,
        manifest_digest: controllerRuntime.manifest_digest,
      },
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
    const backendRun = await runHarborBackend({
      evalDirectory,
      request: normalized,
      root,
      resolvedRevision,
      runtimeDirectory: controllerRuntime.directory,
      runtimeId: controllerRuntime.runtime_id,
      env,
      ...(harborExecutable !== undefined ? { harborExecutable } : {}),
      ...(signal ? { signal } : {}),
      emit: (event) => sink.emit(event),
    });
    const cancelled = signal?.aborted;
    const succeeded = !cancelled && backendRun.backend.process_exit_code === 0 && backendRun.rawResult !== null;
    result = {
      schema_version: SCHEMA_VERSION,
      eval_id: evalId,
      status: cancelled ? "cancelled" : succeeded ? "succeeded" : "failed",
      exit_code: cancelled ? 9 : succeeded ? 0 : 13,
      backend: backendRun.backend,
      candidate: plan.candidate,
      dataset: normalized.dataset,
      summary: backendRun.summary,
      ...(succeeded ? {} : {
        error: {
          code: cancelled ? "cancelled" : "harbor_failed",
          message: cancelled
            ? "eval was cancelled"
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
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
    };
  }
  await atomicWriteJSON(path.join(evalDirectory, "result.json"), result);
  sink.emit({ type: result.status === "succeeded" ? "eval.completed" : "eval.failed", status: result.status, exit_code: result.exit_code, error: result.error });
  await sink.close();
  return result;
}

export interface ListedEval {
  eval_id: string;
  status: string;
  backend: string | null;
  dataset: string | null;
  harness_ref: string | null;
  primary_reward: number | null;
  started_at: string | null;
  completed_at: string | null;
}

export async function listEvals({ root }: { root: string }): Promise<ListedEval[]> {
  const directory = statePaths(root).evals;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const evals: ListedEval[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("eval_")) continue;
    const result = await readJSON<Record<string, unknown> | null>(path.join(directory, entry.name, "result.json"), null).catch(() => null);
    const request = await readJSON<Record<string, unknown> | null>(path.join(directory, entry.name, "request.json"), null).catch(() => null);
    if (!result && !request) continue;
    evals.push({
      eval_id: entry.name,
      status: (result?.status as string) || "running",
      backend: ((result?.backend as Record<string, unknown>)?.name as string) || (request?.backend as string) || null,
      dataset: (result?.dataset as string) || (request?.dataset as string) || null,
      harness_ref: ((result?.candidate as Record<string, unknown>)?.harness_ref as string) || (request?.harness_ref as string) || null,
      primary_reward: (result?.summary as Record<string, unknown>)?.primary_reward as number | null ?? null,
      started_at: (result?.started_at as string) || null,
      completed_at: (result?.completed_at as string) || null,
    });
  }
  return evals.sort((left, right) => String(right.started_at || right.eval_id).localeCompare(String(left.started_at || left.eval_id)));
}

export interface InspectedEval {
  schema_version: string;
  eval_id: string;
  directory: string;
  request: Record<string, unknown> | null;
  resolution: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  runtime_storage: "controller-runtime-ref-v1" | "embedded-runtime-v1" | "none";
}

export async function inspectEval(evalId: string, { root }: { root: string }): Promise<InspectedEval> {
  if (typeof evalId !== "string" || !/^eval_[a-f0-9]{32}$/.test(evalId)) throw invalidInput(`invalid eval ID: ${evalId}`);
  const directory = path.join(statePaths(root).evals, evalId);
  const request = await readJSON<Record<string, unknown> | null>(path.join(directory, "request.json"), null);
  if (!request) throw new HitchError(`eval not found: ${evalId}`, { code: "eval_not_found", exitCode: 3 });
  return {
    schema_version: SCHEMA_VERSION,
    eval_id: evalId,
    directory,
    request,
    resolution: await readJSON<Record<string, unknown> | null>(path.join(directory, "resolution.json"), null),
    plan: await readJSON<Record<string, unknown> | null>(path.join(directory, "plan.json"), null),
    result: await readJSON<Record<string, unknown> | null>(path.join(directory, "result.json"), null),
    runtime_storage: await inspectEvalRuntimeKind(directory),
  };
}

class EvalEventSink {
  readonly path: string;
  private readonly evalId: EvalId;
  private readonly onEvent: (event: Record<string, unknown>) => void;
  private sequence = 0;
  private pending: Promise<void> = Promise.resolve();
  private stream: WriteStream | undefined;
  private streamError: Error | undefined;

  constructor(evalDirectory: string, evalId: EvalId, onEvent: (event: Record<string, unknown>) => void = () => {}) {
    this.path = path.join(evalDirectory, "events.jsonl");
    this.evalId = evalId;
    this.onEvent = onEvent || (() => {});
  }

  async open(): Promise<void> {
    await ensureDir(path.dirname(this.path));
    this.stream = createWriteStream(this.path, { flags: "a", mode: 0o600 });
    this.stream.on("error", (error: Error) => { this.streamError ||= error; });
  }

  emit(event: Record<string, unknown>): Record<string, unknown> {
    const framed = {
      schema_version: SCHEMA_VERSION,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      eval_id: this.evalId,
      ...event,
    };
    this.pending = this.pending.then(() => writeChunk(this.stream as WriteStream, `${JSON.stringify(framed)}\n`));
    try { this.onEvent(framed); } catch { /* Observers cannot break eval persistence. */ }
    return framed;
  }

  async close(): Promise<void> {
    let failure: Error | undefined;
    try { await this.pending; } catch (error) { failure = error as Error; }
    try { await closeStream(this.stream); } catch (error) { failure ||= error as Error; }
    failure ||= this.streamError;
    if (failure) throw failure;
  }
}

function writeChunk(stream: WriteStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => stream.write(chunk, (error) => error ? reject(error) : resolve()));
}

function closeStream(stream: WriteStream | undefined): Promise<void> {
  if (!stream) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw invalidInput(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeNumber(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw invalidInput(`${name} must be a non-negative number`);
  return parsed;
}
