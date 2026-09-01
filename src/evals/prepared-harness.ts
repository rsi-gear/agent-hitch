import { preparedArtifactDirectory } from "../artifacts/index.js";
import type { PreparedArtifact } from "../artifacts/index.js";
import type { HarborPreparedArtifactUse } from "../backends/index.js";
import type { LocalGitTransportUse } from "../backends/index.js";
import { HitchError } from "../foundation/index.js";
import type { ParsedHarnessReference } from "../revisions/index.js";
import { prepareHarness } from "../artifacts/index.js";
import type { ControllerRuntimeUseResult } from "../controller-runtime/index.js";
import type { HarborTrialRuntimeContract } from "../backends/index.js";
import type { EvalHarborArtifactBuilder, HarborArtifactPreparationResult } from "./harbor-artifact-builder.js";

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
    storage: "host-artifact-store-v1",
  };
}

export function preparedHarnessEvent(
  artifact: Pick<PreparedArtifact, "harness_id" | "artifact_id" | "platform">,
  cacheHit: boolean,
  source: "dedicated-builder" | "test-host",
  builder?: { image?: string; imageId?: string },
): Record<string, unknown> {
  return {
    type: "eval.harness-artifact.prepared",
    harness: artifact.harness_id,
    artifact_id: artifact.artifact_id,
    platform: artifact.platform,
    cache_hit: cacheHit,
    source,
    ...(builder?.image ? { builder_image: builder.image } : {}),
    ...(builder?.imageId ? { builder_image_id: builder.imageId } : {}),
  };
}

export async function prepareEvalHarborArtifact(input: {
  builder: EvalHarborArtifactBuilder;
  root: string;
  resolvedRevision: Parameters<EvalHarborArtifactBuilder>[0]["resolvedRevision"];
  requestedReference: ParsedHarnessReference;
  controllerRuntime: ControllerRuntimeUseResult;
  runtimeContract: HarborTrialRuntimeContract;
  localTransport?: LocalGitTransportUse;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<HarborArtifactPreparationResult> {
  const selector = input.requestedReference.selector;
  const verifiedLocalGitSource = input.localTransport && selector.type === "commit" && selector.source?.explicit
    ? {
        directory: selector.source.local_path,
        commit: input.localTransport.manifest.commit,
        tree: input.localTransport.manifest.tree,
        resolutionIdentity: input.localTransport.manifest.resolution_identity,
        payloadSha256: input.localTransport.manifest.payload_sha256,
      }
    : undefined;
  return input.builder({
    root: input.root,
    resolvedRevision: input.resolvedRevision,
    runtimeDirectory: input.controllerRuntime.directory,
    runtimeId: input.controllerRuntime.runtime_id,
    runtimeContract: input.runtimeContract,
    ...(input.localTransport ? { localTransport: input.localTransport } : {}),
    ...(verifiedLocalGitSource ? { verifiedLocalGitSource } : {}),
    env: input.env,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

/** In-process seam for tests whose fake package manager cannot be mounted into
 * Docker. Production callers must use the dedicated builder. */
export const prepareHostHarborArtifactForTest: EvalHarborArtifactBuilder = async (input) => {
  const artifact = await prepareHarness(input.resolvedRevision, {
    root: input.root,
    env: input.env,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.verifiedLocalGitSource ? { verifiedLocalGitSource: input.verifiedLocalGitSource } : {}),
  });
  return {
    artifact: harborPreparedArtifact(input.root, artifact),
    cacheHit: artifact.cache_hit,
    source: "test-host",
  };
};
