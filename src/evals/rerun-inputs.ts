import path from "node:path";
import { loadPreparedArtifact, preparedArtifactDirectory } from "../artifacts/index.js";
import type { ResolvedRevision } from "../artifacts/index.js";
import { validateLocalGitTransportManifest, verifyLocalGitTransport } from "../backends/index.js";
import type { HarborPreparedArtifactUse, LocalGitTransportUse } from "../backends/index.js";
import { HitchError, readJSON } from "../foundation/index.js";
import { loadHarborArtifact } from "./harbor-artifact-builder.js";

interface RerunInputPlan {
  candidate: Record<string, unknown>;
  preparedArtifacts: Record<string, unknown>[];
  localSourceTransport?: Record<string, unknown>;
}

export async function loadRerunResolvedRevision(evalDirectory: string, plan: RerunInputPlan): Promise<ResolvedRevision> {
  const resolution = await readJSON<ResolvedRevision>(path.join(evalDirectory, "resolution.json"));
  if (!resolution || resolution.identity !== requiredString(plan.candidate.revision_identity, "candidate revision identity")
    || resolution.harness_id !== requiredString(plan.candidate.harness_id, "candidate harness id")) {
    throw unavailable("eval resolution identity changed");
  }
  return resolution;
}

export async function loadRerunPreparedArtifacts(root: string, plan: RerunInputPlan): Promise<Map<string, HarborPreparedArtifactUse>> {
  const artifacts = new Map<string, HarborPreparedArtifactUse>();
  for (const summary of plan.preparedArtifacts) {
    const artifact = await loadRerunPreparedArtifactSummary(root, summary);
    artifacts.set(artifact.artifact_id, artifact);
  }
  if (artifacts.size === 0) throw unavailable("eval has no prepared artifact assignments");
  return artifacts;
}

async function loadRerunPreparedArtifactSummary(root: string, summary: Record<string, unknown>): Promise<HarborPreparedArtifactUse> {
  const artifactId = requiredString(summary.artifact_id, "prepared artifact id");
  if (summary.storage === "harbor-artifact-cache-v2") {
    return loadHarborArtifact(root, {
      artifact_id: artifactId,
      artifact_integrity: requiredString(summary.artifact_integrity, "prepared artifact integrity"),
      entrypoint_integrity: requiredString(summary.entrypoint_integrity, "prepared artifact entrypoint integrity"),
      harness_id: requiredString(summary.harness_id, "prepared artifact harness id"),
      revision_identity: requiredString(summary.revision_identity, "prepared artifact revision identity"),
      platform: requiredString(summary.platform, "prepared artifact platform"),
    });
  }
  const artifact = await loadPreparedArtifact(preparedArtifactDirectory(root, artifactId), {
    artifact_id: artifactId,
    artifact_integrity: requiredString(summary.artifact_integrity, "prepared artifact integrity"),
    entrypoint_integrity: requiredString(summary.entrypoint_integrity, "prepared artifact entrypoint integrity"),
    harness_id: requiredString(summary.harness_id, "prepared artifact harness id"),
    revision_identity: requiredString(summary.revision_identity, "prepared artifact revision identity"),
    platform: requiredString(summary.platform, "prepared artifact platform"),
  });
  return {
    directory: preparedArtifactDirectory(root, artifact.artifact_id),
    artifact_id: artifact.artifact_id,
    artifact_integrity: requiredString(artifact.artifact_integrity, "artifact integrity"),
    entrypoint_integrity: requiredString(artifact.entrypoint_integrity, "artifact entrypoint integrity"),
    harness_id: artifact.harness_id,
    revision_identity: artifact.revision_identity,
    adapter_version: artifact.adapter_version,
    recipe_version: artifact.recipe_version,
    platform: artifact.platform,
    node_version: artifact.toolchain.node || process.version,
    source_type: artifact.source_type,
  };
}

export async function loadRerunLocalTransport(
  evalDirectory: string,
  plan: RerunInputPlan,
  resolution: ResolvedRevision,
  env: NodeJS.ProcessEnv | undefined,
  signal: AbortSignal | undefined,
): Promise<LocalGitTransportUse | undefined> {
  if (plan.localSourceTransport === undefined) return undefined;
  const directory = path.join(evalDirectory, "local-source");
  const manifestPath = path.join(directory, "manifest.json");
  const use: LocalGitTransportUse = {
    directory,
    manifestPath,
    payloadPath: path.join(directory, "payload.pack"),
    resolutionPath: path.join(directory, "resolution.json"),
    manifest: validateLocalGitTransportManifest(await readJSON(manifestPath)),
  };
  await verifyLocalGitTransport(use, {
    expected: {
      harnessId: resolution.harness_id,
      resolutionIdentity: resolution.identity,
      commit: requiredString(resolution.revision.commit, "local source commit"),
    },
    env: env ?? process.env,
    ...(signal ? { signal } : {}),
  });
  return use;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw unavailable(`${label} is missing`);
  return value;
}

function unavailable(message: string): HitchError {
  return new HitchError(message, { code: "eval_rerun_unavailable", exitCode: 2 });
}
