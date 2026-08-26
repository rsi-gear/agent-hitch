import { HitchError } from "../foundation/index.js";
import type { ResolvedRevision } from "../revisions/index.js";
import type { PreparedArtifact } from "./types.js";

export function assertPreparedArtifactRevision(
  artifact: PreparedArtifact,
  resolution: ResolvedRevision,
): void {
  if (
    artifact.harness_id !== resolution.harness_id
    || artifact.revision_identity !== resolution.identity
    || artifact.resolved_revision?.identity !== resolution.identity
  ) {
    throw new HitchError("prepared artifact does not match the resolved harness revision", {
      code: "artifact_integrity_mismatch",
      exitCode: 5,
    });
  }
}
