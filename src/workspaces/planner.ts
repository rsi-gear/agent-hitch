import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, invalidInput, statePaths } from "../foundation/index.js";
import { inspectGitWorkspace } from "./git.js";
import type { GitWorkspaceInfo, WorkspacePlan, WorkspacePlanOptions, WorkspaceSnapshot } from "./types.js";
import { WORKSPACE_MODES } from "./types.js";
import { assertNoWorkspaceOverlap, assertRunId, canonicalizePotentialPath, isWithin } from "./utils.js";

export async function planWorkspace({ runId, sourceCwd, mode = "shared", root, recordPath }: WorkspacePlanOptions): Promise<WorkspacePlan> {
  assertRunId(runId);
  if (!WORKSPACE_MODES.has(mode)) {
    throw invalidInput(`workspace_mode must be one of: ${[...WORKSPACE_MODES].join(", ")}`);
  }

  let sourceRealPath: string;
  let sourceInfo: Awaited<ReturnType<typeof stat>>;
  try {
    sourceRealPath = await realpath(sourceCwd);
    sourceInfo = await stat(sourceRealPath);
  } catch (error) {
    throw invalidInput(`workspace does not exist: ${sourceCwd}`, { cause: error });
  }
  if (!sourceInfo.isDirectory()) throw invalidInput(`workspace is not a directory: ${sourceCwd}`);

  const paths = statePaths(root);
  const managedDirectory = path.join(await canonicalizePotentialPath(paths.workspaces), runId);
  let git: GitWorkspaceInfo | null = null;
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
    if (git?.status) {
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
  const snapshot: WorkspaceSnapshot = mode === "worktree"
    ? { consistency: "git_commit", ...(git?.head ? { commit: git.head } : {}), source_subdirectory: sourceSubdirectory }
    : mode === "copy"
      ? {
          consistency: "best_effort",
          ...(git?.head ? { commit: git.head } : {}),
          source_subdirectory: sourceSubdirectory,
        }
      : { consistency: "none", source_subdirectory: "." };

  const plan: WorkspacePlan = {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    state_root: path.resolve(root),
    mode: mode as "shared" | "worktree" | "copy",
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
