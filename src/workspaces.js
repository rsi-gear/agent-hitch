import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { statePaths, SCHEMA_VERSION } from "./config.js";
import { HitchError, invalidInput } from "./errors.js";
import { atomicWriteJSON, ensureDir, readJSON, removeIfExists } from "./fs.js";
import { delay, terminateProcess } from "./process.js";
import { reclaimStaleLock } from "./locks.js";

export const WORKSPACE_MODES = new Set(["shared", "worktree", "copy"]);

const COMMAND_TIMEOUT_MS = 120_000;
const ACTIVE_WORKSPACE_STATES = new Set(["planned", "provisioning", "ready", "running"]);

export async function planWorkspace({ runId, sourceCwd, mode = "shared", root, recordPath }) {
  assertRunId(runId);
  if (!WORKSPACE_MODES.has(mode)) {
    throw invalidInput(`workspace_mode must be one of: ${[...WORKSPACE_MODES].join(", ")}`);
  }

  let sourceRealPath;
  let sourceInfo;
  try {
    sourceRealPath = await realpath(sourceCwd);
    sourceInfo = await stat(sourceRealPath);
  } catch (error) {
    throw invalidInput(`workspace does not exist: ${sourceCwd}`, { cause: error });
  }
  if (!sourceInfo.isDirectory()) throw invalidInput(`workspace is not a directory: ${sourceCwd}`);

  const paths = statePaths(root);
  const managedDirectory = path.join(await canonicalizePotentialPath(paths.workspaces), runId);
  let git = null;
  let sourceBase = sourceRealPath;
  let sourceSubdirectory = ".";

  if (mode !== "shared") {
    git = await inspectGitWorkspace(sourceRealPath, { required: mode === "worktree" });
    if (git) {
      sourceBase = git.repository_root;
      sourceSubdirectory = path.relative(sourceBase, sourceRealPath) || ".";
    }
    const stateRoot = await canonicalizePotentialPath(paths.root);
    if (isWithin(sourceBase, stateRoot)) {
      throw new HitchError(
        "the Hitch state root is inside the source workspace; use a --root outside the source repository",
        { code: "workspace_root_overlap", exitCode: 2 },
      );
    }
    assertNoWorkspaceOverlap(sourceBase, managedDirectory);
  }

  if (mode === "worktree") {
    if (git.status) {
      throw new HitchError(
        "worktree isolation requires a clean Git workspace; use workspace_mode=copy to preserve local changes",
        { code: "workspace_dirty", exitCode: 2 },
      );
    }
  }

  const executionRoot = mode === "shared" ? sourceRealPath : path.join(managedDirectory, "root");
  const executionWorkspace = sourceSubdirectory === "."
    ? executionRoot
    : path.join(executionRoot, sourceSubdirectory);
  const snapshot = mode === "worktree"
    ? { consistency: "git_commit", commit: git.head, source_subdirectory: sourceSubdirectory }
    : mode === "copy"
      ? {
          consistency: "best_effort",
          ...(git?.head ? { commit: git.head } : {}),
          source_subdirectory: sourceSubdirectory,
        }
      : { consistency: "none", source_subdirectory: "." };

  const plan = {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    state_root: path.resolve(root),
    mode,
    status: "planned",
    source_workspace: path.resolve(sourceCwd),
    source_realpath: sourceRealPath,
    source_base: sourceBase,
    source_subdirectory: sourceSubdirectory,
    execution_root: executionRoot,
    execution_workspace: executionWorkspace,
    managed_directory: mode === "shared" ? null : managedDirectory,
    snapshot,
    git,
    retained: false,
    planned_at: new Date().toISOString(),
  };
  if (recordPath) await atomicWriteJSON(recordPath, plan);
  return plan;
}

