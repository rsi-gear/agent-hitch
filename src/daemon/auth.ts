import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { open, readFile, rm } from "node:fs/promises";
import { HitchError, SCHEMA_VERSION, reclaimStaleLock, writePrivateFile } from "../foundation/index.js";

export async function acquireInstanceLock(file: string, instanceId: string): Promise<void> {
  const owner = {
    schema_version: SCHEMA_VERSION,
    instance_id: instanceId,
    pid: process.pid,
    created_at: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      let existing: { pid?: unknown } | null;
      try {
        existing = JSON.parse(await readFile(file, "utf8")) as { pid?: unknown };
      } catch (readError) {
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        throw new HitchError("daemon lock exists but its owner record is unreadable", { code: "daemon_lock_invalid", exitCode: 12, cause: readError });
      }
      if (processIsAlive(existing.pid)) {
        throw new HitchError(`another daemon owns this root (pid ${existing.pid})`, { code: "already_running", exitCode: 2 });
      }
      const reclaimed = await reclaimStaleLock(file, async (candidate) => {
        let current: { pid?: unknown } | null;
        try {
          current = JSON.parse(await readFile(candidate, "utf8")) as { pid?: unknown };
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException)?.code === "ENOENT") return false;
          // A new owner can create the lock before writing its JSON, after
          // our stale-owner observation. Retry through the acquisition loop;
          // only a persistently unreadable record is an invalid lock.
          if (readError instanceof SyntaxError) return false;
          throw new HitchError("daemon lock exists but its owner record is unreadable", {
            code: "daemon_lock_invalid",
            exitCode: 12,
            cause: readError,
          });
        }
        return !processIsAlive(current.pid);
      });
      if (!reclaimed) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new HitchError("could not acquire daemon root lock", { code: "daemon_lock_failed", exitCode: 12 });
}

export async function releaseInstanceLock(file: string, instanceId: string): Promise<void> {
  let owner: { instance_id?: unknown };
  try {
    owner = JSON.parse(await readFile(file, "utf8")) as { instance_id?: unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    return;
  }
  if (owner.instance_id === instanceId) await rm(file, { force: true });
}

function processIsAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export async function ensureToken(file: string): Promise<string> {
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("hex");
  await writePrivateFile(file, `${token}\n`);
  return token;
}

export function authorized(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization || "";
  if (!value.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
