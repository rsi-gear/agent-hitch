import { randomBytes } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { HitchError } from "./errors.js";
import { delay } from "./process.js";
import { ensureDir, readJSON, removeIfExists } from "./fs.js";

// Serializes stale-lock reclamation so an observation about an old owner can
// never be used to remove a lock that a new owner has just acquired.
export async function reclaimStaleLock(file: string, isStale: (file: string) => Promise<boolean>): Promise<boolean> {
  const guard = `${file}.reclaim`;
  const owner = randomBytes(12).toString("hex");
  let handle;
  try {
    handle = await open(guard, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw error;
  }

  try {
    await handle.writeFile(`${JSON.stringify({ owner, pid: process.pid, created_at: new Date().toISOString() })}\n`);
    await handle.sync();
    if (!await isStale(file)) return false;
    await rm(file, { force: true });
    return true;
  } finally {
    await handle.close().catch(() => {});
    let current: { owner?: unknown } | null;
    try {
      current = JSON.parse(await readFile(guard, "utf8")) as { owner?: unknown };
    } catch {
      current = null;
    }
    if (current?.owner === owner) await rm(guard, { force: true });
  }
}

export interface FileLockOptions {
  timeoutCode?: string;
  timeoutExitCode?: number;
  signal?: AbortSignal | undefined;
}

export async function withFileLock<T>(
  directory: string,
  key: string,
  operation: () => Promise<T>,
  { timeoutCode = "prepare_locked", timeoutExitCode = 5, signal }: FileLockOptions = {},
): Promise<T> {
  await ensureDir(directory);
  const file = path.join(directory, `${key.replace("sha256:", "")}.lock`);
  const owner = randomBytes(12).toString("hex");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    if (signal?.aborted) throw cancelledError();
    try {
      handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ owner, pid: process.pid, created_at: new Date().toISOString() })}\n`);
      } catch (error) {
        await handle.close().catch(() => {});
        handle = undefined;
        await removeIfExists(file);
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      if (await staleLock(file)) {
        if (!await reclaimStaleLock(file, staleLock)) await delay(100);
        continue;
      }
      await delay(100);
    }
  }
  if (!handle) throw new HitchError("timed out waiting for Hitch state lock", { code: timeoutCode, exitCode: timeoutExitCode });
  try {
    if (signal?.aborted) throw cancelledError();
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    const current = await readJSON<{ owner?: unknown } | null>(file, null).catch(() => null);
    if (current?.owner === owner) await removeIfExists(file);
  }
}

async function staleLock(file: string): Promise<boolean> {
  let lock: { pid?: unknown } | null;
  try {
    lock = await readJSON<{ pid?: unknown }>(file);
  } catch {
    try { return Date.now() - (await stat(file)).mtimeMs > 2_000; } catch { return true; }
  }
  if (!Number.isInteger(lock?.pid)) return true;
  try {
    process.kill(lock.pid as number, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

function cancelledError(): HitchError {
  return new HitchError("operation cancelled", { code: "cancelled", exitCode: 9 });
}
