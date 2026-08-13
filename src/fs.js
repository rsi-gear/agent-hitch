import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function readJSON(file, fallback = undefined) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

export async function atomicWriteJSON(file, value, mode = 0o600) {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, file);
}

export async function appendLine(file, value) {
  await ensureDir(path.dirname(file));
  const handle = await open(file, "a", 0o600);
  try {
    await handle.write(`${value}\n`);
  } finally {
    await handle.close();
  }
}

export async function removeIfExists(file) {
  await rm(file, { force: true });
}

export async function writePrivateFile(file, value) {
  await ensureDir(path.dirname(file));
  await writeFile(file, value, { mode: 0o600 });
}
