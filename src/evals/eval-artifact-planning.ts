import type { ResolvedRevision } from "../artifacts/index.js";
import { harborTrialRuntimeContract } from "../backends/index.js";
import type { HarborPreparedArtifactUse, HarborTrialRuntimeContract, LocalGitTransportUse } from "../backends/index.js";
import type { ControllerRuntimeUseResult } from "../controller-runtime/index.js";
import { HitchError } from "../foundation/index.js";
import type { ParsedHarnessReference } from "../revisions/index.js";
import type { EvalEventSink } from "./events.js";
import type { EvalHarborArtifactBuilder } from "./harbor-artifact-builder.js";
import type { LocalEvalPlanningResultV1 } from "./local-eval-planning.js";
import { prepareEvalHarborArtifact, preparedHarnessEvent } from "./prepared-harness.js";
import { preparedArtifactSummary } from "./result-helpers.js";

export interface PreparedEvalArtifactAssignment {
  taskIds: string[];
  runtimeContract: HarborTrialRuntimeContract;
  artifact: HarborPreparedArtifactUse;
}

export async function prepareEvalArtifactAssignments(input: {
  builder: EvalHarborArtifactBuilder;
  root: string;
  resolvedRevision: ResolvedRevision;
  requestedReference: ParsedHarnessReference;
  controllerRuntime: ControllerRuntimeUseResult;
  localTransport?: LocalGitTransportUse;
  taskRuntimeContracts: LocalEvalPlanningResultV1["taskRuntimeContracts"];
  sink: EvalEventSink;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<{
  assignments: PreparedEvalArtifactAssignment[];
  primary: HarborPreparedArtifactUse;
  artifactsById: Map<string, HarborPreparedArtifactUse>;
}> {
  const assignments: PreparedEvalArtifactAssignment[] = [];
  for (const assignment of input.taskRuntimeContracts) {
    const runtimeContract = harborTrialRuntimeContract(assignment.docker_platform);
    const prepared = await prepareEvalHarborArtifact({
      builder: input.builder,
      root: input.root,
      resolvedRevision: input.resolvedRevision,
      requestedReference: input.requestedReference,
      controllerRuntime: input.controllerRuntime,
      runtimeContract,
      ...(input.localTransport ? { localTransport: input.localTransport } : {}),
      env: input.env,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    assignments.push({ taskIds: assignment.task_ids, runtimeContract, artifact: prepared.artifact });
    input.sink.emit({
      ...preparedHarnessEvent(prepared.artifact, prepared.cacheHit, prepared.source, {
        ...(prepared.builderImage ? { image: prepared.builderImage } : {}),
        ...(prepared.builderImageId ? { imageId: prepared.builderImageId } : {}),
      }),
      task_ids: assignment.task_ids,
      runtime_contract: assignment,
    });
  }
  const primary = assignments[0]?.artifact;
  if (!primary) throw new HitchError("planner produced no Harbor artifact assignment", { code: "harbor_artifact_assignment_missing", exitCode: 12 });
  const artifactsById = new Map(assignments.map((entry) => [entry.artifact.artifact_id, entry.artifact]));
  if (artifactsById.size !== assignments.length) {
    throw new HitchError("distinct Harbor runtime contracts produced the same artifact identity", {
      code: "harbor_artifact_assignment_conflict",
      exitCode: 12,
    });
  }
  return { assignments, primary, artifactsById };
}

export function preparedArtifactPlanFields(assignments: readonly PreparedEvalArtifactAssignment[]): Record<string, unknown> {
  return {
    ...(assignments.length === 1 ? { prepared_artifact: preparedArtifactSummary(assignments[0]!.artifact) } : {}),
    prepared_artifacts: assignments.map((entry) => ({
      ...preparedArtifactSummary(entry.artifact),
      task_ids: entry.taskIds,
      runtime_contract: {
        docker_platform: entry.runtimeContract.dockerPlatform,
        artifact_platform: entry.runtimeContract.artifactPlatform,
        node_version: entry.runtimeContract.nodeVersion,
      },
    })),
  };
}
