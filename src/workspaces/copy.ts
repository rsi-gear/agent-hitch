import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readlink, readdir, rm, symlink, utimes } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { HitchError, ensureDir } from "../foundation/index.js";
import { workspaceDigest } from "./digest.js";
import { runGit } from "./git.js";
import type { WorkspacePlan, WorktreePreparation } from "./types.js";
import { cancelledError, pathExists, throwIfAborted } from "./utils.js";

export async function prepareCopy(plan: WorkspacePlan, { signal }: { signal?: AbortSignal | undefined }): Promise<WorktreePreparation> {
  const excluded: Set<string> = plan.git?.head ? new Set([".git"]) : new Set();
  await assertNoLinkedGitDirectories(plan.source_base, { signal, excludeRootGit: Boolean(plan.git) });
  const git = plan.git;
  if (git?.head) {
    const currentHead = await runGit(["-C", git.repository_root, "rev-parse", "--verify", "HEAD^{commit}"], {
      signal,
      failureCode: "workspace_changed_during_snapshot",
      failureExitCode: 5,
    }).then((result) => result.stdout.trim());
    if (currentHead !== git.head) {
      throw new HitchError("source workspace HEAD changed while the run was queued", {
        code: "workspace_changed_during_snapshot",
        exitCode: 5,
      });
    }
  }
  const beforeDigest = await workspaceDigest(plan.source_base, { signal, excludedTopLevel: excluded });

  if (git?.head) {
    await runGit(["clone", "--no-local", "--no-checkout", git.repository_root, plan.execution_root], {
      signal,
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
      failureCode: "workspace_provision_failed",
      failureExitCode: 5,
    });
    await runGit(["-C", plan.execution_root, "checkout", "--detach", "--force", git.head], {
      signal,
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
      failureCode: "workspace_provision_failed",
      failureExitCode: 5,
    });
    for (const entry of await readdir(plan.execution_root)) {
      if (entry !== ".git") await rm(path.join(plan.execution_root, entry), { recursive: true, force: true });
    }
    await copyDirectoryContents(plan.source_base, plan.execution_root, { signal, excludedTopLevel: excluded });
  } else {
    await mkdir(plan.execution_root, { recursive: true });
    await copyDirectoryContents(plan.source_base, plan.execution_root, { signal });
  }
  await assertNoLinkedGitDirectories(plan.execution_root, { signal, excludeRootGit: Boolean(git) });

  const [afterDigest, copiedDigest, afterHead] = await Promise.all([
    workspaceDigest(plan.source_base, { signal, excludedTopLevel: excluded }),
    workspaceDigest(plan.execution_root, { signal, excludedTopLevel: excluded }),
    git?.head
      ? runGit(["-C", git.repository_root, "rev-parse", "--verify", "HEAD^{commit}"], {
          signal,
          failureCode: "workspace_changed_during_snapshot",
          failureExitCode: 5,
        }).then((result) => result.stdout.trim())
      : null,
  ]);
  if (beforeDigest !== afterDigest || afterDigest !== copiedDigest || (git?.head && afterHead !== git.head)) {
    throw new HitchError("source workspace changed while Hitch was copying it", {
      code: "workspace_changed_during_snapshot",
      exitCode: 5,
    });
  }
  if (!await pathExists(plan.execution_workspace)) {
    throw new HitchError(`copied workspace subdirectory is missing: ${plan.source_subdirectory}`, {
      code: "workspace_subdirectory_missing",
      exitCode: 2,
    });
  }
  // Unborn repositories include .git in the source consistency check but
  // exclude it from the work-tree baseline, so that case needs one fresh hash.
  return { baseline_digest: plan.git && !plan.git.head ? "" : copiedDigest };
}

async function copyDirectoryContents(source: string, destination: string, { signal, excludedTopLevel = new Set<string>() }: { signal?: AbortSignal | undefined; excludedTopLevel?: Set<string> } = {}): Promise<void> {
  await ensureDir(destination);
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    throwIfAborted(signal);
    if (excludedTopLevel.has(entry.name)) continue;
    await copyEntry(path.join(source, entry.name), path.join(destination, entry.name), { signal });
  }
}

async function assertNoLinkedGitDirectories(directory: string, { signal, excludeRootGit }: { signal?: AbortSignal | undefined; excludeRootGit: boolean }): Promise<void> {
  async function visit(current: string, depth: number): Promise<void> {
    throwIfAborted(signal);
    for (const name of await readdir(current)) {
      if (depth === 0 && excludeRootGit && name === ".git") continue;
      const child = path.join(current, name);
      const info = await lstat(child);
      if (name === ".git" && !info.isDirectory()) {
        throw new HitchError(`copy isolation does not yet support linked nested Git workspaces: ${child}`, {
          code: "workspace_nested_git_unsupported",
          exitCode: 10,
        });
      }
      if (info.isDirectory()) await visit(child, depth + 1);
    }
  }
  await visit(directory, 0);
}

async function copyEntry(source: string, destination: string, { signal }: { signal?: AbortSignal | undefined }): Promise<void> {
  throwIfAborted(signal);
  const info = await lstat(source);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: info.mode });
    for (const entry of await readdir(source)) {
      await copyEntry(path.join(source, entry), path.join(destination, entry), { signal });
    }
    await chmod(destination, info.mode);
    await utimes(destination, info.atime, info.mtime);
    return;
  }
  if (info.isFile()) {
    try {
      await pipeline(
        createReadStream(source),
        createWriteStream(destination, { mode: info.mode }),
        { signal },
      );
    } catch (error) {
      if (signal?.aborted) throw cancelledError();
      throw error;
    }
    await chmod(destination, info.mode);
    await utimes(destination, info.atime, info.mtime);
    return;
  }
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    return;
  }
  throw new HitchError(`unsupported special file in workspace: ${source}`, {
    code: "workspace_special_file",
    exitCode: 5,
  });
}
