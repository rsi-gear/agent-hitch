import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { HitchError, invalidInput } from "../foundation/index.js";

export function assertNoWorkspaceOverlap(source: string, managedDirectory: string): void {
  const sourcePath = path.resolve(source);
  const managedPath = path.resolve(managedDirectory);
  if (isWithin(sourcePath, managedPath) || isWithin(managedPath, sourcePath)) {
    throw new HitchError(
      "managed workspace storage overlaps the source workspace; use a Hitch --root outside the source repository",
      { code: "workspace_root_overlap", exitCode: 2 },
    );
  }
}

export function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

export async function canonicalizePotentialPath(file: string): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(file);
  for (;;) {
    try {
      const resolved = await realpath(current);
      return path.join(resolved, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function assertRunId(runId: string): void {
  if (!/^run_[a-f0-9]{32}$/.test(runId || "")) throw invalidInput(`invalid run ID: ${runId || ""}`);
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError();
}

export function cancelledError(): HitchError {
  return new HitchError("workspace preparation cancelled", { code: "cancelled", exitCode: 9 });
}
