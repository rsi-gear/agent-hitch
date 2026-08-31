import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { HitchError, consumeLines, terminateProcess } from "../../foundation/index.js";

export interface HarborProcessCallbacks {
  onStarted?: (pid: number) => void | Promise<void>;
  onExited?: (result: { code: number | null; signal: NodeJS.Signals | null }) => void | Promise<void>;
}

export function invokeHarbor(
  executable: string,
  args: string[],
  { cwd, env, stdoutPath, stderrPath, signal, emit, onStarted, onExited }: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdoutPath: string;
    stderrPath: string;
    signal?: AbortSignal;
    emit: (event: Record<string, unknown>) => void;
  } & HarborProcessCallbacks,
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
      Promise.all([started, closeWriteStream(stdout), closeWriteStream(stderr)])
        .then(async () => { await onExited?.(result); resolve(result); })
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
