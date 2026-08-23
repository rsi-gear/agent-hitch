import type { RunId, WorkspaceMode, WorkspaceStatus } from "../domain/index.js";
export type { WorkspaceMode, WorkspaceStatus } from "../domain/index.js";

export const WORKSPACE_MODES = new Set(["shared", "worktree", "copy"]);

export const COMMAND_TIMEOUT_MS = 120_000;
export const ACTIVE_WORKSPACE_STATES = new Set(["planned", "provisioning", "ready", "running"]);

export interface WorktreePreparation {
  baseline_digest?: string;
}

export interface WorkspaceSnapshot {
  consistency: string;
  commit?: string;
  source_subdirectory: string;
  content_digest?: string;
  captured_at?: string;
}

export interface GitWorkspaceInfo {
  repository_root: string;
  common_dir: string;
  head: string | null;
  status: string;
}

export interface WorkspacePlan {
  schema_version: string;
  run_id: RunId;
  state_root: string;
  mode: WorkspaceMode;
  status: WorkspaceStatus;
  source_workspace: string;
  source_realpath: string;
  source_base: string;
  source_subdirectory: string;
  execution_root: string;
  execution_workspace: string;
  managed_directory: string | null;
  snapshot: WorkspaceSnapshot;
  git: GitWorkspaceInfo | null;
  retained: boolean;
  changed?: boolean | null;
  baseline_digest?: string;
  baseline_git_metadata_digest?: string | null;
  final_digest?: string;
  final_git_metadata_digest?: string;
  head_after?: string;
  git_dirty?: boolean;
  warning?: { code: string; message: string };
  error?: { code: string; message: string };
  planned_at?: string;
  provisioning_at?: string;
  prepared_at?: string;
  started_at?: string;
  finalized_at?: string;
  completed_at?: string;
  removed_at?: string;
}

export interface WorkspacePlanOptions {
  runId: RunId;
  sourceCwd: string;
  mode?: string;
  root: string;
  recordPath?: string;
}
