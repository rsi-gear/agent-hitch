import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path, { delimiter, isAbsolute, join, resolve } from "node:path";
import { HitchError } from "./errors.js";
import { terminateProcess } from "./process.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  failureCode?: string;
  failureExitCode?: number;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

export interface SpawnCommand {
  executable: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

export function runCommand(executable: string, args: string[], {
  cwd,
  env = process.env,
  failureCode = "internal_error",
  failureExitCode = 12,
  timeoutMs = 30 * 60 * 1_000,
  signal,
}: RunCommandOptions = {}): Promise<CommandResult> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const invocation = prepareSpawnCommand(executable, args);
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    let settled = false;
    const append = (current: string, chunk: Buffer | string) => `${current}${chunk}`.slice(-1_000_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => terminateProcess(child).catch(() => {}), timeoutMs);
    timer.unref?.();
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      callback();
    };
    const abortHandler = () => {
      aborted = true;
      terminateProcess(child).catch(() => {});
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    child.once("error", (error: Error) => {
      finish(() => reject(new HitchError(`failed to start ${path.basename(executable)}: ${error.message}`, {
        code: failureCode,
        exitCode: failureExitCode,
        cause: error,
      })));
    });
    child.once("close", (code: number | null, processSignal: NodeJS.Signals | null) => {
      if (aborted) return finish(() => reject(cancelledError()));
      if (code === 0) return finish(() => resolve({ stdout, stderr }));
      const detail = stderr.trim() || stdout.trim();
      finish(() => reject(new HitchError(
        `${path.basename(executable)} exited with code ${code ?? "null"}${processSignal ? ` (${processSignal})` : ""}${detail ? `: ${detail}` : ""}`,
        { code: failureCode, exitCode: failureExitCode },
      )));
    });
  });
}

export function commandExecutable(command: string, env: NodeJS.ProcessEnv): string {
  const override = {
    npm: "HITCH_NPM_PATH",
    git: "HITCH_GIT_PATH",
    cargo: "HITCH_CARGO_PATH",
    bun: "HITCH_BUN_PATH",
    pnpm: "HITCH_PNPM_PATH",
  }[command];
  if (override && env[override]?.trim()) return env[override].trim();
  return process.platform === "win32" && new Set(["npm", "pnpm"]).has(command) ? `${command}.cmd` : command;
}

export async function commandVersion(executable: string, env: NodeJS.ProcessEnv, signal: AbortSignal | undefined): Promise<string> {
  try {
    return (await runCommand(executable, ["--version"], { env, signal, timeoutMs: 5_000 })).stdout.trim() || "unknown";
  } catch (error) {
    if ((error as HitchError)?.code === "cancelled") throw error;
    return "unknown";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError();
}

function cancelledError(): HitchError {
  return new HitchError("harness preparation cancelled", { code: "cancelled", exitCode: 9 });
}

export async function resolveExecutable(command: string, searchPath: string, pathExt = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD"): Promise<string | null> {
  const bases = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [resolve(command)]
    : searchPath.split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  const extensions = process.platform === "win32" ? pathExt.split(";").map((entry) => entry.trim()).filter(Boolean) : [];
  const knownExtension = extensions.some((extension) => command.toLowerCase().endsWith(extension.toLowerCase()));
  const candidates = bases.flatMap((base) => knownExtension ? [base] : [base, ...extensions.map((extension) => `${base}${extension}`)]);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const info = await lstat(candidate);
      if (info.isDirectory()) continue;
      return await realpath(candidate);
    } catch {
      // Keep probing PATH entries.
    }
  }
  return null;
}

export async function detectVersion(executable: string, args: string[], timeoutMs = 5_000): Promise<string> {
  return new Promise((resolveVersion) => {
    const invocation = prepareSpawnCommand(executable, args);
    const child = spawn(invocation.executable, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.once("error", () => {
      clearTimeout(timer);
      resolveVersion("");
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolveVersion(selectVersionLine(stdout, stderr));
    });
  });
}

export function prepareSpawnCommand(
  executable: string,
  args: string[],
  { platform = process.platform, comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe" }: { platform?: NodeJS.Platform; comspec?: string } = {},
): SpawnCommand {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { executable, args: [...args], windowsVerbatimArguments: false };
  }
  if ([executable, ...args].some((value) => value.includes("\0") || /[\r\n]/.test(value))) {
    throw new HitchError("Windows batch command contains an unsupported control character", { code: "invalid_input", exitCode: 2 });
  }
  const doubleEscape = /node_modules[\\/]+\.bin[\\/]+[^\\/]+\.cmd$/i.test(executable);
  const commandLine = [escapeWindowsCommand(executable), ...args.map((argument) => escapeWindowsArgument(argument, doubleEscape))].join(" ");
  return {
    executable: comspec,
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

const WINDOWS_CMD_META = /([()\][%!^"`<>&|;,*? ])/g;

function escapeWindowsCommand(value: string): string {
  return value.replace(WINDOWS_CMD_META, "^$1");
}

function escapeWindowsArgument(value: string, doubleEscapeMetaCharacters: boolean): string {
  let escaped = value.replace(/(\\*)"/g, "$1$1\\\"");
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(WINDOWS_CMD_META, "^$1");
  if (doubleEscapeMetaCharacters) escaped = escaped.replace(WINDOWS_CMD_META, "^$1");
  return escaped;
}

export async function fingerprintExecutable(executable: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(executable)) hash.update(chunk as Buffer);
  return `sha256:${hash.digest("hex")}`;
}

export function selectVersionLine(stdout: string, stderr: string): string {
  const versionPattern = /(?:^|\s)v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/;
  for (const stream of [stdout, stderr]) {
    const match = String(stream || "").split(/\r?\n/).map((line) => line.trim()).find((line) => versionPattern.test(line));
    if (match) return match;
  }
  return "";
}
