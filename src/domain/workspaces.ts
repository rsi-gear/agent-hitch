export type WorkspaceMode = "shared" | "worktree" | "copy";

export type WorkspaceStatus =
  | "planned"
  | "provisioning"
  | "ready"
  | "running"
  | "released"
  | "retained"
  | "orphaned"
  | "failed"
  | "cancelled"
  | "removed"
  | "unused";
