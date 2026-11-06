import type { ControllerRuntimeUseResult } from "../controller-runtime/index.js";
import { SharedRuntimeSnapshots } from "./shared-runtime.js";
import type { PreparedEvalArtifactAssignment } from "./eval-artifact-planning.js";
import type { LocalEvalPlanningResultV1 } from "./local-eval-planning.js";
import type { EvalResumeState } from "./resume-state.js";
import { loadRerunPreparedArtifacts } from "./rerun-inputs.js";

/** Resume uses verified saved artifacts, never rebuilding them with today's
 * controller, package manager or artifact recipe. */
export async function loadResumedEvalArtifacts(root: string, state: EvalResumeState, contracts: LocalEvalPlanningResultV1["taskRuntimeContracts"], sharedRuntime?: {
  directory?: string | undefined;
  controllerRuntime: ControllerRuntimeUseResult;
  transport?: string | undefined;
  signal?: AbortSignal | undefined;
}) {
  const summaries = Array.isArray(state.plan.prepared_artifacts) ? state.plan.prepared_artifacts
    : state.plan.prepared_artifact ? [state.plan.prepared_artifact] : [];
  if (!summaries.length || summaries.some(s => !s || typeof s !== "object" || Array.isArray(s))) throw new TypeError("resumable eval artifact assignments are missing");
  const artifactsById = await loadRerunPreparedArtifacts(root, { candidate: state.plan.candidate as Record<string, unknown>, preparedArtifacts: summaries as Record<string, unknown>[] });
  if (sharedRuntime) {
    if (sharedRuntime.transport === "readonly-bind") {
      const pin = state.plan.controller_runtime as Record<string, unknown> | undefined;
      if (pin?.runtime_id !== sharedRuntime.controllerRuntime.runtime_id || pin?.manifest_digest !== sharedRuntime.controllerRuntime.manifest_digest) {
        throw new TypeError("resumable shared runtime differs from the frozen controller");
      }
    }
    const snapshots = new SharedRuntimeSnapshots(sharedRuntime.directory, sharedRuntime.controllerRuntime, sharedRuntime.transport);
    for (const [id, artifact] of artifactsById) artifactsById.set(id, await snapshots.prepare(artifact, sharedRuntime.signal));
  }
  const assignments: PreparedEvalArtifactAssignment[] = contracts.map(contract => {
    const work = state.executionPlan.work_items.find(w => w.task_ids.some(id => contract.task_ids.includes(id)) || (w.opaque_membership && !contract.task_ids.length));
    const id = work?.artifact_id ?? (artifactsById.size === 1 ? [...artifactsById.keys()][0] : undefined);
    const artifact = id && artifactsById.get(id);
    if (!artifact) throw new TypeError("resumable work artifact is unavailable");
    return { taskIds: contract.task_ids, artifact, runtimeContract: { dockerPlatform: contract.docker_platform, artifactPlatform: contract.artifact_platform, nodeVersion: contract.node_version } };
  });
  const primary = assignments[0]?.artifact;
  if (!primary) throw new TypeError("resumable eval has no primary artifact");
  return { assignments, primary, artifactsById };
}

export function resumedArtifactPlanFields(state: EvalResumeState): Record<string, unknown> {
  return {
    ...(state.plan.prepared_artifact === undefined ? {} : { prepared_artifact: state.plan.prepared_artifact }),
    ...(state.plan.prepared_artifacts === undefined ? {} : { prepared_artifacts: state.plan.prepared_artifacts }),
  };
}
