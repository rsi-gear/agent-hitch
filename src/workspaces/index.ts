export { WORKSPACE_MODES } from "./types.js";
export type { GitWorkspaceInfo, WorkspacePlan, WorkspacePlanOptions, WorkspaceSnapshot, WorkspaceStatus } from "./types.js";
export { planWorkspace } from "./planner.js";
export { abandonPlannedWorkspace, cancelPlannedWorkspace, finalizeWorkspace, inspectWorkspace, markWorkspaceFinalizationFailed, markWorkspaceRunning, prepareWorkspace, recoverInterruptedWorkspace, removeWorkspace } from "./lifecycle.js";
export { workspaceDigest } from "./digest.js";
export { workspaceManifestFields, workspaceRecordPath } from "./store.js";
