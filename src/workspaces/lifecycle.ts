import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { HitchError, atomicWriteJSON, invalidInput, readJSON, statePaths } from "../foundation/index.js";
import type { RunId } from "../domain/index.js";
import { prepareCopy } from "./copy.js";
import { workspaceDigest } from "./digest.js";
import { isolatedGitMetadataDigest, prepareWorktree, registeredWorktree, runGit, tryGitOutput } from "./git.js";
import { withWorkspaceLock, workspaceRecordPath } from "./store.js";
import type { WorkspacePlan } from "./types.js";
import { ACTIVE_WORKSPACE_STATES } from "./types.js";
import { assertRunId, canonicalizePotentialPath, isWithin, pathExists, throwIfAborted } from "./utils.js";

export async function prepareWorkspace(plan: WorkspacePlan, { recordPath, signal }: { recordPath?: string; signal?: AbortSignal | undefined } = {}): Promise<WorkspacePlan> {
  if (plan.mode === "shared") {
    const ready: WorkspacePlan = {
      ...plan,
      status: "ready",
      prepared_at: new Date().toISOString(),
    };
    if (recordPath) await atomicWriteJSON(recordPath, ready);
    return ready;
  }

  const provisioning: WorkspacePlan = { ...plan, status: "provisioning", provisioning_at: new Date().toISOString() };
  if (recordPath) await atomicWriteJSON(recordPath, provisioning);
  let ownsManagedDirectory = false;

  try {
    throwIfAborted(signal);
    await assertManagedPlan(plan);
    await mkdir(path.dirname(plan.managed_directory as string), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(plan.managed_directory as string), 0o700);
    if (await pathExists(plan.managed_directory as string)) {
      throw new HitchError(`managed workspace already exists for ${plan.run_id}`, {
        code: "workspace_already_exists",
        exitCode: 11,
      });
    }
    await mkdir(plan.managed_directory as string, { mode: 0o700 });
    ownsManagedDirectory = true;
    const preparation = plan.mode === "worktree"
      ? await prepareWorktree(plan, { signal })
      : await prepareCopy(plan, { signal });
    await chmod(plan.managed_directory as string, 0o700);
    await chmod(plan.execution_root, 0o700);
    const baselineDigest = preparation?.baseline_digest || await workspaceDigest(plan.execution_root, {
      signal,
      excludedTopLevel: gitMetadataExclusion(plan),
    });
    const baselineGitMetadataDigest = plan.mode === "copy" && plan.git
      ? await isolatedGitMetadataDigest(plan.execution_root, { signal })
      : null;
    const preparedAt = new Date().toISOString();
    const ready: WorkspacePlan = {
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
    const errno = error as NodeJS.ErrnoException;
    const workspaceError = errno?.code === "EEXIST"
      ? new HitchError(`managed workspace already exists for ${plan.run_id}`, {
          code: "workspace_already_exists",
          exitCode: 11,
          cause: error,
        })
      : error;
    const hitchWorkspaceError = workspaceError as Partial<HitchError>;
    const failed: WorkspacePlan = {
      ...provisioning,
      status: workspaceError instanceof Error && workspaceError.name === "HitchError" && hitchWorkspaceError.code === "cancelled" ? "cancelled" : "failed",
      retained: false,
      error: { code: hitchWorkspaceError.code || "workspace_provision_failed", message: (workspaceError as Error)?.message || String(workspaceError) },
      completed_at: new Date().toISOString(),
    };
    if (recordPath) await atomicWriteJSON(recordPath, failed);
    if (workspaceError instanceof HitchError) throw workspaceError;
    throw new HitchError(`failed to provision isolated workspace: ${(workspaceError as Error).message}`, {
      code: "workspace_provision_failed",
      exitCode: 5,
      cause: workspaceError,
    });
  }
}

export async function markWorkspaceRunning(workspace: WorkspacePlan, { recordPath }: { recordPath?: string } = {}): Promise<WorkspacePlan> {
  const running: WorkspacePlan = { ...workspace, status: "running", started_at: new Date().toISOString() };
  if (recordPath) await atomicWriteJSON(recordPath, running);
  return running;
}

export async function finalizeWorkspace(workspace: WorkspacePlan | null | undefined, { recordPath }: { recordPath?: string } = {}): Promise<WorkspacePlan | null> {
  if (!workspace) return null;
  if (workspace.mode === "shared") {
    const released: WorkspacePlan = {
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
  let headAfter: string | null = null;
  let gitStatus: string | null = null;
  let finalGitMetadataDigest: string | null = null;
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
  const retained: WorkspacePlan = {
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

export async function markWorkspaceFinalizationFailed(
  workspace: WorkspacePlan | null | undefined,
  { recordPath, warning }: { recordPath?: string; warning?: { code: string; message: string } } = {},
): Promise<WorkspacePlan | null> {
  if (!workspace) return null;
  const terminal: WorkspacePlan = {
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

export async function cancelPlannedWorkspace({ root, runId }: { root: string; runId: RunId }): Promise<WorkspacePlan | null> {
  return abandonPlannedWorkspace({ root, runId, status: "cancelled" });
}

export async function abandonPlannedWorkspace(
  { root, runId, status = "unused" }: { root: string; runId: RunId; status?: "unused" | "cancelled" },
): Promise<WorkspacePlan | null> {
  const recordPath = workspaceRecordPath(root, runId);
  const workspace = await readJSON<WorkspacePlan | null>(recordPath, null);
  if (!workspace || workspace.status !== "planned") return workspace;
  const completed: WorkspacePlan = { ...workspace, status, completed_at: new Date().toISOString() };
  await atomicWriteJSON(recordPath, completed);
  return completed;
}

export async function recoverInterruptedWorkspace({ root, runId }: { root: string; runId: RunId }): Promise<WorkspacePlan | null> {
  const recordPath = workspaceRecordPath(root, runId);
  const workspace = await readJSON<WorkspacePlan | null>(recordPath, null);
  if (!workspace) return null;
  if (workspace.status === "provisioning") {
    await cleanupProvisioning(workspace).catch(() => {});
    const failed: WorkspacePlan = {
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
    const orphaned: WorkspacePlan = {
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

export async function inspectWorkspace({ root, runId }: { root: string; runId: RunId }): Promise<WorkspacePlan | null> {
  assertRunId(runId);
  return readJSON<WorkspacePlan | null>(workspaceRecordPath(root, runId), null);
}

export async function removeWorkspace({ root, runId, force = false }: { root: string; runId: RunId; force?: boolean }): Promise<WorkspacePlan> {
  assertRunId(runId);
  const recordPath = workspaceRecordPath(root, runId);
  const workspace = await readJSON<WorkspacePlan | null>(recordPath, null);
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
    const git = workspace.git;
    await withWorkspaceLock(root, git.common_dir, async () => {
      if (await pathExists(git.common_dir) && await registeredWorktree(git.common_dir, workspace.execution_root)) {
        await runGit(["--git-dir", git.common_dir, "worktree", "remove", "--force", workspace.execution_root], {
          failureCode: "workspace_cleanup_failed",
          failureExitCode: 12,
        });
      }
    });
  }
  await rm(expectedDirectory, { recursive: true, force: true });
  const removed: WorkspacePlan = {
    ...workspace,
    status: "removed",
    retained: false,
    removed_at: new Date().toISOString(),
  };
  await atomicWriteJSON(recordPath, removed);
  return removed;
}

async function cleanupProvisioning(workspace: WorkspacePlan): Promise<void> {
  await assertManagedPlan(workspace);
  const git = workspace.git;
  if (
    workspace.mode === "worktree"
    && git?.common_dir
    && await pathExists(git.common_dir)
    && await registeredWorktree(git.common_dir, workspace.execution_root)
  ) {
    await withWorkspaceLock(workspace.state_root, git.common_dir, () => runGit([
      "--git-dir",
      git.common_dir,
      "worktree",
      "remove",
      "--force",
      workspace.execution_root,
    ], {
      failureCode: "workspace_cleanup_failed",
      failureExitCode: 12,
    })).catch(() => {});
  }
  if (workspace.managed_directory) await rm(workspace.managed_directory, { recursive: true, force: true });
}

async function assertManagedPlan(workspace: WorkspacePlan): Promise<void> {
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

function gitMetadataExclusion(workspace: WorkspacePlan): Set<string> {
  return workspace.git ? new Set([".git"]) : new Set();
}
