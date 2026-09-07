import { statfs } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../foundation/index.js";
import type { CommandResult } from "../foundation/index.js";

/** Supply optional resource dimensions for the automatically started daemon.
 * Explicit user limits, including zero, always take precedence. */
export async function localInferenceDaemonEnvironment(root: string, env: NodeJS.ProcessEnv = process.env, options: {
  run?: (executable: string, args: string[]) => Promise<CommandResult>;
  freeDiskBytes?: (directory: string) => Promise<number>;
} = {}): Promise<NodeJS.ProcessEnv> {
  const result = { ...env };
  if (result.HITCH_CAPACITY_EPHEMERAL_DISK_MIB === undefined) {
    const bytes = await (options.freeDiskBytes ?? availableDiskBytes)(root);
    result.HITCH_CAPACITY_EPHEMERAL_DISK_MIB = String(Math.floor(bytes / 1024 ** 2));
  }
  if (result.HITCH_CAPACITY_GPUS === undefined) {
    try {
      const invoke = options.run ?? ((executable: string, args: string[]) => runCommand(executable, args, {
        env, timeoutMs: 5_000, failureCode: "gpu_detection_failed",
      }));
      const observed = await invoke(env.HITCH_NVIDIA_SMI_PATH || "nvidia-smi", ["-L"]);
      const count = observed.stdout.split(/\r?\n/).filter((line) => /^GPU \d+:/.test(line)).length;
      if (count > 0) result.HITCH_CAPACITY_GPUS = String(count);
    } catch { /* CPU-only daemon capacity remains valid. */ }
  }
  return result;
}

async function availableDiskBytes(directory: string): Promise<number> {
  let current = path.resolve(directory);
  for (;;) {
    try {
      const info = await statfs(current, { bigint: true });
      return Number(info.bavail * info.bsize);
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) throw error;
      current = parent;
    }
  }
}
