import { preparedArtifactDirectory } from "../artifacts/index.js";
import type { PreparedArtifact } from "../artifacts/index.js";
import type { HarborPreparedArtifactUse } from "../backends/index.js";
import { HitchError } from "../foundation/index.js";

export function harborPreparedArtifact(root: string, artifact: PreparedArtifact): HarborPreparedArtifactUse {
  if (!artifact.artifact_integrity || !artifact.entrypoint_integrity) {
    throw new HitchError("host-prepared harness artifact has no complete integrity metadata", {
      code: "artifact_integrity_mismatch",
      exitCode: 5,
    });
  }
  return {
    directory: preparedArtifactDirectory(root, artifact.artifact_id),
    artifact_id: artifact.artifact_id,
    artifact_integrity: artifact.artifact_integrity,
    entrypoint_integrity: artifact.entrypoint_integrity,
    harness_id: artifact.harness_id,
    revision_identity: artifact.revision_identity,
    adapter_version: artifact.adapter_version,
    recipe_version: artifact.recipe_version,
    platform: artifact.platform,
    node_version: artifact.toolchain.node || process.version,
    source_type: artifact.source_type,
  };
}

export function preparedHarnessEvent(artifact: PreparedArtifact): Record<string, unknown> {
  return {
    type: "eval.harness-artifact.prepared",
    harness: artifact.harness_id,
    artifact_id: artifact.artifact_id,
    platform: artifact.platform,
    cache_hit: artifact.cache_hit,
  };
}
