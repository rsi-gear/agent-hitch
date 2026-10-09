import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { verifyPreparedArtifact } from "../artifacts/index.js";
import type { HarborPreparedArtifactUse } from "../backends/index.js";
import { useControllerRuntimeDirectory } from "../controller-runtime/index.js";
import type { ControllerRuntimeUseResult } from "../controller-runtime/index.js";
import { digest, ensureDir, invalidInput } from "../foundation/index.js";

/** Transport is opt-in: a harness must keep its installation tree read-only.
 * Snapshots are evaluation-local and retained with its jobs, so cancellation,
 * recovery, and other evaluations cannot delete a live task's source files.
 * Never hard-link the mutable host cache or reuse a path/mtime verification.
 */
export class SharedRuntimeSnapshots {
  private controllerDirectory: Promise<string> | undefined;
  private readonly artifacts = new Map<string, Promise<string>>();

  constructor(
    private readonly directory: string | undefined,
    private readonly controller: ControllerRuntimeUseResult,
    private readonly transport: string | undefined,
  ) {
    if (transport !== undefined && !["upload", "readonly-bind"].includes(transport)) {
      throw invalidInput("HITCH_HARBOR_RUNTIME_TRANSPORT must be upload or readonly-bind");
    }
    if (transport === "readonly-bind" && (!directory || process.platform !== "linux")) {
      throw invalidInput("readonly-bind runtime transport requires a local Linux Docker evaluation");
    }
  }

  async prepare(artifact: HarborPreparedArtifactUse, signal?: AbortSignal): Promise<HarborPreparedArtifactUse> {
    if (this.transport !== "readonly-bind") return artifact;
    if (!/^linux-(x64|arm64)$/.test(artifact.platform)) {
      throw invalidInput("readonly-bind runtime transport requires a Linux task runtime");
    }
    signal?.throwIfAborted();
    const base = await ensureDir(this.directory!);
    if (!this.controllerDirectory) {
      this.controllerDirectory = snapshot(base, "controller", this.controller.directory, async (directory) => {
        await useControllerRuntimeDirectory(directory, this.controller.runtime_id);
      }, signal);
    }
    const runtimeDirectory = await this.controllerDirectory;
    const { directory: _source, sharedRuntime: _transport, storage: _storage, ...identity } = artifact;
    const key = digest(identity);
    if (!this.artifacts.has(key)) {
      this.artifacts.set(key, snapshot(base, "artifact", artifact.directory, async (directory) => {
        await verifyPreparedArtifact(directory, artifact);
      }, signal));
    }
    const artifactDirectory = await this.artifacts.get(key)!;
    return {
      ...artifact,
      sharedRuntime: { runtime_directory: runtimeDirectory, artifact_directory: artifactDirectory },
    };
  }
}

async function snapshot(
  base: string,
  label: string,
  source: string,
  verify: (directory: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<string> {
  if (!(await lstat(source)).isDirectory()) {
    throw invalidInput("shared runtime snapshot source must be a regular directory");
  }
  const staging = await mkdtemp(path.join(base, `.${label}-`));
  const payload = path.join(staging, "payload");
  const ready = path.join(base, path.basename(staging).slice(1));
  try {
    await copyInstallation(source, payload, signal);
    signal?.throwIfAborted();
    await verify(payload);
    signal?.throwIfAborted();
    // Rename the writable staging wrapper: moving a 0555 payload directory
    // between parents requires write access to its own '..' entry on Linux.
    await rename(staging, ready);
    return path.join(ready, "payload");
  } catch (error) {
    // Keep the validation/cancellation error even if cleanup also fails.
    await removeStaging(staging).catch(() => undefined);
    throw error;
  }
}

async function copyInstallation(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const info = await lstat(source);
  if (info.isDirectory()) {
    // Source bundles can be 0555. Apply their modes only after populating
    // children, independent of the caller's umask. Never follow symlinks.
    await mkdir(destination, { mode: 0o700 });
    for (const name of await readdir(source)) {
      await copyInstallation(path.join(source, name), path.join(destination, name), signal);
    }
    await chmod(destination, info.mode & 0o7777);
  } else if (info.isFile()) {
    // Reflink when supported; copy otherwise. Neither aliases mutable cache
    // inodes. Preserve exact modes because artifact integrity includes them.
    await copyFile(source, destination, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    await chmod(destination, info.mode & 0o7777);
  } else if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
  } else {
    throw invalidInput("unsupported special file in shared runtime installation");
  }
}

async function removeStaging(directory: string): Promise<void> {
  // Only directories need write permission for unlinking. In particular,
  // never chmod a symlink's target outside this private staging tree.
  await chmod(directory, 0o700);
  for (const name of await readdir(directory)) {
    const child = path.join(directory, name);
    if ((await lstat(child)).isDirectory()) await removeStaging(child);
  }
  await rm(directory, { recursive: true, force: true });
}