export async function prepareWorkspace(plan, { recordPath, signal } = {}) {
  if (plan.mode === "shared") {
    const ready = {
      ...plan,
      status: "ready",
      prepared_at: new Date().toISOString(),
    };
    if (recordPath) await atomicWriteJSON(recordPath, ready);
    return ready;
  }

  const provisioning = { ...plan, status: "provisioning", provisioning_at: new Date().toISOString() };
  if (recordPath) await atomicWriteJSON(recordPath, provisioning);
  let ownsManagedDirectory = false;

  try {
    throwIfAborted(signal);
    await assertManagedPlan(plan);
    await mkdir(path.dirname(plan.managed_directory), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(plan.managed_directory), 0o700);
    if (await pathExists(plan.managed_directory)) {
      throw new HitchError(`managed workspace already exists for ${plan.run_id}`, {
        code: "workspace_already_exists",
        exitCode: 11,
      });
    }
    await mkdir(plan.managed_directory, { mode: 0o700 });
    ownsManagedDirectory = true;
    const preparation = plan.mode === "worktree"
      ? await prepareWorktree(plan, { signal })
      : await prepareCopy(plan, { signal });
    await chmod(plan.managed_directory, 0o700);
    await chmod(plan.execution_root, 0o700);
    const baselineDigest = preparation?.baseline_digest || await workspaceDigest(plan.execution_root, {
      signal,
      excludedTopLevel: gitMetadataExclusion(plan),
    });
    const baselineGitMetadataDigest = plan.mode === "copy" && plan.git
      ? await isolatedGitMetadataDigest(plan.execution_root, { signal })
      : null;
    const preparedAt = new Date().toISOString();
    const ready = {
      ...provisioning,
      status: "ready",
      baseline_digest: baselineDigest,
      baseline_git_metadata_digest: baselineGitMetadataDigest,
      snapshot: { ...plan.snapshot, content_digest: baselineDigest, captured_at: preparedAt },
      retained: true,
      prepared_at: preparedAt,
    };
    if (recordPath) await atomicWriteJSON(recordPath, ready);
    return ready;
  } catch (error) {
    if (ownsManagedDirectory) await cleanupProvisioning(plan).catch(() => {});
    const workspaceError = error?.code === "EEXIST"
      ? new HitchError(`managed workspace already exists for ${plan.run_id}`, {
          code: "workspace_already_exists",
          exitCode: 11,
          cause: error,
        })
      : error;
    const failed = {
      ...provisioning,
      status: workspaceError?.code === "cancelled" ? "cancelled" : "failed",
      retained: false,
      error: { code: workspaceError?.code || "workspace_provision_failed", message: workspaceError?.message || String(workspaceError) },
      completed_at: new Date().toISOString(),
    };
    if (recordPath) await atomicWriteJSON(recordPath, failed);
    if (workspaceError instanceof HitchError) throw workspaceError;
    throw new HitchError(`failed to provision isolated workspace: ${workspaceError.message}`, {
      code: "workspace_provision_failed",
      exitCode: 5,
      cause: workspaceError,
    });
  }
}

export async function markWorkspaceRunning(workspace, { recordPath } = {}) {
  const running = { ...workspace, status: "running", started_at: new Date().toISOString() };
  if (recordPath) await atomicWriteJSON(recordPath, running);
  return running;
}

export async function finalizeWorkspace(workspace, { recordPath } = {}) {
  if (!workspace) return null;
  if (workspace.mode === "shared") {
    const released = {
      ...workspace,
      status: "released",
      retained: false,
      changed: null,
      finalized_at: new Date().toISOString(),
    };
    if (recordPath) await atomicWriteJSON(recordPath, released);
    return released;
  }

  const finalDigest = await workspaceDigest(workspace.execution_root, {
    excludedTopLevel: gitMetadataExclusion(workspace),
  });
  let headAfter = null;
  let gitStatus = null;
  let finalGitMetadataDigest = null;
  if (workspace.git) {
    headAfter = await tryGitOutput(["-C", workspace.execution_root, "rev-parse", "--verify", "HEAD^{commit}"]);
    gitStatus = await tryGitOutput(["-C", workspace.execution_root, "status", "--porcelain=v1", "--untracked-files=all"]);
    if (workspace.mode === "copy") finalGitMetadataDigest = await isolatedGitMetadataDigest(workspace.execution_root);
  }
  const gitStateChanged = workspace.git
    ? gitStatus === null
      || (workspace.git.head ? !headAfter || headAfter !== workspace.git.head : Boolean(headAfter))
      || (workspace.mode === "copy" && finalGitMetadataDigest !== workspace.baseline_git_metadata_digest)
    : false;
  const retained = {
    ...workspace,
    status: "retained",
    retained: true,
    changed: finalDigest !== workspace.baseline_digest || gitStateChanged,
    final_digest: finalDigest,
    ...(finalGitMetadataDigest ? { final_git_metadata_digest: finalGitMetadataDigest } : {}),
    ...(headAfter ? { head_after: headAfter } : {}),
    ...(gitStatus !== null ? { git_dirty: Boolean(gitStatus) } : {}),
    finalized_at: new Date().toISOString(),
  };
  if (recordPath) await atomicWriteJSON(recordPath, retained);
  return retained;
}

