import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, chmod, lstat, open, readFile, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { getAdapter } from "./adapters.js";
import type { AdapterDefinition, RevisionSourceDefinition } from "./adapters.js";
import { statePaths, SCHEMA_VERSION } from "./config.js";
import type { StatePaths } from "./config.js";
import { HitchError } from "./errors.js";
import { atomicWriteJSON, ensureDir, readJSON, removeIfExists } from "./fs.js";
import { parseHarnessReference } from "./harness-reference.js";
import type { ParsedHarnessReference, RevisionSelector } from "./harness-reference.js";
import { detectVersion, fingerprintExecutable, inspectAgent } from "./registry.js";
import type { DiscoveredAgent } from "./registry.js";
import { delay, terminateProcess } from "./process.js";
import { reclaimStaleLock } from "./locks.js";

const RECIPE_VERSION = "1";
const COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;

export interface ResolvedRevision {
  schema_version: string;
  requested_ref: string;
  canonical_ref: string;
  harness_id: string;
  selector: RevisionSelector;
  source: {
    type: "installed" | "npm" | "git";
    executable?: string;
    integrity?: string;
    package?: string;
    tarball?: string;
    url?: string;
    registered?: boolean;
  };
  revision: {
    type: string;
    version?: string | null;
    requested_commit?: string;
    commit?: string;
  };
  identity: string;
  resolved_at: string;
}

export interface ArtifactManifest {
  schema_version: string;
  artifact_id: string;
  harness_id: string;
  revision_identity: string;
  source_type: string;
  adapter: string;
  adapter_version: string;
  recipe_version: string;
  platform: string;
  entrypoint: string;
  toolchain: Record<string, string>;
  resolved_revision: ResolvedRevision;
  dependency_lock?: string | null;
  artifact_integrity?: string;
  entrypoint_integrity?: string;
  launcher?: string;
  observed_version?: string | null;
  prepared_at: string;
}

export interface ArtifactInvocation {
  executable: string;
  entrypoint_args: string[];
}

export interface PreparedArtifact extends ArtifactManifest, ArtifactInvocation {
  cache_hit: boolean;
}

export interface ListedArtifact extends ArtifactManifest {
  status: "ready" | "invalid";
}

