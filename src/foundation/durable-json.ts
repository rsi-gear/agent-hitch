import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

/** An acknowledged resource root/lease must survive a machine crash, not only a process exit. */
export async function durableWriteJSON(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file); await mkdir(directory, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file); await syncDirectory(directory);
  } finally { await rm(temporary, { force: true }); }
}
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); }
}
