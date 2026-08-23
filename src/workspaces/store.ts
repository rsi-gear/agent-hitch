import { sha256Bytes, statePaths, withFileLock } from "../foundation/index.js";
import type { RunId } from "../domain/index.js";
import path from "node:path";
import type { WorkspacePlan } from "./types.js";

export function workspaceRecordPath(root: string, runId: RunId): string {
  return path.join(statePaths(root).runs, runId, "workspace.json");
}

export function workspaceManifestFields(workspace: WorkspacePlan | null | undefined): Record<string, unknown> {
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

export async function withWorkspaceLock<T>(root: string, identity: string, operation: () => Promise<T>, { signal }: { signal?: AbortSignal | undefined } = {}): Promise<T> {
  return withFileLock(statePaths(root).workspaceLocks, sha256Bytes(identity), operation, {
    timeoutCode: "workspace_locked",
    timeoutExitCode: 5,
    ...(signal ? { signal } : {}),
  });
}
