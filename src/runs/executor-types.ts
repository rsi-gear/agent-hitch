import type { PreparedArtifact, ResolvedRevision } from "../artifacts/index.js";
import type { ManagedInferenceCoordinator, RunId, Sha256 } from "../domain/index.js";
import type { VerifiedLocalGitSource } from "../revisions/index.js";
import type { WorkspacePlan } from "../workspaces/index.js";
import type { RunRequestInput } from "./request.js";

export interface ExecuteRunOptions {
  runId: RunId;
  request: RunRequestInput;
  runsRoot: string;
  root?: string;
  resolvedRevision?: ResolvedRevision;
  preparedArtifact?: PreparedArtifact;
  verifiedLocalGitSource?: VerifiedLocalGitSource;
  workspacePlan?: WorkspacePlan;
  onEvent?: (event: Record<string, unknown>) => void;
  onProcess?: (control: { child?: import("node:child_process").ChildProcess } | null) => void;
  signal?: AbortSignal;
  /** Process-local monotonic deadline supplied by the managed benchmark CLI. */
  candidateDeadlineNs?: bigint;
  inferenceCoordinator?: ManagedInferenceCoordinator;
  /** Harbor-only: the controller has already bound this run through its authenticated model proxy. */
  managedModelProxy?: { inference_id: Sha256; model_id: Sha256 };
}
