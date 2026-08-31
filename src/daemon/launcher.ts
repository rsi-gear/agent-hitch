import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { ensureDir, statePaths } from "../foundation/index.js";
import type { ResourceVectorV1 } from "../domain/index.js";

export interface DaemonResourcePolicy {
  capacity: ResourceVectorV1;
  run: ResourceVectorV1;
  eval_trial: ResourceVectorV1;
}

export interface DetachedDaemonOptions {
  root: string;
  executable: string;
  port: number;
  maxConcurrent: number;
  resourcePolicy: DaemonResourcePolicy;
}

export async function startDetachedDaemon(options: DetachedDaemonOptions): Promise<{ pid: number | undefined; errorLog: string }> {
  const { root, executable, port, maxConcurrent, resourcePolicy } = options;
  const capacityMemoryMib = bytesToMib(resourcePolicy.capacity.memory_bytes);
  const runMemoryMib = bytesToMib(resourcePolicy.run.memory_bytes);
  const evalMemoryMib = bytesToMib(resourcePolicy.eval_trial.memory_bytes);
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
    "--capacity-cpu-millis", String(resourcePolicy.capacity.cpu_millis),
    "--capacity-memory-mib", String(capacityMemoryMib),
    "--container-slots", String(resourcePolicy.capacity.container_slots),
    "--build-slots", String(resourcePolicy.capacity.build_slots),
    "--run-cpu-millis", String(resourcePolicy.run.cpu_millis),
    "--run-memory-mib", String(runMemoryMib),
    "--eval-cpu-millis", String(resourcePolicy.eval_trial.cpu_millis),
    "--eval-memory-mib", String(evalMemoryMib),
  ], {
    detached: true,
    stdio: ["ignore", stdout, stderr],
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid, errorLog: paths.errorLog };
}

function bytesToMib(value: number): number {
  const result = value / (1024 * 1024);
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError("detached daemon memory policy must be a positive whole number of MiB");
  return result;
}