export async function markWorkspaceFinalizationFailed(workspace, { recordPath, warning } = {}) {
  if (!workspace) return null;
  const terminal = {
    ...workspace,
    status: workspace.mode === "shared" ? "released" : "orphaned",
    retained: workspace.mode !== "shared",
    changed: null,
    warning: warning || {
      code: "workspace_finalization_failed",
      message: "workspace finalization failed",
    },
    finalized_at: new Date().toISOString(),
  };
  if (recordPath) await atomicWriteJSON(recordPath, terminal);
  return terminal;
}

export async function cancelPlannedWorkspace({ root, runId }) {
  return abandonPlannedWorkspace({ root, runId, status: "cancelled" });
}

export async function abandonPlannedWorkspace({ root, runId, status = "unused" }) {
  const recordPath = workspaceRecordPath(root, runId);
  const workspace = await readJSON(recordPath, null);
  if (!workspace || workspace.status !== "planned") return workspace;
  const completed = { ...workspace, status, completed_at: new Date().toISOString() };
  await atomicWriteJSON(recordPath, completed);
  return completed;
}

export async function recoverInterruptedWorkspace({ root, runId }) {
  const recordPath = workspaceRecordPath(root, runId);
  const workspace = await readJSON(recordPath, null);
  if (!workspace) return null;
  if (workspace.status === "provisioning") {
    await cleanupProvisioning(workspace).catch(() => {});
    const failed = {
      ...workspace,
      status: "failed",
      retained: false,
      error: { code: "daemon_restarted", message: "daemon stopped while provisioning the workspace" },
      completed_at: new Date().toISOString(),
    };
    await atomicWriteJSON(recordPath, failed);
    return failed;
  }
  if (["ready", "running"].includes(workspace.status)) {
    const orphaned = {
      ...workspace,
      status: workspace.mode === "shared" ? "released" : "orphaned",
      retained: workspace.mode !== "shared",
      completed_at: new Date().toISOString(),
    };
    await atomicWriteJSON(recordPath, orphaned);
    return orphaned;
  }
  if (workspace.status === "planned") return cancelPlannedWorkspace({ root, runId });
  return workspace;
}

export async function inspectWorkspace({ root, runId }) {
  assertRunId(runId);
  return readJSON(workspaceRecordPath(root, runId), null);
}

