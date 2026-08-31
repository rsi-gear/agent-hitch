import { spawn } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";

interface ExitStatus {
  schema_version: "1";
  process_exit_code: number | null;
  signal: NodeJS.Signals | null;
  completed_at: string;
}

async function main(): Promise<void> {
  const [, , statusPath, executable, ...args] = process.argv;
  if (!statusPath || !executable) {
    process.stderr.write("Harbor supervisor requires status path and executable\n");
    process.exitCode = 2;
    return;
  }
  const result = await supervise(executable, args);
  await persist(statusPath, result);
  process.exitCode = result.process_exit_code === null ? 1 : Math.max(0, Math.min(255, result.process_exit_code));
}

function supervise(executable: string, args: string[]): Promise<ExitStatus> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    let settled = false;
    child.once("error", () => {
      if (settled) return;
      settled = true;
      resolve(status(127, null));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      resolve(status(code, signal));
    });
  });
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
