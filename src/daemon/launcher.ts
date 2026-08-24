import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { ensureDir, statePaths } from "../foundation/index.js";

export interface DetachedDaemonOptions {
  root: string;
  executable: string;
  port: number;
  maxConcurrent: number;
}

export async function startDetachedDaemon(options: DetachedDaemonOptions): Promise<{ pid: number | undefined; errorLog: string }> {
  const { root, executable, port, maxConcurrent } = options;
  const paths = statePaths(root);
  await ensureDir(root);
  const stdout = openSync(paths.log, "a", 0o600);
  const stderr = openSync(paths.errorLog, "a", 0o600);
  const child = spawn(process.execPath, [
    executable,
    "--root", root,
    "daemon", "serve",
    "--port", String(port),
    "--max-concurrent", String(maxConcurrent),
  ], {
    detached: true,
    stdio: ["ignore", stdout, stderr],
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid, errorLog: paths.errorLog };
}
