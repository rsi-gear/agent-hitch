import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createCredentialRedactionTransform, credentialValuesFromEnv } from "../../foundation/index.js";

interface ExitStatus {
  schema_version: "1";
  process_exit_code: number | null;
  signal: NodeJS.Signals | null;
  completed_at: string;
}

async function main(): Promise<void> {
  const [, , statusPath, stdoutPath, stderrPath, redactionNamesJSON, executable, ...args] = process.argv;
  if (!statusPath || !stdoutPath || !stderrPath || !redactionNamesJSON || !executable) {
    process.stderr.write("Harbor supervisor requires status/log paths, redaction names, and executable\n");
    process.exitCode = 2;
    return;
  }
  const redactionNames = parseRedactionNames(redactionNamesJSON);
  const result = await supervise(executable, args, stdoutPath, stderrPath, redactionNames);
  await persist(statusPath, result);
  process.exitCode = result.process_exit_code === null ? 1 : Math.max(0, Math.min(255, result.process_exit_code));
}

function supervise(executable: string, args: string[], stdoutPath: string, stderrPath: string, redactionNames: string[]): Promise<ExitStatus> {
  return new Promise((resolve) => {
    const credentialValues = credentialValuesFromEnv(redactionNames, process.env);
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const streams = Promise.all([
      pipeline(child.stdout, createCredentialRedactionTransform(credentialValues), createWriteStream(stdoutPath, { flags: "w", mode: 0o600 })),
      pipeline(child.stderr, createCredentialRedactionTransform(credentialValues), createWriteStream(stderrPath, { flags: "w", mode: 0o600 })),
    ]);
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      streams.then(() => resolve(status(code, signal)), () => resolve(status(74, null)));
    };
    child.once("error", () => finish(127, null));
    child.once("close", (code, signal) => {
      finish(code, signal);
    });
  });
}

function parseRedactionNames(value: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new TypeError("Harbor supervisor redaction names are invalid JSON"); }
  if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    || new Set(parsed).size !== parsed.length) throw new TypeError("Harbor supervisor redaction names are invalid");
  return [...parsed].sort();
}

function status(processExitCode: number | null, signal: NodeJS.Signals | null): ExitStatus {
  return {
    schema_version: "1",
    process_exit_code: processExitCode,
    signal,
    completed_at: new Date().toISOString(),
  };
}

async function persist(file: string, result: ExitStatus): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

main().catch((error) => {
  process.stderr.write(`Harbor supervisor failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
