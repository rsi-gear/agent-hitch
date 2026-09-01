import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { HitchError, consumeLines, createCredentialRedactionTransform, credentialValuesFromEnv, terminateProcess } from "../../foundation/index.js";

const SUPERVISOR_PATH = fileURLToPath(new URL("./supervisor.js", import.meta.url));

export interface HarborProcessCallbacks {
  onStarted?: (pid: number) => void | Promise<void>;
  onExited?: (result: { code: number | null; signal: NodeJS.Signals | null }) => void | Promise<void>;
  persistAcrossParentExit?: boolean;
  exitStatusPath?: string;
  redactEnvNames?: readonly string[];
}

export function invokeHarbor(
  executable: string,
  args: string[],
  { cwd, env, stdoutPath, stderrPath, signal, emit, onStarted, onExited, persistAcrossParentExit, exitStatusPath, redactEnvNames = [] }: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdoutPath: string;
    stderrPath: string;
    signal?: AbortSignal;
    emit: (event: Record<string, unknown>) => void;
    redactEnvNames?: readonly string[];
  } & HarborProcessCallbacks,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (onStarted && persistAcrossParentExit) {
    if (!exitStatusPath) throw new TypeError("recoverable Harbor process requires an exit status path");
    return invokeRecoverableHarbor(executable, args, {
      cwd,
      env,
      stdoutPath,
      stderrPath,
      emit,
      onStarted,
      exitStatusPath,
      redactEnvNames,
      ...(signal ? { signal } : {}),
      ...(onExited ? { onExited } : {}),
    });
  }
  return new Promise((resolve, reject) => {
    const credentialValues = credentialValuesFromEnv(redactEnvNames, env);
    const stdout = createWriteStream(stdoutPath, { flags: "w", mode: 0o600 });
    const stderr = createWriteStream(stderrPath, { flags: "w", mode: 0o600 });
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const safeStdout = createCredentialRedactionTransform(credentialValues);
    const safeStderr = createCredentialRedactionTransform(credentialValues);
    consumeLines(safeStdout, (line) => emit({ type: "eval.backend.output", stream: "stdout", text: line }));
    consumeLines(safeStderr, (line) => emit({ type: "eval.backend.output", stream: "stderr", text: line }));
    let settled = false;
    const abort = () => terminateProcess(child).catch(() => {});
    const streams = Promise.all([
      pipeline(child.stdout, safeStdout, stdout),
      pipeline(child.stderr, safeStderr, stderr),
    ]);
    streams.catch((error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      abort();
      reject(new HitchError(`failed to persist Harbor output: ${(error as Error).message}`, {
        code: "harbor_log_write_failed",
        exitCode: 12,
        cause: error,
      }));
    });
    signal?.addEventListener("abort", abort, { once: true });
    const started = child.pid === undefined ? Promise.resolve() : Promise.resolve(onStarted?.(child.pid));
    started.catch((error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      abort();
      stdout.destroy();
      stderr.destroy();
      reject(new HitchError(`failed to record Harbor process identity: ${(error as Error).message}`, {
        code: "provider_process_record_failed",
        exitCode: 12,
        cause: error,
      }));
    });
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
      const result = { code, signal: processSignal };
      Promise.all([started, streams])
        .then(async () => { await onExited?.(result); resolve(result); })
        .catch(reject);
    });
    if (signal?.aborted) abort();
  });
}

function invokeRecoverableHarbor(
  executable: string,
  args: string[],
  { cwd, env, stdoutPath, stderrPath, signal, emit, onStarted, onExited, exitStatusPath, redactEnvNames }: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdoutPath: string;
    stderrPath: string;
    signal?: AbortSignal;
    emit: (event: Record<string, unknown>) => void;
    onStarted: (pid: number) => void | Promise<void>;
    onExited?: (result: { code: number | null; signal: NodeJS.Signals | null }) => void | Promise<void>;
    exitStatusPath: string;
    redactEnvNames: readonly string[];
  },
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    credentialValuesFromEnv(redactEnvNames, env);
    const child: ChildProcess = spawn(process.execPath, [
      SUPERVISOR_PATH, exitStatusPath, stdoutPath, stderrPath, JSON.stringify(redactEnvNames), executable, ...args,
    ], {
      cwd,
      env,
      stdio: "ignore",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let settled = false;
    const abort = () => terminateProcess(child).catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });
    const started = child.pid === undefined
      ? Promise.reject(new HitchError("Harbor process has no PID", { code: "harbor_launch_failed", exitCode: 6 }))
      : Promise.resolve(onStarted(child.pid));
    started.then(() => emit({ type: "eval.backend.process-recorded", process_id: child.pid })).catch((error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      abort();
      reject(new HitchError(`failed to record Harbor process identity: ${(error as Error).message}`, {
        code: "provider_process_record_failed",
        exitCode: 12,
        cause: error,
      }));
    });
    child.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      reject(new HitchError(`failed to launch Harbor: ${error.message}`, { code: "harbor_launch_failed", exitCode: 6, cause: error }));
    });
    child.once("close", (code: number | null, processSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      started.then(async () => {
        const result = await readHarborProcessExitStatus(exitStatusPath) ?? { code, signal: processSignal };
        await onExited?.(result);
        resolve(result);
      }).catch(reject);
    });
    if (signal?.aborted) abort();
  });
}

export async function readHarborProcessExitStatus(file: string): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  let value: unknown;
  try { value = JSON.parse(await readFile(file, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new TypeError("Harbor process exit status is invalid");
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Harbor process exit status is invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !new Set(["schema_version", "process_exit_code", "signal", "completed_at"]).has(key))
    || record.schema_version !== "1"
    || (record.process_exit_code !== null && !Number.isSafeInteger(record.process_exit_code))
    || (record.signal !== null && typeof record.signal !== "string")
    || typeof record.completed_at !== "string" || !Number.isFinite(Date.parse(record.completed_at))) {
    throw new TypeError("Harbor process exit status is invalid");
  }
  return { code: record.process_exit_code as number | null, signal: record.signal as NodeJS.Signals | null };
}