export async function removeWorkspace({ root, runId, force = false }) {
  assertRunId(runId);
  const recordPath = workspaceRecordPath(root, runId);
  const workspace = await readJSON(recordPath, null);
  if (!workspace) {
    throw new HitchError(`workspace record not found: ${runId}`, { code: "workspace_not_found", exitCode: 3 });
  }
  if (workspace.mode === "shared") {
    throw invalidInput(`run ${runId} used a shared workspace that Hitch does not own`);
  }
  if (ACTIVE_WORKSPACE_STATES.has(workspace.status)) {
    throw new HitchError(`workspace is still in use by ${runId}`, { code: "workspace_in_use", exitCode: 11 });
  }
  if (!force && workspace.changed !== false) {
    throw new HitchError("workspace may contain changes; pass --force to remove it", {
      code: "workspace_has_changes",
      exitCode: 11,
    });
  }

  const expectedDirectory = path.join(await canonicalizePotentialPath(statePaths(root).workspaces), runId);
  const expectedExecutionRoot = path.join(expectedDirectory, "root");
  const recordedDirectory = workspace.managed_directory
    ? await canonicalizePotentialPath(workspace.managed_directory)
    : null;
  const recordedExecutionRoot = workspace.execution_root
    ? await canonicalizePotentialPath(workspace.execution_root)
    : null;
  if (
    !recordedDirectory
    || !recordedExecutionRoot
    || path.resolve(recordedDirectory) !== path.resolve(expectedDirectory)
    || path.resolve(recordedExecutionRoot) !== path.resolve(expectedExecutionRoot)
  ) {
    throw new HitchError("workspace record points outside the managed workspace root", {
      code: "workspace_cleanup_rejected",
      exitCode: 11,
    });
  }

  if (workspace.mode === "worktree" && workspace.git?.common_dir) {
    await withWorkspaceLock(root, workspace.git.common_dir, async () => {
      if (await pathExists(workspace.git.common_dir) && await registeredWorktree(workspace.git.common_dir, workspace.execution_root)) {
        await runGit(["--git-dir", workspace.git.common_dir, "worktree", "remove", "--force", workspace.execution_root], {
          failureCode: "workspace_cleanup_failed",
          failureExitCode: 12,
        });
      }
    });
  }
  await rm(expectedDirectory, { recursive: true, force: true });
  const removed = {
    ...workspace,
    status: "removed",
    retained: false,
    removed_at: new Date().toISOString(),
  };
  await atomicWriteJSON(recordPath, removed);
  return removed;
}

export function workspaceRecordPath(root, runId) {
  return path.join(statePaths(root).runs, runId, "workspace.json");
}

export function workspaceManifestFields(workspace) {
  if (!workspace) return {};
  return {
    workspace_mode: workspace.mode,
    source_workspace: workspace.source_workspace,
    execution_workspace: workspace.execution_workspace,
    workspace_snapshot: workspace.snapshot,
    workspace_retained: Boolean(workspace.retained),
    ...(workspace.changed !== undefined ? { workspace_changed: workspace.changed } : {}),
  };
}

async function prepareWorktree(plan, { signal }) {
  await withWorkspaceLock(plan.state_root, plan.git.common_dir, async () => {
    await runGit([
      "-C",
      plan.git.repository_root,
      "worktree",
      "add",
      "--detach",
      plan.execution_root,
      plan.git.head,
    ], {
      signal,
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
      failureCode: "workspace_provision_failed",
      failureExitCode: 5,
    });
  }, { signal });
  if (!await pathExists(plan.execution_workspace)) {
    throw new HitchError(`workspace subdirectory does not exist at commit ${plan.git.head}: ${plan.source_subdirectory}`, {
      code: "workspace_subdirectory_missing",
      exitCode: 2,
    });
  }
}

