import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

export async function ensureDir(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  return directory;
}

/**
 * Reads a JSON document. External JSON enters as `unknown`; callers narrow
 * through runtime validators before use (spec §8.2).
 */
export async function readJSON<T = unknown>(file: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

export async function atomicWriteJSON(file: string, value: unknown, mode = 0o600): Promise<void> {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, file);
}

export async function appendLine(file: string, value: string): Promise<void> {
  await ensureDir(path.dirname(file));
  const handle = await open(file, "a", 0o600);
  try {
    await handle.write(`${value}\n`);
  } finally {
    await handle.close();
  }
}

export async function removeIfExists(file: string): Promise<void> {
  await rm(file, { force: true });
}

export async function writePrivateFile(file: string, value: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await writeFile(file, value, { mode: 0o600 });
}
