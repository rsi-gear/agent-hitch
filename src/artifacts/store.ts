import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { AdapterDefinition } from "../adapters/index.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, ensureDir, readJSON, statePaths, withFileLock } from "../foundation/index.js";
import type { StatePaths } from "../foundation/index.js";
import type { ResolvedRevision } from "../revisions/index.js";
import { artifactInvocation, artifactMatches } from "./integrity.js";
import type { ArtifactManifest, PreparedArtifact, PreparedArtifactExpectation } from "./types.js";

const RECIPE_VERSION = "1";

export function artifactManifest(
  resolved: ResolvedRevision,
  adapter: AdapterDefinition,
  artifactId: string,
  entrypoint: string,
  toolchain: Record<string, string>,
  extra: Record<string, unknown> = {},
): ArtifactManifest {
  return {
    schema_version: SCHEMA_VERSION,
    artifact_id: artifactId,
    harness_id: resolved.harness_id,
    revision_identity: resolved.identity,
    source_type: resolved.source.type,
    adapter: adapter.id,
    adapter_version: RECIPE_VERSION,
    recipe_version: RECIPE_VERSION,
    platform: `${process.platform}-${process.arch}`,
    entrypoint,
    toolchain,
    resolved_revision: resolved,
    ...extra,
    prepared_at: new Date().toISOString(),
  } as ArtifactManifest;
}

export async function promoteArtifact(paths: StatePaths, staging: string, manifest: ArtifactManifest, preparationKey: string): Promise<PreparedArtifact> {
  await ensureDir(paths.artifacts);
  const artifactDirectory = path.join(paths.artifacts, manifest.artifact_id.replace("sha256:", ""));
  try {
    await rename(staging, artifactDirectory);
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException)?.code || "")) throw error;
    const existing = await readJSON<ArtifactManifest | null>(path.join(artifactDirectory, "artifact.json"), null);
    const valid = existing?.artifact_id === manifest.artifact_id
      && await artifactMatches(artifactDirectory, existing);
    if (!valid) {
      const quarantine = path.join(paths.temporary, `invalid-${manifest.artifact_id.replace("sha256:", "")}-${randomBytes(6).toString("hex")}`);
      await rename(artifactDirectory, quarantine);
      try {
        await rename(staging, artifactDirectory);
      } catch (promotionError) {
        await rename(quarantine, artifactDirectory).catch(() => {});
        throw promotionError;
      }
      await rm(quarantine, { recursive: true, force: true });
    } else {
      await rm(staging, { recursive: true, force: true });
    }
  }
  await atomicWriteJSON(path.join(paths.artifactIndex, `${preparationKey.replace("sha256:", "")}.json`), {
    schema_version: SCHEMA_VERSION,
    preparation_key: preparationKey,
    artifact_id: manifest.artifact_id,
  });
  return {
    ...manifest,
    ...artifactInvocation(manifest, artifactDirectory),
    cache_hit: false,
  };
}

export async function readCachedArtifact(paths: StatePaths, preparationKey: string, expectedRevisionIdentity: string): Promise<PreparedArtifact | null> {
  const index = await readJSON<{ artifact_id?: string } | null>(path.join(paths.artifactIndex, `${preparationKey.replace("sha256:", "")}.json`), null);
  if (!index?.artifact_id) return null;
  const directory = path.join(paths.artifacts, index.artifact_id.replace("sha256:", ""));
  const manifest = await readJSON<ArtifactManifest | null>(path.join(directory, "artifact.json"), null);
  if (!manifest || manifest.artifact_id !== index.artifact_id || manifest.revision_identity !== expectedRevisionIdentity) return null;
  const executable = path.join(directory, manifest.entrypoint);
  try {
    await access(executable, manifest.launcher === "node" ? constants.R_OK : constants.X_OK);
    if (!await artifactMatches(directory, manifest)) return null;
  } catch {
    return null;
  }
  return { ...manifest, ...artifactInvocation(manifest, directory), cache_hit: true };
}

export function preparedArtifactDirectory(root: string, artifactId: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(artifactId)) {
    throw new HitchError(`invalid artifact ID: ${artifactId}`, { code: "artifact_invalid", exitCode: 5 });
  }
  return path.join(statePaths(root).artifacts, artifactId.slice("sha256:".length));
}

/**
 * Load an artifact handed across an isolation boundary. The caller supplies
 * independently pinned identity and integrity values (from Harbor's job
 * configuration); the uploaded manifest is never allowed to redefine them.
 */
export async function loadPreparedArtifact(
  directory: string,
  expected: PreparedArtifactExpectation,
): Promise<PreparedArtifact> {
  const absolute = path.resolve(directory);
  const info = await lstat(absolute).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new HitchError("prepared artifact handoff is not a regular directory", {
      code: "artifact_integrity_mismatch",
      exitCode: 5,
    });
  }
  const manifestPath = path.join(absolute, "artifact.json");
  const manifestInfo = await lstat(manifestPath).catch(() => null);
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) {
    throw new HitchError("prepared artifact handoff has no regular manifest", {
      code: "artifact_integrity_mismatch",
      exitCode: 5,
    });
  }
  let manifest: ArtifactManifest | null;
  try {
    manifest = await readJSON<ArtifactManifest | null>(manifestPath, null);
  } catch (error) {
    throw new HitchError("prepared artifact manifest is unreadable", {
      code: "artifact_integrity_mismatch",
      exitCode: 5,
      cause: error,
    });
  }
  if (
    !manifest
    || manifest.artifact_id !== expected.artifact_id
    || manifest.artifact_integrity !== expected.artifact_integrity
    || manifest.entrypoint_integrity !== expected.entrypoint_integrity
    || manifest.harness_id !== expected.harness_id
    || manifest.revision_identity !== expected.revision_identity
    || manifest.platform !== expected.platform
    || manifest.resolved_revision?.harness_id !== expected.harness_id
    || manifest.resolved_revision?.identity !== expected.revision_identity
  ) {
    throw new HitchError("prepared artifact handoff does not match its job-pinned identity", {
      code: "artifact_integrity_mismatch",
      exitCode: 5,
    });
  }
  const currentPlatform = `${process.platform}-${process.arch}`;
  if (manifest.platform !== currentPlatform) {
    throw new HitchError(`prepared artifact platform ${manifest.platform} is incompatible with ${currentPlatform}`, {
      code: "artifact_platform_mismatch",
      exitCode: 5,
    });
  }
  if (manifest.source_type === "installed" || !await artifactMatches(absolute, manifest)) {
    throw new HitchError("prepared artifact handoff failed content verification", {
      code: "artifact_integrity_mismatch",
      exitCode: 5,
    });
  }
  const invocation = artifactInvocation(manifest, absolute);
  await access(invocation.entrypoint_args[0] || invocation.executable, manifest.launcher === "node" ? constants.R_OK : constants.X_OK);
  return { ...manifest, ...invocation, cache_hit: true };
}

export async function withArtifactLock(
  paths: StatePaths,
  key: string,
  operation: () => Promise<PreparedArtifact>,
  options: { signal?: AbortSignal } = {},
): Promise<PreparedArtifact> {
  return withFileLock(paths.artifactLocks, key, operation, options);
}
