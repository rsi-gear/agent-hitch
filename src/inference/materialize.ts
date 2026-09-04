import { chmod, link, lstat, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { LocalModelManifestV1 } from "../domain/index.js";
import { HitchError, ensureDir, statePaths } from "../foundation/index.js";
import { verifyLocalModel } from "./model-store.js";

export async function materializeLocalModel(root: string, manifest: LocalModelManifestV1): Promise<string> {
  await verifyLocalModel(root, manifest);
  const paths = statePaths(root);
  const target = path.join(paths.inferenceCache, "models", manifest.model_id.slice("sha256:".length));
  if (await validMaterialization(target, manifest, paths.modelFiles)) return target;
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporary, { recursive: true, force: true });
  await ensureDir(temporary);
  try {
    for (const file of manifest.files) {
      const destination = path.join(temporary, ...file.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await link(path.join(paths.modelFiles, file.sha256.slice("sha256:".length)), destination);
      await chmod(destination, 0o444);
    }
    await ensureDir(path.dirname(target));
    try {
      await rename(temporary, target);
      await chmodDirectories(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
      await rm(temporary, { recursive: true, force: true });
    }
    if (!await validMaterialization(target, manifest, paths.modelFiles)) {
      throw new HitchError("materialized model failed integrity validation", { code: "local_model_integrity_failed", exitCode: 5 });
    }
    return target;
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

async function validMaterialization(directory: string, manifest: LocalModelManifestV1, modelFiles: string): Promise<boolean> {
  try {
    const directoryStat = await stat(directory);
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o222) !== 0) return false;
    for (const file of manifest.files) {
      const candidate = path.join(directory, ...file.path.split("/"));
      const observed = await lstat(candidate);
      const stored = await lstat(path.join(modelFiles, file.sha256.slice("sha256:".length)));
      if (!observed.isFile() || observed.isSymbolicLink() || observed.size !== file.size
        || observed.dev !== stored.dev || observed.ino !== stored.ino) return false;
    }
    return true;
  } catch { return false; }
}

async function chmodDirectories(root: string): Promise<void> {
  const entries = await import("node:fs/promises").then(({ readdir }) => readdir(root, { withFileTypes: true }));
  for (const entry of entries) if (entry.isDirectory()) await chmodDirectories(path.join(root, entry.name));
  await chmod(root, 0o555);
}
