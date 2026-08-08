import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { getAdapter, normalizeRequest } from "./adapters.js";
import { EventSink } from "./events.js";
import { HitchError, invalidInput } from "./errors.js";
import { atomicWriteJSON, ensureDir } from "./fs.js";
import { inspectAgent } from "./registry.js";
import { consumeLines } from "./line-stream.js";
import { terminateProcess } from "./process.js";
import { SCHEMA_VERSION } from "./config.js";

export async function validateRunRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidInput("run request must be a JSON object");
  }
  const allowedFields = new Set(["schema_version", "agent", "model", "cwd", "prompt", "timeout_ms", "agent_args"]);
  const unexpectedField = Object.keys(input).find((field) => !allowedFields.has(field));
  if (unexpectedField) throw invalidInput(`unknown run request field: ${unexpectedField}`);
  if (input.schema_version !== undefined && input.schema_version !== SCHEMA_VERSION) {
    throw invalidInput(`unsupported schema_version: ${input.schema_version}`);
  }
  if (typeof input.agent !== "string" || !input.agent.trim()) throw invalidInput("agent must be a non-empty string");
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw invalidInput("prompt must be a non-empty string");
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || !input.cwd.trim())) {
    throw invalidInput("cwd must be a non-empty string");
  }
  if (input.model !== undefined && typeof input.model !== "string") throw invalidInput("model must be a string");
  if (input.timeout_ms !== undefined && (typeof input.timeout_ms !== "number" || !Number.isFinite(input.timeout_ms) || input.timeout_ms < 0)) {
    throw invalidInput("timeout_ms must be a non-negative number");
  }
  if (input.agent_args !== undefined && (!Array.isArray(input.agent_args) || input.agent_args.some((arg) => typeof arg !== "string"))) {
    throw invalidInput("agent_args must be an array of strings");
  }
  const request = normalizeRequest(input);
  getAdapter(request.agent);
  let workspace;
  try {
    workspace = await stat(request.cwd);
  } catch (error) {
    throw invalidInput(`workspace does not exist: ${request.cwd}`, { cause: error });
  }
  if (!workspace.isDirectory()) throw invalidInput(`workspace is not a directory: ${request.cwd}`);
  return request;
}

export function newRunId() {
  return `run_${randomUUID().replaceAll("-", "")}`;
}

export function buildManifest(runId, request) {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    status: "queued",
    agent: request.agent,
    requested_model: request.model || null,
    effective_model: request.model || null,
    workspace: request.cwd,
    timeout_ms: request.timeout_ms,
    agent_args_count: request.agent_args.length,
    agent_args_sha256: request.agent_args.length > 0
      ? createHash("sha256").update(JSON.stringify(request.agent_args)).digest("hex")
      : null,
    created_at: new Date().toISOString(),
  };
}

