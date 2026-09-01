import type { HarborPreparedArtifactUse } from "../backends/index.js";
import type { BackendWorkItemV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";

export function preparedArtifactForWorkItem(
  artifacts: { preparedArtifact: HarborPreparedArtifactUse; preparedArtifacts?: ReadonlyMap<string, HarborPreparedArtifactUse> },
  item: BackendWorkItemV1,
): HarborPreparedArtifactUse {
  if (!item.artifact_id) return artifacts.preparedArtifact;
  const artifact = artifacts.preparedArtifacts?.get(item.artifact_id)
    ?? (artifacts.preparedArtifact.artifact_id === item.artifact_id ? artifacts.preparedArtifact : undefined);
  if (!artifact) {
    throw new HitchError(`work item references an unavailable prepared artifact: ${item.artifact_id}`, {
      code: "harbor_artifact_assignment_missing",
      exitCode: 12,
    });
  }
  if (artifact.storage === "harbor-artifact-cache-v2" && item.runtime_contract
    && (artifact.platform !== item.runtime_contract.artifact_platform
      || artifact.node_version !== item.runtime_contract.node_version)) {
    throw new HitchError(`work item artifact does not match its runtime contract: ${item.work_id}`, {
      code: "harbor_artifact_builder_contract_mismatch",
      exitCode: 12,
    });
  }
  return artifact;
}