async function prepareCopy(plan, { signal }) {
  const excluded = plan.git?.head ? new Set([".git"]) : new Set();
  await assertNoLinkedGitDirectories(plan.source_base, { signal, excludeRootGit: Boolean(plan.git) });
  if (plan.git?.head) {
    const currentHead = await runGit(["-C", plan.git.repository_root, "rev-parse", "--verify", "HEAD^{commit}"], {
      signal,
      failureCode: "workspace_changed_during_snapshot",
      failureExitCode: 5,
    }).then((result) => result.stdout.trim());
    if (currentHead !== plan.git.head) {
      throw new HitchError("source workspace HEAD changed while the run was queued", {
        code: "workspace_changed_during_snapshot",
        exitCode: 5,
      });
    }
  }
  const beforeDigest = await workspaceDigest(plan.source_base, { signal, excludedTopLevel: excluded });

  if (plan.git?.head) {
    await runGit(["clone", "--no-local", "--no-checkout", plan.git.repository_root, plan.execution_root], {
      signal,
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
      failureCode: "workspace_provision_failed",
      failureExitCode: 5,
    });
    await runGit(["-C", plan.execution_root, "checkout", "--detach", "--force", plan.git.head], {
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
  await assertNoLinkedGitDirectories(plan.execution_root, { signal, excludeRootGit: Boolean(plan.git) });

  const [afterDigest, copiedDigest, afterHead] = await Promise.all([
    workspaceDigest(plan.source_base, { signal, excludedTopLevel: excluded }),
    workspaceDigest(plan.execution_root, { signal, excludedTopLevel: excluded }),
    plan.git?.head
      ? runGit(["-C", plan.git.repository_root, "rev-parse", "--verify", "HEAD^{commit}"], {
          signal,
          failureCode: "workspace_changed_during_snapshot",
          failureExitCode: 5,
        }).then((result) => result.stdout.trim())
      : null,
  ]);
  if (beforeDigest !== afterDigest || afterDigest !== copiedDigest || (plan.git?.head && afterHead !== plan.git.head)) {
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
  return { baseline_digest: plan.git && !plan.git.head ? null : copiedDigest };
}

async function inspectGitWorkspace(directory, { required }) {
  const rootOutput = await tryGitOutput(["-C", directory, "rev-parse", "--show-toplevel"]);
  if (rootOutput === null) {
    if (required) {
      throw new HitchError("worktree isolation requires a Git workspace", {
        code: "workspace_not_git",
        exitCode: 2,
      });
    }
    return null;
  }
  const repositoryRoot = await realpath(rootOutput);
  const [head, commonDirOutput, statusOutput] = await Promise.all([
    tryGitOutput(["-C", repositoryRoot, "rev-parse", "--verify", "HEAD^{commit}"]),
    runGit(["-C", repositoryRoot, "rev-parse", "--git-common-dir"], {
      failureCode: "workspace_git_invalid",
      failureExitCode: 2,
    }).then((result) => result.stdout.trim()),
    runGit(["-C", repositoryRoot, "status", "--porcelain=v1", "--untracked-files=all"], {
      failureCode: "workspace_git_invalid",
      failureExitCode: 2,
    }).then((result) => result.stdout.trim()),
  ]);
  if (required && !head) {
    throw new HitchError("worktree isolation requires a Git workspace with at least one commit", {
      code: "workspace_git_no_commit",
      exitCode: 2,
    });
  }
  const commonDir = await realpath(path.resolve(repositoryRoot, commonDirOutput));
  return {
    repository_root: repositoryRoot,
    common_dir: commonDir,
    head,
    status: statusOutput,
  };
}

async function isolatedGitMetadataDigest(directory, { signal } = {}) {
  const [head, statusOutput, refs, config] = await Promise.all([
    runGit(["-C", directory, "rev-parse", "--verify", "HEAD^{commit}"], {
      signal,
      failureCode: "workspace_git_invalid",
      failureExitCode: 12,
    }).then((result) => result.stdout, () => ""),
    runGit(["-C", directory, "status", "--porcelain=v1", "--untracked-files=all"], {
      signal,
      failureCode: "workspace_git_invalid",
      failureExitCode: 12,
    }).then((result) => result.stdout),
    runGit(["-C", directory, "for-each-ref", "--format=%(refname)%00%(objectname)"], {
      signal,
      failureCode: "workspace_git_invalid",
      failureExitCode: 12,
    }).then((result) => result.stdout),
    runGit(["-C", directory, "config", "--local", "--null", "--list"], {
      signal,
      failureCode: "workspace_git_invalid",
      failureExitCode: 12,
    }).then((result) => result.stdout),
  ]);
  return `sha256:${createHash("sha256").update(JSON.stringify({ head, status: statusOutput, refs, config })).digest("hex")}`;
}

async function cleanupProvisioning(workspace) {
  await assertManagedPlan(workspace);
  if (
    workspace.mode === "worktree"
    && workspace.git?.common_dir
    && await pathExists(workspace.git.common_dir)
    && await registeredWorktree(workspace.git.common_dir, workspace.execution_root)
  ) {
    await withWorkspaceLock(workspace.state_root, workspace.git.common_dir, () => runGit([
      "--git-dir",
      workspace.git.common_dir,
      "worktree",
      "remove",
      "--force",
      workspace.execution_root,
    ], {
      failureCode: "workspace_cleanup_failed",
      failureExitCode: 12,
    }), {
      signal: undefined,
    }).catch(() => {});
  }
  if (workspace.managed_directory) await rm(workspace.managed_directory, { recursive: true, force: true });
}

async function registeredWorktree(commonDirectory, candidate) {
  const result = await runGit(["--git-dir", commonDirectory, "worktree", "list", "--porcelain"], {
    failureCode: "workspace_cleanup_failed",
    failureExitCode: 12,
  });
  const candidatePath = await canonicalizePotentialPath(candidate);
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) continue;
    const registeredPath = await canonicalizePotentialPath(line.slice("worktree ".length));
    if (path.resolve(registeredPath) === path.resolve(candidatePath)) return true;
  }
  return false;
}

async function copyDirectoryContents(source, destination, { signal, excludedTopLevel = new Set() } = {}) {
  await ensureDir(destination);
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    throwIfAborted(signal);
    if (excludedTopLevel.has(entry.name)) continue;
    await copyEntry(path.join(source, entry.name), path.join(destination, entry.name), { signal });
  }
}

async function assertNoLinkedGitDirectories(directory, { signal, excludeRootGit }) {
  async function visit(current, depth) {
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

async function copyEntry(source, destination, { signal }) {
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

async function workspaceDigest(directory, { signal, excludedTopLevel = new Set() } = {}) {
  const hash = createHash("sha256");
  await digestDirectory(hash, directory, "", { signal, excludedTopLevel, topLevel: true });
  return `sha256:${hash.digest("hex")}`;
}

async function digestDirectory(hash, directory, relative, { signal, excludedTopLevel, topLevel }) {
  throwIfAborted(signal);
  const entries = await readdir(directory);
  entries.sort();
  for (const name of entries) {
    if (topLevel && excludedTopLevel.has(name)) continue;
    throwIfAborted(signal);
    const absolute = path.join(directory, name);
    const childRelative = relative ? path.join(relative, name) : name;
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      hash.update(`d\0${childRelative}\0${info.mode & 0o7777}\0`);
      await digestDirectory(hash, absolute, childRelative, { signal, excludedTopLevel, topLevel: false });
    } else if (info.isFile()) {
      hash.update(`f\0${childRelative}\0${info.mode & 0o7777}\0${info.size}\0`);
      const stream = createReadStream(absolute);
      for await (const chunk of stream) {
        throwIfAborted(signal);
        hash.update(chunk);
      }
      hash.update("\0");
    } else if (info.isSymbolicLink()) {
      hash.update(`l\0${childRelative}\0${await readlink(absolute)}\0`);
    } else {
      throw new HitchError(`unsupported special file in workspace: ${absolute}`, {
        code: "workspace_special_file",
        exitCode: 5,
      });
    }
  }
}

async function withWorkspaceLock(root, identity, operation, { signal } = {}) {
  const directory = statePaths(root).workspaceLocks;
  await ensureDir(directory);
  const key = createHash("sha256").update(identity).digest("hex");
  const file = path.join(directory, `${key}.lock`);
  const owner = randomBytes(12).toString("hex");
  let handle;
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    throwIfAborted(signal);
    try {
      handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ owner, pid: process.pid, created_at: new Date().toISOString() })}\n`);
      } catch (error) {
        await handle.close().catch(() => {});
        handle = undefined;
        await removeIfExists(file);
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await staleLock(file)) {
        if (!await reclaimStaleLock(file, staleLock)) await delay(100);
        continue;
      }
      await delay(100);
    }
  }
  if (!handle) {
    throw new HitchError("timed out waiting for workspace lock", {
      code: "workspace_locked",
      exitCode: 5,
    });
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    const current = await readJSON(file, null).catch(() => null);
    if (current?.owner === owner) await removeIfExists(file);
  }
}

async function staleLock(file) {
  let lock;
  try {
    lock = JSON.parse(await readFile(file, "utf8"));
  } catch {
    try {
      return Date.now() - (await stat(file)).mtimeMs > 2_000;
    } catch {
      return true;
    }
  }
  if (!Number.isInteger(lock?.pid)) return true;
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

async function runGit(args, options = {}) {
  return runCommand(process.env.HITCH_GIT_PATH?.trim() || "git", args, options);
}

async function tryGitOutput(args) {
  try {
    return (await runGit(args)).stdout.trim();
  } catch {
    return null;
  }
}

async function runCommand(executable, args, {
  env = process.env,
  signal,
  failureCode = "workspace_provision_failed",
  failureExitCode = 5,
  timeoutMs = COMMAND_TIMEOUT_MS,
} = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = false;
    const append = (current, chunk) => `${current}${chunk}`.slice(-1_000_000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      callback();
    };
    const abortHandler = () => {
      aborted = true;
      terminateProcess(child).catch(() => {});
    };
    const timer = setTimeout(() => terminateProcess(child).catch(() => {}), timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", abortHandler, { once: true });
    child.once("error", (error) => finish(() => reject(new HitchError(
      `failed to start ${path.basename(executable)}: ${error.message}`,
      { code: failureCode, exitCode: failureExitCode, cause: error },
    ))));
    child.once("close", (code, processSignal) => {
      if (aborted) return finish(() => reject(cancelledError()));
      if (code === 0) return finish(() => resolve({ stdout, stderr }));
      const detail = stderr.trim() || stdout.trim();
      finish(() => reject(new HitchError(
        `${path.basename(executable)} exited with code ${code ?? "null"}${processSignal ? ` (${processSignal})` : ""}${detail ? `: ${detail}` : ""}`,
        { code: failureCode, exitCode: failureExitCode },
      )));
    });
  });
}

function assertNoWorkspaceOverlap(source, managedDirectory) {
  const sourcePath = path.resolve(source);
  const managedPath = path.resolve(managedDirectory);
  if (isWithin(sourcePath, managedPath) || isWithin(managedPath, sourcePath)) {
    throw new HitchError(
      "managed workspace storage overlaps the source workspace; use a Hitch --root outside the source repository",
      { code: "workspace_root_overlap", exitCode: 2 },
    );
  }
}

async function assertManagedPlan(workspace) {
  assertRunId(workspace.run_id);
  if (!workspace.state_root) {
    throw new HitchError("workspace plan is missing its state root", {
      code: "workspace_cleanup_rejected",
      exitCode: 11,
    });
  }
  const expectedDirectory = path.join(await canonicalizePotentialPath(statePaths(workspace.state_root).workspaces), workspace.run_id);
  const expectedRoot = path.join(expectedDirectory, "root");
  if (
    path.resolve(workspace.managed_directory || "") !== path.resolve(expectedDirectory)
    || path.resolve(workspace.execution_root || "") !== path.resolve(expectedRoot)
    || !isWithin(expectedRoot, path.resolve(workspace.execution_workspace || ""))
  ) {
    throw new HitchError("workspace plan points outside the managed workspace root", {
      code: "workspace_cleanup_rejected",
      exitCode: 11,
    });
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function pathExists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function canonicalizePotentialPath(file) {
  const missing = [];
  let current = path.resolve(file);
  for (;;) {
    try {
      const resolved = await realpath(current);
      return path.join(resolved, ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function assertRunId(runId) {
  if (!/^run_[a-f0-9]{32}$/.test(runId || "")) throw invalidInput(`invalid run ID: ${runId || ""}`);
}

function gitMetadataExclusion(workspace) {
  return workspace.git ? new Set([".git"]) : new Set();
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError();
}

function cancelledError() {
  return new HitchError("workspace preparation cancelled", { code: "cancelled", exitCode: 9 });
}
