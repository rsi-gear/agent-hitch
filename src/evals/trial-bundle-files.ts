import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { readJSON } from "../foundation/index.js";
export async function findRunBundle(root: string, depth = 0, requireCompleteMarker = false): Promise<string | null> {
  if (depth > 5) return null;
  try {
    const manifest = path.join(root, "manifest.json");
    if ((await lstat(manifest)).isFile() && path.basename(root) === "hitch-run-bundle") {
      if (!requireCompleteMarker) return root;
      const marker = await readJSON<Record<string, unknown> | null>(path.join(root, "bundle.complete.json"), null).catch(() => null);
      return marker?.schema_version === "1" && typeof marker.run_id === "string" ? root : null;
    }
  } catch { /* Continue scanning. */ }
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const found = await findRunBundle(path.join(root, entry.name), depth + 1, requireCompleteMarker);
    if (found) return found;
  }
  return null;
}

export async function validateBundleTree(root: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error(`run bundle contains a symbolic link: ${path.relative(root, target)}`);
      if (info.isDirectory()) {
        await walk(target);
      } else if (info.isFile()) {
        files += 1;
        bytes += info.size;
        if (files > 100_000 || bytes > 1024 * 1024 * 1024) throw new Error("run bundle exceeds import limits");
      } else {
        throw new Error(`run bundle contains a special file: ${path.relative(root, target)}`);
      }
    }
  };
  await walk(root);
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function withoutKeys(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result = { ...record };
  for (const key of keys) delete result[key];
  return result;
}

export async function validateJSONLines(file: string): Promise<void> {
  const content = await readFile(file, "utf8");
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line) continue;
    try { JSON.parse(line); } catch (error) {
      throw new Error(`invalid JSONL at ${path.basename(file)}:${index + 1}: ${(error as Error).message}`);
    }
  }
}