export async function resolveHarness(
  referenceValue: string | ParsedHarnessReference,
  { root, env = process.env }: { root?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ResolvedRevision> {
  const reference = typeof referenceValue === "string" ? parseHarnessReference(referenceValue) : referenceValue;
  const adapter = getAdapter(reference.harness_id);
  if (reference.selector.type === "installed") return resolveInstalled(reference, env);

  const source = adapter.revision_sources?.[reference.selector.type];
  if (!source) {
    throw new HitchError(`${reference.harness_id} does not support ${reference.selector.type} revisions`, {
      code: "revision_selector_unsupported",
      exitCode: 10,
    });
  }
  if (!root) throw new HitchError("a Hitch state root is required to resolve managed revisions");
  if (reference.selector.type === "version") return resolveVersion(reference, source, env);
  return resolveCommit(reference, source, statePaths(root), env);
}

export async function prepareHarness(
  resolved: ResolvedRevision,
  { root, env = process.env, signal }: { root?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<PreparedArtifact> {
  if (!resolved || typeof resolved !== "object" || !resolved.identity) {
    throw new HitchError("resolved revision is required", { code: "invalid_resolution", exitCode: 2 });
  }
  const adapter = getAdapter(resolved.harness_id);
  if (resolved.source.type === "installed") return prepareInstalled(resolved, adapter);
  if (!root) throw new HitchError("a Hitch state root is required to prepare managed revisions");
  const source = adapter.revision_sources?.[resolved.selector.type];
  if (!source) {
    throw new HitchError(`${resolved.harness_id} does not support ${resolved.selector.type} revisions`, {
      code: "revision_selector_unsupported",
      exitCode: 10,
    });
  }
  const paths = statePaths(root);
  const preparationKey = digest({
    revision_identity: resolved.identity,
    recipe_version: RECIPE_VERSION,
    recipe: recipeIdentity(source),
    platform: process.platform,
    architecture: process.arch,
    node: process.versions.node,
  });
  return withArtifactLock(paths, preparationKey, async () => {
    const cached = await readCachedArtifact(paths, preparationKey, resolved.identity);
    if (cached) return { ...cached, cache_hit: true };
    return resolved.source.type === "npm"
      ? prepareNpmArtifact(resolved, adapter, source, paths, preparationKey, env, signal)
      : prepareGitArtifact(resolved, adapter, source, paths, preparationKey, env, signal);
  }, { ...(signal ? { signal } : {}) });
}

export async function listPreparedArtifacts(harnessId: string, { root }: { root?: string } = {}): Promise<ListedArtifact[]> {
  if (!root) throw new HitchError("a Hitch state root is required to list prepared artifacts");
  const directory = statePaths(root).artifacts;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const artifacts: ListedArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readJSON<ArtifactManifest | null>(path.join(directory, entry.name, "artifact.json"), null).catch(() => null);
    if (!manifest || manifest.harness_id !== harnessId) continue;
    const artifactDirectory = path.join(directory, entry.name);
    const ready = await artifactMatches(artifactDirectory, manifest);
    artifacts.push({ ...manifest, status: ready ? "ready" : "invalid" });
  }
  return artifacts.sort((left, right) => String(right.prepared_at || "").localeCompare(String(left.prepared_at || "")));
}

async function resolveInstalled(reference: ParsedHarnessReference, env: NodeJS.ProcessEnv): Promise<ResolvedRevision> {
  let discovered: DiscoveredAgent;
  try {
    discovered = await inspectAgent(reference.harness_id, { env });
  } catch (error) {
    throw new HitchError(`failed to inspect installed harness: ${reference.harness_id}`, {
      code: "resolution_failed",
      exitCode: 4,
      cause: error,
    });
  }
  if (discovered.status !== "available" || !discovered.executable || !discovered.identity) {
    throw new HitchError(`installed harness not found: ${reference.harness_id}`, {
      code: "revision_not_found",
      exitCode: 3,
    });
  }
  const identity = digest({
    harness_id: reference.harness_id,
    source_type: "installed",
    executable_identity: discovered.identity,
  });
  return {
    schema_version: SCHEMA_VERSION,
    requested_ref: reference.raw,
    canonical_ref: reference.canonical,
    harness_id: reference.harness_id,
    selector: { type: "installed" },
    source: {
      type: "installed",
      executable: discovered.executable,
      integrity: discovered.identity,
    },
    revision: {
      type: "installed",
      version: discovered.version || null,
    },
    identity,
    resolved_at: new Date().toISOString(),
  };
}

interface NpmViewResult {
  version: string;
  dist?: { integrity?: string; shasum?: string; tarball?: string };
}

async function resolveVersion(reference: ParsedHarnessReference, source: RevisionSourceDefinition, env: NodeJS.ProcessEnv): Promise<ResolvedRevision> {
  const npm = commandExecutable("npm", env);
  const packages = source.packages || [source.package];
  let result: { stdout: string; stderr: string } | undefined;
  let packageName: string | undefined;
  let notFoundError: unknown;
  for (const candidate of packages) {
    if (!candidate) continue;
    const spec = `${candidate}@${(reference.selector as { value: string }).value}`;
    try {
      result = await runCommand(npm, ["view", spec, "version", "dist", "--json"], {
        env,
        failureCode: "resolution_failed",
        failureExitCode: 4,
      });
      packageName = candidate;
      break;
    } catch (error) {
      if (!/E404|not found|No match/i.test((error as Error).message)) throw error;
      notFoundError = error;
    }
  }
  if (!result || !packageName) {
    throw new HitchError(`revision not found: ${reference.canonical}`, {
      code: "revision_not_found",
      exitCode: 3,
      cause: notFoundError,
    });
  }
  const spec = `${packageName}@${(reference.selector as { value: string }).value}`;
  let metadata: NpmViewResult;
  try {
    metadata = JSON.parse(result.stdout) as NpmViewResult;
  } catch (error) {
    throw new HitchError(`package registry returned invalid metadata for ${spec}`, {
      code: "resolution_failed",
      exitCode: 4,
      cause: error,
    });
  }
  const expectedVersion = (reference.selector as { value: string }).value;
  if (metadata.version !== expectedVersion) {
    throw new HitchError(`package registry resolved ${spec} as ${metadata.version || "an unknown version"}`, {
      code: "resolution_failed",
      exitCode: 4,
    });
  }
  const integrity = metadata.dist?.integrity || (metadata.dist?.shasum ? `sha1:${metadata.dist.shasum}` : "");
  if (!integrity || !metadata.dist?.tarball) {
    throw new HitchError(`package registry did not provide immutable distribution metadata for ${spec}`, {
      code: "resolution_failed",
      exitCode: 4,
    });
  }
  const identity = digest({
    harness_id: reference.harness_id,
    source_type: "npm",
    package: packageName,
    version: metadata.version,
    integrity,
  });
  return {
    schema_version: SCHEMA_VERSION,
    requested_ref: reference.raw,
    canonical_ref: reference.canonical,
    harness_id: reference.harness_id,
    selector: { type: "version", value: expectedVersion },
    source: {
      type: "npm",
      package: packageName,
      tarball: sanitizeUrl(metadata.dist.tarball),
      integrity,
    },
    revision: { type: "version", version: metadata.version },
    identity,
    resolved_at: new Date().toISOString(),
  };
}

async function resolveCommit(reference: ParsedHarnessReference, source: RevisionSourceDefinition, paths: StatePaths, env: NodeJS.ProcessEnv): Promise<ResolvedRevision> {
  const selector = reference.selector as Extract<RevisionSelector, { type: "commit" }>;
  const sourceUrl = selector.source?.url || source.url;
  if (!sourceUrl) {
    throw new HitchError(`no Git source registered for ${reference.harness_id}`, {
      code: "revision_selector_unsupported",
      exitCode: 10,
    });
  }
  const localPath = selector.source?.local_path;
  const git = commandExecutable("git", env);
  let fullCommit: string | undefined;
  if (localPath) {
    const statusResult = await runCommand(git, ["-C", localPath, "status", "--porcelain"], {
      env,
      failureCode: "resolution_failed",
      failureExitCode: 4,
    });
    if (statusResult.stdout.trim()) {
      throw new HitchError(`local harness repository has uncommitted changes: ${localPath}`, {
        code: "dirty_source",
        exitCode: 11,
      });
    }
    fullCommit = await revParseCommit(git, localPath, selector.value, env);
  }

  const cacheDirectory = gitCacheDirectory(paths, sourceUrl);
  const requestedCommit = fullCommit || selector.value;
  fullCommit = await withFileLock(paths.sourceLocks, digest(sourceUrl), async () => {
    await ensureGitCache(git, cacheDirectory, sourceUrl, env);
    if (requestedCommit.length >= 40) {
      await fetchCommit(git, cacheDirectory, sourceUrl, requestedCommit, env);
    } else {
      await fetchAdvertisedRefs(git, cacheDirectory, sourceUrl, env);
    }
    return revParseBareCommit(git, cacheDirectory, requestedCommit, env);
  }, { timeoutCode: "resolution_locked", timeoutExitCode: 4 });
  const normalizedSource = sanitizeUrl(sourceUrl);
  const identity = digest({
    harness_id: reference.harness_id,
    source_type: "git",
    source: normalizedSource,
    commit: fullCommit,
  });
  return {
    schema_version: SCHEMA_VERSION,
    requested_ref: reference.raw,
    canonical_ref: reference.canonical,
    harness_id: reference.harness_id,
    selector: { type: "commit", value: selector.value },
    source: {
      type: "git",
      url: normalizedSource,
      registered: !selector.source?.explicit,
    },
    revision: {
      type: "commit",
      requested_commit: selector.value,
      commit: fullCommit,
    },
    identity,
    resolved_at: new Date().toISOString(),
  };
}

async function prepareInstalled(resolved: ResolvedRevision, adapter: AdapterDefinition): Promise<PreparedArtifact> {
  const executable = resolved.source.executable;
  if (!executable) {
    throw new HitchError("installed resolution is missing its executable", { code: "artifact_integrity_mismatch", exitCode: 5 });
  }
  let currentIdentity: string;
  try {
    currentIdentity = await fingerprintExecutable(executable);
  } catch (error) {
    throw new HitchError(`installed harness is no longer readable: ${executable}`, {
      code: "artifact_integrity_mismatch",
      exitCode: 5,
      cause: error,
    });
  }
  if (currentIdentity !== resolved.source.integrity) {
    throw new HitchError(`installed harness changed after resolution: ${executable}`, {
      code: "artifact_integrity_mismatch",
      exitCode: 5,
    });
  }
  return {
    schema_version: SCHEMA_VERSION,
    artifact_id: digest({ revision_identity: resolved.identity, recipe_version: RECIPE_VERSION }),
    harness_id: resolved.harness_id,
    revision_identity: resolved.identity,
    source_type: "installed",
    adapter: adapter.id,
    adapter_version: RECIPE_VERSION,
    recipe_version: RECIPE_VERSION,
    platform: `${process.platform}-${process.arch}`,
    entrypoint: executable,
    launcher: "direct",
    entrypoint_integrity: currentIdentity,
    artifact_integrity: currentIdentity,
    toolchain: { node: process.version },
    resolved_revision: resolved,
    executable,
    entrypoint_args: [],
    observed_version: resolved.revision.version,
    external: true,
    cache_hit: true,
    prepared_at: resolved.resolved_at,
  } as PreparedArtifact;
}

async function prepareNpmArtifact(
  resolved: ResolvedRevision,
  adapter: AdapterDefinition,
  source: RevisionSourceDefinition,
  paths: StatePaths,
  preparationKey: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<PreparedArtifact> {
  const staging = await newStagingDirectory(paths, resolved.harness_id);
  try {
    await writeFile(path.join(staging, "package.json"), `${JSON.stringify({ private: true })}\n`, { mode: 0o600 });
    const npm = commandExecutable("npm", env);
    const tarball = resolved.source.tarball;
    if (!tarball) throw new HitchError("npm resolution is missing its tarball", { code: "prepare_failed", exitCode: 5 });
    await runCommand(npm, ["install", "--no-audit", "--no-fund", "--save-exact", tarball], {
      cwd: staging,
      env,
      signal,
      failureCode: "prepare_failed",
      failureExitCode: 5,
    });
    await assertNpmResolution(staging, resolved);
    const packageName = resolved.source.package;
    if (!packageName) throw new HitchError("npm resolution is missing its package name", { code: "prepare_failed", exitCode: 5 });
    const binName = source.bin;
    if (!binName) throw new HitchError("npm revision source is missing its bin name", { code: "prepare_failed", exitCode: 5 });
    const entrypoint = await npmPackageEntrypoint(staging, packageName, binName);
    const stagedExecutable = path.join(staging, entrypoint);
    await assertEntrypoint(stagedExecutable, entrypointLauncher(entrypoint), resolved.canonical_ref);
    const lockIdentity = await optionalFileDigest(path.join(staging, "package-lock.json"));
    const toolchain: Record<string, string> = { node: process.version, npm: await commandVersion(npm, env, signal) };
    const launcher = entrypointLauncher(entrypoint);
    const invocation = artifactInvocation({ entrypoint, launcher }, staging);
    const observedVersion = await detectVersion(invocation.executable, [...invocation.entrypoint_args, ...adapter.version_args]);
    throwIfAborted(signal);
    assertObservedVersion(observedVersion, (resolved.revision.version as string) || "", resolved.canonical_ref);
    const entrypointIntegrity = await fingerprintExecutable(stagedExecutable);
    const artifactIntegrity = await artifactDirectoryIntegrity(staging);
    const artifactId = digest({
      preparation_key: preparationKey,
      dependency_lock: lockIdentity,
      toolchain,
      artifact_integrity: artifactIntegrity,
    });
    const manifest = artifactManifest(resolved, adapter, artifactId, entrypoint, toolchain, {
      dependency_lock: lockIdentity,
      artifact_integrity: artifactIntegrity,
    });
    manifest.launcher = launcher;
    manifest.observed_version = observedVersion || null;
    manifest.entrypoint_integrity = entrypointIntegrity;
    await atomicWriteJSON(path.join(staging, "artifact.json"), manifest);
    return promoteArtifact(paths, staging, manifest, preparationKey);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw normalizePreparationError(error, resolved.canonical_ref);
  }
}

async function prepareGitArtifact(
  resolved: ResolvedRevision,
  adapter: AdapterDefinition,
  source: RevisionSourceDefinition,
  paths: StatePaths,
  preparationKey: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<PreparedArtifact> {
  const staging = await newStagingDirectory(paths, resolved.harness_id);
  const sourceDirectory = path.join(staging, "source");
  try {
    const git = commandExecutable("git", env);
    const cacheDirectory = gitCacheDirectory(paths, resolved.source.url || "");
    await runCommand(git, ["clone", "--no-hardlinks", "--no-checkout", cacheDirectory, sourceDirectory], {
      env,
      signal,
      failureCode: "prepare_failed",
      failureExitCode: 5,
    });
    await runCommand(git, ["-C", sourceDirectory, "checkout", "--detach", resolved.revision.commit as string], {
      env,
      signal,
      failureCode: "prepare_failed",
      failureExitCode: 5,
    });
    const toolchain: Record<string, string> = { node: process.version };
    for (const command of source.commands || []) {
      const executable = commandExecutable(command.executable, env);
      toolchain[command.executable] ||= await commandVersion(executable, env, signal);
      await runCommand(executable, command.args || [], {
        cwd: path.resolve(sourceDirectory, command.cwd || "."),
        env,
        signal,
        failureCode: "prepare_failed",
        failureExitCode: 5,
      });
    }
    const entrypoint = path.join("source", source.entrypoint || "");
    const stagedExecutable = path.join(staging, entrypoint);
    if (stagedExecutable.endsWith(".js")) await chmod(stagedExecutable, 0o755).catch(() => {});
    await assertEntrypoint(stagedExecutable, entrypointLauncher(entrypoint), resolved.canonical_ref);
    const lockIdentity = await sourceLockIdentity(sourceDirectory);
    await rm(path.join(sourceDirectory, ".git"), { recursive: true, force: true });
    const launcher = entrypointLauncher(entrypoint);
    const invocation = artifactInvocation({ entrypoint, launcher }, staging);
    const observedVersion = await detectVersion(invocation.executable, [...invocation.entrypoint_args, ...adapter.version_args]);
    throwIfAborted(signal);
    const entrypointIntegrity = await fingerprintExecutable(stagedExecutable);
    const artifactIntegrity = await artifactDirectoryIntegrity(staging);
    const artifactId = digest({
      preparation_key: preparationKey,
      dependency_lock: lockIdentity,
      toolchain,
      artifact_integrity: artifactIntegrity,
    });
    const manifest = artifactManifest(resolved, adapter, artifactId, entrypoint, toolchain, {
      dependency_lock: lockIdentity,
      artifact_integrity: artifactIntegrity,
    });
    manifest.launcher = launcher;
    manifest.observed_version = observedVersion || null;
    manifest.entrypoint_integrity = entrypointIntegrity;
    await atomicWriteJSON(path.join(staging, "artifact.json"), manifest);
    return promoteArtifact(paths, staging, manifest, preparationKey);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw normalizePreparationError(error, resolved.canonical_ref);
  }
}

function artifactManifest(
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

async function promoteArtifact(paths: StatePaths, staging: string, manifest: ArtifactManifest, preparationKey: string): Promise<PreparedArtifact> {
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

async function readCachedArtifact(paths: StatePaths, preparationKey: string, expectedRevisionIdentity: string): Promise<PreparedArtifact | null> {
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

async function ensureGitCache(git: string, directory: string, sourceUrl: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await access(path.join(directory, "HEAD"));
    try {
      await runCommand(git, ["--git-dir", directory, "remote", "set-url", "origin", sourceUrl], {
        env,
        failureCode: "resolution_failed",
        failureExitCode: 4,
      });
    } catch {
      await runCommand(git, ["--git-dir", directory, "remote", "add", "origin", sourceUrl], {
        env,
        failureCode: "resolution_failed",
        failureExitCode: 4,
      });
    }
    return;
  } catch (error) {
    if (error instanceof HitchError) throw error;
  }
  await ensureDir(path.dirname(directory));
  await runCommand(git, ["init", "--bare", directory], {
    env,
    failureCode: "resolution_failed",
    failureExitCode: 4,
  });
  await runCommand(git, ["--git-dir", directory, "remote", "add", "origin", sourceUrl], {
    env,
    failureCode: "resolution_failed",
    failureExitCode: 4,
  });
}

async function fetchCommit(git: string, cacheDirectory: string, sourceUrl: string, commit: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await runCommand(git, ["--git-dir", cacheDirectory, "fetch", "--no-tags", "origin", commit], {
      env,
      failureCode: "revision_not_found",
      failureExitCode: 3,
    });
  } catch {
    await fetchAdvertisedRefs(git, cacheDirectory, sourceUrl, env);
  }
}

async function fetchAdvertisedRefs(git: string, cacheDirectory: string, _sourceUrl: string, env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand(git, [
    "--git-dir", cacheDirectory,
    "fetch", "--force", "origin",
    "+refs/heads/*:refs/remotes/origin/*",
    "+refs/tags/*:refs/tags/*",
  ], {
    env,
    failureCode: "resolution_failed",
    failureExitCode: 4,
  });
}

async function revParseCommit(git: string, directory: string, commit: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const result = await runCommand(git, ["-C", directory, "rev-parse", "--verify", `${commit}^{commit}`], {
      env,
      failureCode: "revision_not_found",
      failureExitCode: 3,
    });
    return result.stdout.trim().toLowerCase();
  } catch (error) {
    throw new HitchError(`revision not found or ambiguous: ${commit}`, {
      code: "revision_not_found",
      exitCode: 3,
      cause: error,
    });
  }
}

async function revParseBareCommit(git: string, directory: string, commit: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const result = await runCommand(git, ["--git-dir", directory, "rev-parse", "--verify", `${commit}^{commit}`], {
      env,
      failureCode: "revision_not_found",
      failureExitCode: 3,
    });
    return result.stdout.trim().toLowerCase();
  } catch (error) {
    throw new HitchError(`revision not found or ambiguous: ${commit}`, {
      code: "revision_not_found",
      exitCode: 3,
      cause: error,
    });
  }
}

async function withArtifactLock(
  paths: StatePaths,
  key: string,
  operation: () => Promise<PreparedArtifact>,
  options: { signal?: AbortSignal } = {},
): Promise<PreparedArtifact> {
  return withFileLock(paths.artifactLocks, key, operation, options);
}

interface LockOptions {
  timeoutCode?: string;
  timeoutExitCode?: number;
  signal?: AbortSignal | undefined;
}

async function withFileLock<T>(
  directory: string,
  key: string,
  operation: () => Promise<T>,
  {
    timeoutCode = "prepare_locked",
    timeoutExitCode = 5,
    signal,
  }: LockOptions = {},
): Promise<T> {
  await ensureDir(directory);
  const file = path.join(directory, `${key.replace("sha256:", "")}.lock`);
  const owner = randomBytes(12).toString("hex");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    throwIfAborted(signal);
    try {
      handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ owner, pid: process.pid, created_at: new Date().toISOString() })}\n`);
      } catch (error) {
        await handle.close().catch(() => {});
        handle = undefined;
        await removeIfExists(file);
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      if (await staleLock(file)) {
        if (!await reclaimStaleLock(file, staleLock)) await delay(100);
        continue;
      }
      await delay(100);
    }
  }
  if (!handle) throw new HitchError("timed out waiting for Hitch state lock", { code: timeoutCode, exitCode: timeoutExitCode });
  try {
    throwIfAborted(signal);
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    const current = await readJSON<{ owner?: unknown } | null>(file, null).catch(() => null);
    if (current?.owner === owner) await removeIfExists(file);
  }
}

async function staleLock(file: string): Promise<boolean> {
  let lock: { pid?: unknown } | null;
  try {
    lock = await readJSON<{ pid?: unknown }>(file);
  } catch {
    try {
      return Date.now() - (await stat(file)).mtimeMs > 2_000;
    } catch {
      return true;
    }
  }
  if (!Number.isInteger(lock?.pid)) return true;
  try {
    process.kill(lock.pid as number, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  failureCode?: string;
  failureExitCode?: number;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

async function runCommand(executable: string, args: string[], {
  cwd,
  env = process.env,
  failureCode = "internal_error",
  failureExitCode = 12,
  timeoutMs = COMMAND_TIMEOUT_MS,
  signal,
}: RunCommandOptions = {}): Promise<CommandResult> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    let settled = false;
    const append = (current: string, chunk: Buffer | string) => `${current}${chunk}`.slice(-1_000_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => terminateProcess(child).catch(() => {}), timeoutMs);
    timer.unref?.();
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      callback();
    };
    const abortHandler = () => {
      aborted = true;
      terminateProcess(child).catch(() => {});
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    child.once("error", (error: Error) => {
      finish(() => reject(new HitchError(`failed to start ${path.basename(executable)}: ${error.message}`, {
        code: failureCode,
        exitCode: failureExitCode,
        cause: error,
      })));
    });
    child.once("close", (code: number | null, processSignal: NodeJS.Signals | null) => {
      if (aborted) return finish(() => reject(cancelledError()));
      if (code === 0) return finish(() => resolve({ stdout, stderr }));
      const detail = stderr.trim() || stdout.trim();
      finish(() => reject(new HitchError(
        `${path.basename(executable)} exited with code ${code ?? "null"}${processSignal ? ` (${processSignal})` : ""}${detail ? `: ${detail}` : ""}`,
        { code: failureCode, exitCode: failureExitCode },
      )));
    });
  });
}

function commandExecutable(command: string, env: NodeJS.ProcessEnv): string {
  const override = {
    npm: "HITCH_NPM_PATH",
    git: "HITCH_GIT_PATH",
    cargo: "HITCH_CARGO_PATH",
    bun: "HITCH_BUN_PATH",
    pnpm: "HITCH_PNPM_PATH",
  }[command];
  return override && env[override]?.trim() ? env[override].trim() : command;
}

async function commandVersion(executable: string, env: NodeJS.ProcessEnv, signal: AbortSignal | undefined): Promise<string> {
  try {
    return (await runCommand(executable, ["--version"], { env, signal, timeoutMs: 5_000 })).stdout.trim() || "unknown";
  } catch (error) {
    if ((error as HitchError)?.code === "cancelled") throw error;
    return "unknown";
  }
}

function recipeIdentity(source: RevisionSourceDefinition): Record<string, unknown> {
  return {
    type: source.type,
    package: source.package,
    packages: source.packages,
    bin: source.bin,
    url: source.url,
    commands: source.commands,
    entrypoint: source.entrypoint,
  };
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJSON(value)).digest("hex")}`;
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}

function gitCacheDirectory(paths: StatePaths, sourceUrl: string): string {
  const key = createHash("sha256").update(sourceUrl).digest("hex");
  return path.join(paths.sourceCache, `git-${key}`);
}

async function newStagingDirectory(paths: StatePaths, harnessId: string): Promise<string> {
  await ensureDir(paths.temporary);
  const directory = path.join(paths.temporary, `${harnessId}-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`);
  await ensureDir(directory);
  return directory;
}

async function npmPackageEntrypoint(directory: string, packageName: string, binName: string): Promise<string> {
  const packageDirectory = path.join(directory, "node_modules", ...packageName.split("/"));
  let metadata: { bin?: string | Record<string, unknown> };
  try {
    metadata = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8")) as { bin?: string | Record<string, unknown> };
  } catch (error) {
    throw new HitchError(`installed package has no readable package.json: ${packageName}`, {
      code: "artifact_invalid",
      exitCode: 5,
      cause: error,
    });
  }
  const binTarget = typeof metadata.bin === "string" ? metadata.bin : (metadata.bin as Record<string, unknown> | undefined)?.[binName];
  if (typeof binTarget !== "string" || !binTarget) {
    throw new HitchError(`installed package does not declare the ${binName} executable: ${packageName}`, {
      code: "artifact_invalid",
      exitCode: 5,
    });
  }
  const absolute = path.resolve(packageDirectory, binTarget);
  if (absolute !== packageDirectory && !absolute.startsWith(`${packageDirectory}${path.sep}`)) {
    throw new HitchError(`package executable escapes its installation directory: ${packageName}`, {
      code: "artifact_invalid",
      exitCode: 5,
    });
  }
  return path.relative(directory, absolute);
}

function entrypointLauncher(entrypoint: string): string {
  return /\.(?:cjs|mjs|js)$/i.test(entrypoint) ? "node" : "direct";
}

function artifactInvocation(manifest: { entrypoint: string; launcher?: string }, directory: string): ArtifactInvocation {
  const entrypoint = path.join(directory, manifest.entrypoint);
  return manifest.launcher === "node"
    ? { executable: process.execPath, entrypoint_args: [entrypoint] }
    : { executable: entrypoint, entrypoint_args: [] };
}

async function assertEntrypoint(file: string, launcher: string, reference: string): Promise<void> {
  try {
    await access(file, launcher === "node" ? constants.R_OK : constants.X_OK);
    const info = await stat(file);
    if (!info.isFile()) throw new Error("entrypoint is not a file");
  } catch (error) {
    throw new HitchError(`prepared artifact has no executable entrypoint for ${reference}: ${file}`, {
      code: "artifact_invalid",
      exitCode: 5,
      cause: error,
    });
  }
}

async function optionalFileDigest(file: string): Promise<string | null> {
  try {
    return `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertNpmResolution(directory: string, resolved: ResolvedRevision): Promise<void> {
  let lock: { packages?: Record<string, { version?: string; integrity?: string }> };
  try {
    lock = JSON.parse(await readFile(path.join(directory, "package-lock.json"), "utf8")) as typeof lock;
  } catch (error) {
    throw new HitchError(`npm did not produce a readable dependency lock for ${resolved.canonical_ref}`, {
      code: "artifact_invalid",
      exitCode: 5,
      cause: error,
    });
  }
  const packageName = resolved.source.package;
  const installed = packageName ? lock.packages?.[`node_modules/${packageName}`] : undefined;
  if (installed?.version !== resolved.revision.version || installed?.integrity !== resolved.source.integrity) {
    throw new HitchError(`installed package integrity does not match the resolution for ${resolved.canonical_ref}`, {
      code: "artifact_integrity_mismatch",
      exitCode: 5,
    });
  }
}

async function sourceLockIdentity(directory: string): Promise<string | null> {
  const candidates = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "bun.lock", path.join("codex-rs", "Cargo.lock")];
  const locks: Record<string, string> = {};
  for (const candidate of candidates) {
    const identity = await optionalFileDigest(path.join(directory, candidate));
    if (identity) locks[candidate] = identity;
  }
  return Object.keys(locks).length > 0 ? digest(locks) : null;
}

function normalizePreparationError(error: unknown, reference: string): HitchError {
  if (error instanceof HitchError) return error;
  return new HitchError(`failed to prepare ${reference}: ${(error as Error)?.message || String(error)}`, {
    code: "prepare_failed",
    exitCode: 5,
    cause: error,
  });
}

async function executableMatches(executable: string, identity: string): Promise<boolean> {
  try {
    return await fingerprintExecutable(executable) === identity;
  } catch {
    return false;
  }
}

async function artifactMatches(directory: string, manifest: ArtifactManifest): Promise<boolean> {
  if (!manifest?.entrypoint || !manifest.entrypoint_integrity || !manifest.artifact_integrity) return false;
  const root = path.resolve(directory);
  const executable = path.resolve(root, manifest.entrypoint);
  if (executable !== root && !executable.startsWith(`${root}${path.sep}`)) return false;
  if (!await executableMatches(executable, manifest.entrypoint_integrity)) return false;
  try {
    return await artifactDirectoryIntegrity(directory) === manifest.artifact_integrity;
  } catch {
    return false;
  }
}

async function artifactDirectoryIntegrity(directory: string): Promise<string> {
  const root = path.resolve(directory);
  const hash = createHash("sha256");
  await digestArtifactDirectory(hash, root, root, "", true);
  return `sha256:${hash.digest("hex")}`;
}

async function digestArtifactDirectory(hash: ReturnType<typeof createHash>, root: string, directory: string, relative: string, topLevel: boolean): Promise<void> {
  const entries = await readdir(directory);
  entries.sort();
  for (const name of entries) {
    if (topLevel && name === "artifact.json") continue;
    const absolute = path.join(directory, name);
    const childRelative = relative ? path.join(relative, name) : name;
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      hash.update(`d\0${childRelative}\0${info.mode & 0o7777}\0`);
      await digestArtifactDirectory(hash, root, absolute, childRelative, false);
    } else if (info.isFile()) {
      hash.update(`f\0${childRelative}\0${info.mode & 0o7777}\0${info.size}\0`);
      for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer);
      hash.update("\0");
    } else if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      const resolvedTarget = path.resolve(path.dirname(absolute), target);
      if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${path.sep}`)) {
        throw new HitchError(`artifact symlink escapes its installation directory: ${absolute}`, {
          code: "artifact_invalid",
          exitCode: 5,
        });
      }
      hash.update(`l\0${childRelative}\0${target}\0`);
    } else {
      throw new HitchError(`unsupported special file in prepared artifact: ${absolute}`, {
        code: "artifact_invalid",
        exitCode: 5,
      });
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError();
}

function cancelledError(): HitchError {
  return new HitchError("harness preparation cancelled", { code: "cancelled", exitCode: 9 });
}

function assertObservedVersion(observed: string, expected: string, reference: string): void {
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!observed || !new RegExp(`(?:^|\\s)v?${escaped}(?:\\s|$)`).test(observed)) {
    throw new HitchError(`prepared artifact for ${reference} reported ${observed || "no version"}; expected ${expected}`, {
      code: "artifact_invalid",
      exitCode: 5,
    });
  }
}