export async function executeRun({ runId, request, runsRoot, onEvent, onProcess, signal }) {
  const normalized = await validateRunRequest(request);
  const runDirectory = path.join(runsRoot, runId);
  await ensureDir(runDirectory);
  const manifestPath = path.join(runDirectory, "manifest.json");
  const resultPath = path.join(runDirectory, "result.json");
  const existingManifest = buildManifest(runId, normalized);
  let manifest = existingManifest;
  const startedAt = new Date();
  await atomicWriteJSON(path.join(runDirectory, "request.json"), {
    schema_version: SCHEMA_VERSION,
    ...normalized,
  });
  await atomicWriteJSON(manifestPath, existingManifest);

  let sink;
  let sinkOpened = false;
  let child;
  let timeout;
  let timedOut = false;
  let cancelled = false;
  const messageParts = [];
  let finalMessage;
  let abortHandler;
  let result;
  let stage = "discovery";

  try {
    const discovered = await inspectAgent(normalized.agent);
    if (!discovered || discovered.status !== "available") {
      throw new HitchError(`agent is not installed: ${normalized.agent}`, { code: "launch_failed", exitCode: 6 });
    }

    manifest = {
      ...existingManifest,
      status: "running",
      executable: discovered.executable,
      agent_version: discovered.version || null,
      agent_identity: discovered.identity,
      started_at: startedAt.toISOString(),
    };
    await atomicWriteJSON(manifestPath, manifest);

    stage = "event_setup";
    sink = new EventSink(runDirectory, runId, onEvent);
    await sink.open();
    sinkOpened = true;
    sink.emit({
      type: "run.started",
      agent: normalized.agent,
      model: normalized.model || null,
      agent_identity: discovered.identity,
    });

    stage = "adapter_setup";
    const adapter = getAdapter(normalized.agent);
    const adapterState = {};
    const specification = adapter.process(normalized, discovered.executable);
    if (signal?.aborted) {
      result = failureResult(runId, startedAt, "cancelled", "agent run cancelled before launch", 9);
      sink.emit({ type: "run.failed", status: "cancelled", error: result.error });
    } else {
      stage = "launch";
      child = spawn(specification.executable, specification.args, {
        cwd: normalized.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      child.stdin.on("error", () => { /* Process-level error/exit determines the typed result. */ });
      onProcess?.({ child });
      abortHandler = () => {
        cancelled = true;
        terminateProcess(child).catch(() => {});
      };
      signal?.addEventListener("abort", abortHandler, { once: true });

      consumeLines(child.stdout, (line) => {
        sink.writeStdout(line);
        let native;
        try {
          native = JSON.parse(line);
        } catch {
          sink.emit({ type: "process.stdout", text: line });
          return;
        }
        for (const event of adapter.translate(native, adapterState)) {
          if (event.type === "message.delta" && event.text) messageParts.push(event.text);
          if (event.type === "message.completed" && typeof event.text === "string") finalMessage = event.text;
          sink.emit(event);
        }
      });
      consumeLines(child.stderr, (line) => {
        sink.writeStderr(line);
        sink.emit({ type: "process.stderr", text: line });
      });

      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      stage = "running";
      const close = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, processSignal) => resolve({ code, signal: processSignal }));
      });

      if (normalized.timeout_ms > 0) {
        timeout = setTimeout(async () => {
          timedOut = true;
          await terminateProcess(child).catch(() => {});
        }, normalized.timeout_ms);
        timeout.unref?.();
      }

      child.stdin.end(specification.input);
      const exit = await close;
      if (timeout) clearTimeout(timeout);

      if (timedOut) {
        result = failureResult(runId, startedAt, "timed_out", "agent run timed out", 8, exit);
        sink.emit({ type: "run.failed", status: "timed_out", error: result.error });
      } else if (cancelled) {
        result = failureResult(runId, startedAt, "cancelled", "agent run cancelled", 9, exit);
        sink.emit({ type: "run.failed", status: "cancelled", error: result.error });
      } else if (exit.code !== 0) {
        const message = `agent exited with code ${exit.code ?? "null"}${exit.signal ? ` (${exit.signal})` : ""}`;
        result = failureResult(runId, startedAt, "agent_failed", message, 7, exit);
        sink.emit({ type: "run.failed", status: "failed", error: result.error });
      } else {
        result = {
          schema_version: SCHEMA_VERSION,
          run_id: runId,
          status: "succeeded",
          exit_code: 0,
          process_exit_code: exit.code,
          output: finalMessage ?? messageParts.join(""),
          started_at: startedAt.toISOString(),
          completed_at: new Date().toISOString(),
        };
        sink.emit({ type: "run.completed", status: "succeeded", exit_code: 0 });
      }
    }
  } catch (error) {
    if (timeout) clearTimeout(timeout);
    if (child) await terminateProcess(child).catch(() => {});
    const launchStage = stage === "discovery" || stage === "adapter_setup" || stage === "launch";
    const code = error instanceof HitchError ? error.code : launchStage ? "launch_failed" : "internal_error";
    const exitCode = error instanceof HitchError ? error.exitCode : launchStage ? 6 : 12;
    result = failureResult(runId, startedAt, code, error?.message || String(error), exitCode);
    if (sinkOpened) {
      try { sink.emit({ type: "run.failed", status: result.status, error: result.error }); } catch { /* Finalization below remains authoritative. */ }
    }
  } finally {
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    onProcess?.(null);
  }

  if (sinkOpened) {
    try {
      await sink.close();
    } catch (error) {
      result = failureResult(runId, startedAt, "event_recording_failed", error.message, 12);
    }
  }
  if (!result) result = failureResult(runId, startedAt, "internal_error", "run ended without a result", 12);
  await atomicWriteJSON(resultPath, result);
  await atomicWriteJSON(manifestPath, { ...manifest, status: result.status, completed_at: result.completed_at });
  return result;
}

export async function createQueuedRun({ runId = newRunId(), request, runsRoot }) {
  const normalized = await validateRunRequest(request);
  const directory = await ensureDir(path.join(runsRoot, runId));
  await atomicWriteJSON(path.join(directory, "manifest.json"), buildManifest(runId, normalized));
  await atomicWriteJSON(path.join(directory, "request.json"), { ...normalized, schema_version: SCHEMA_VERSION });
  return { runId, request: normalized, directory };
}

function failureResult(runId, startedAt, code, message, exitCode, processExit = {}) {
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
