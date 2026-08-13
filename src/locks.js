import { randomBytes } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";

// Serializes stale-lock reclamation so an observation about an old owner can
// never be used to remove a lock that a new owner has just acquired.
export async function reclaimStaleLock(file, isStale) {
  const guard = `${file}.reclaim`;
  const owner = randomBytes(12).toString("hex");
  let handle;
  try {
    handle = await open(guard, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") return false;
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
    let current;
    try {
      current = JSON.parse(await readFile(guard, "utf8"));
    } catch {
      current = null;
    }
    if (current?.owner === owner) await rm(guard, { force: true });
  }
}
