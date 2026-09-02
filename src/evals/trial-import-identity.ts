import path from "node:path";
import { readJSON } from "../foundation/index.js";

export async function lockedHarborTaskId(trialDirectory: string): Promise<string | null> {
  const lockPath = path.join(trialDirectory, "lock.json");
  let lock: unknown;
  try {
    lock = await readJSON(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Harbor trial lock is unreadable: ${lockPath}`, { cause: error });
  }
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) throw new Error(`Harbor trial lock is invalid: ${lockPath}`);
  const task = (lock as Record<string, unknown>).task;
  if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error(`Harbor trial lock has no task.name: ${lockPath}`);
  const taskId = nonEmptyString((task as Record<string, unknown>).name);
  if (!taskId) throw new Error(`Harbor trial lock has no task.name: ${lockPath}`);
  return taskId;
}

export function trialAttemptFromId(trialId: string): number {
  const value = Number(trialId.match(/__(\d+)$/)?.[1]);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
