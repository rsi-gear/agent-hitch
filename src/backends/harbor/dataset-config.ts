import { stat } from "node:fs/promises";
import path from "node:path";
import { invalidInput } from "../../foundation/index.js";

/** Build one Harbor dataset selector, optionally narrowed to exact task names. */
export async function harborDatasetConfig(
  value: string,
  taskNames?: readonly string[],
): Promise<Record<string, unknown>> {
  if (typeof value !== "string" || !value.trim()) throw invalidInput("dataset must be a non-empty string");
  if (taskNames !== undefined && (taskNames.length === 0
    || taskNames.some((task) => typeof task !== "string" || task.length === 0)
    || new Set(taskNames).size !== taskNames.length)) {
    throw invalidInput("Harbor task names must be a non-empty unique list");
  }
  const selection = taskNames === undefined ? {} : { task_names: [...taskNames] };
  const raw = value.trim();
  const localPath = path.resolve(raw);
  try {
    if ((await stat(localPath)).isDirectory()) return { path: localPath, ...selection };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const separator = raw.lastIndexOf("@");
  const name = separator > 0 ? raw.slice(0, separator) : raw;
  const version = separator > 0 ? raw.slice(separator + 1) : "";
  if (!name) throw invalidInput(`invalid Harbor dataset: ${value}`);
  return name.includes("/")
    ? { name, ref: version || "latest", ...selection }
    : compact({ name, version: version || undefined, ...selection });
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}
