import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { ExecutionObservationProbeV1 } from "../../domain/index.js";
import { HitchError, prepareSpawnCommand } from "../../foundation/index.js";

type Probe = ExecutionObservationProbeV1["probe"];
type Outcome = "ok" | "spawn_error" | "nonzero_exit" | "signal_exit" | "timed_out" | "output_limit" | "invalid_encoding";
export interface ObservationProbeResult {
  outcome: Outcome;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  signal: ExecutionObservationProbeV1["signal"];
}
const commands: Record<Probe, string[]> = {
  harbor_version: ["--version"], docker_info: ["info", "--format", "{{json .}}"], buildx_version: ["buildx", "version"],
};
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Only the three fixed observation commands; failures never expose child output or error messages. */
export async function runObservationProbe(executable: string, probe: Probe, input: {
  env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number;
}): Promise<ObservationProbeResult> {
  input.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      const invocation = prepareSpawnCommand(executable, commands[probe]);
      child = spawn(invocation.executable, invocation.args, {
        env: input.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        detached: process.platform !== "win32", windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
    } catch {
      resolve({ outcome: "spawn_error", stdout: "", stderr: "", exit_code: null, signal: null });
      return;
    }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0;
    let failure: Outcome | undefined, spawnFailed = false;
    let termination: Promise<void> | undefined;
    const stop = (reason: Outcome) => {
      failure ??= reason;
      termination ??= stopProbe(child);
      void termination.catch(() => {});
    };
    const append = (chunks: Buffer[], bytes: number, chunk: Buffer) => {
      if (bytes > MAX_OUTPUT_BYTES) stop("output_limit");
      else if (!failure) chunks.push(chunk);
    };
    child.stdout!.on("data", (chunk: Buffer) => { stdoutBytes += chunk.byteLength; append(stdout, stdoutBytes, chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderrBytes += chunk.byteLength; append(stderr, stderrBytes, chunk); });
    const timer = setTimeout(() => stop("timed_out"), input.timeoutMs);
    timer.unref();
    const abort = () => stop("timed_out");
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    child.once("error", () => { spawnFailed = true; });
    child.once("close", (code, processSignal) => {
      clearTimeout(timer);
      // Wait for termination as well as stdio close before another attempt or observer can start.
      void (async () => {
        await termination;
        input.signal.throwIfAborted();
        const signal: ObservationProbeResult["signal"] = processSignal === null ? null
          : processSignal === "SIGTERM" || processSignal === "SIGKILL" ? processSignal : "other";
        const base = { stdout: "", stderr: "", exit_code: code, signal };
        if (failure) return { ...base, outcome: failure };
        if (spawnFailed) return { ...base, outcome: "spawn_error" as const };
        if (processSignal) return { ...base, outcome: "signal_exit" as const };
        if (code !== 0) return { ...base, outcome: "nonzero_exit" as const };
        try {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          return { ...base, outcome: "ok" as const,
            stdout: decoder.decode(Buffer.concat(stdout)), stderr: decoder.decode(Buffer.concat(stderr)) };
        } catch { return { ...base, outcome: "invalid_encoding" as const }; }
      })().then(resolve, reject).finally(() => input.signal.removeEventListener("abort", abort));
    });
  });
}

async function stopProbe(child: ChildProcess): Promise<void> {
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new HitchError("Observation probe process cleanup failed", { code: "execution_observation_cleanup_failed", exitCode: 12 }));
      killer.once("error", failed);
      killer.once("close", code => { if (code === 0) resolve(); else failed(); });
    });
    // Do not cut off a tree kill and substitute parent-only termination. The probe
    // still awaits its own stdio close; a failed tree kill must not permit retry.
    return;
  }
  const kill = (signal: NodeJS.Signals) => {
    try { process.kill(-child.pid!, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw new HitchError("Observation probe process cleanup failed", { code: "execution_observation_cleanup_failed", exitCode: 12 });
      }
    }
  };
  kill("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 500));
  // The launcher can exit on TERM while descendants still hold its pipes open.
  // Kill the group even when child.exitCode is already set.
  kill("SIGKILL");
}

/** A cancelled hash does not finish until its file descriptor is closed. */
export async function fingerprintObservationExecutable(executable: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const hash = createHash("sha256"), stream = createReadStream(executable, { signal });
  const closed = new Promise<void>(resolve => stream.once("close", resolve));
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer);
    signal.throwIfAborted();
    return `sha256:${hash.digest("hex")}`;
  } finally {
    stream.destroy();
    await closed;
  }
}
