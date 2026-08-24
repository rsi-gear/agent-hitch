import { randomBytes } from "node:crypto";
import { chmod, lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAdapter } from "../adapters/index.js";
import type { AdapterDefinition, RevisionSourceDefinition } from "../adapters/index.js";
import { SCHEMA_VERSION, HitchError, atomicWriteJSON, commandExecutable, commandVersion, detectVersion, digest, ensureDir, fingerprintExecutable, readJSON, runCommand, statePaths } from "../foundation/index.js";
import type { StatePaths } from "../foundation/index.js";
import { gitCacheDirectory } from "../revisions/index.js";
import type { ResolvedRevision, VerifiedLocalGitSource } from "../revisions/index.js";
import { artifactDirectoryIntegrity, artifactInvocation, artifactMatches, assertEntrypoint, assertGlobalNpmResolution, assertNpmResolution, entrypointLauncher, npmPackageEntrypoint, optionalFileDigest, sourceLockIdentity } from "./integrity.js";
import { artifactManifest, promoteArtifact, readCachedArtifact, withArtifactLock } from "./store.js";
import type { ArtifactManifest, ListedArtifact, PreparedArtifact } from "./types.js";

const RECIPE_VERSION = "1";

export async function prepareHarness(
  resolved: ResolvedRevision,
  { root, env = process.env, signal, verifiedLocalGitSource }: {
    root?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    verifiedLocalGitSource?: VerifiedLocalGitSource;
  } = {},
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
  if (verifiedLocalGitSource) await assertVerifiedLocalGitSource(resolved, verifiedLocalGitSource, env, signal);
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
      : prepareGitArtifact(resolved, adapter, source, paths, preparationKey, env, signal, verifiedLocalGitSource?.directory);
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
    const npm = commandExecutable("npm", env);
    const tarball = resolved.source.tarball;
    if (!tarball) throw new HitchError("npm resolution is missing its tarball", { code: "prepare_failed", exitCode: 5 });
    const installMode = source.install_mode || "project";
    let nodeModulesDirectory = "node_modules";
    let lockIdentity: string | null;
    if (installMode === "global") {
      const packedTarball = await packResolvedNpmTarball(npm, staging, resolved, env, signal);
      try {
        await runCommand(npm, ["install", "--global", "--prefix", staging, "--no-audit", "--no-fund", packedTarball], {
          env,
          signal,
          failureCode: "prepare_failed",
          failureExitCode: 5,
        });
      } finally {
        await rm(packedTarball, { force: true });
      }
      nodeModulesDirectory = path.join("lib", "node_modules");
      await assertGlobalNpmResolution(staging, resolved);
      lockIdentity = digest({
        package: resolved.source.package,
        version: resolved.revision.version,
        integrity: resolved.source.integrity,
      });
    } else {
      await writeFile(path.join(staging, "package.json"), `${JSON.stringify({ private: true })}\n`, { mode: 0o600 });
      await runCommand(npm, ["install", "--no-audit", "--no-fund", "--save-exact", tarball], {
        cwd: staging,
        env,
        signal,
        failureCode: "prepare_failed",
        failureExitCode: 5,
      });
      await assertNpmResolution(staging, resolved);
      lockIdentity = await optionalFileDigest(path.join(staging, "package-lock.json"));
    }
    const packageName = resolved.source.package;
    if (!packageName) throw new HitchError("npm resolution is missing its package name", { code: "prepare_failed", exitCode: 5 });
    const binName = source.bin;
    if (!binName) throw new HitchError("npm revision source is missing its bin name", { code: "prepare_failed", exitCode: 5 });
    const entrypoint = await npmPackageEntrypoint(staging, packageName, binName, nodeModulesDirectory);
    const stagedExecutable = path.join(staging, entrypoint);
    await assertEntrypoint(stagedExecutable, entrypointLauncher(entrypoint), resolved.canonical_ref);
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
  verifiedSourceDirectory?: string,
): Promise<PreparedArtifact> {
  const staging = await newStagingDirectory(paths, resolved.harness_id);
  const sourceDirectory = path.join(staging, "source");
  try {
    const git = commandExecutable("git", env);
    const sourceRepository = verifiedSourceDirectory || gitCacheDirectory(paths, resolved.source.url || "");
    await runCommand(git, ["clone", "--no-hardlinks", "--no-checkout", sourceRepository, sourceDirectory], {
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

async function assertVerifiedLocalGitSource(
  resolved: ResolvedRevision,
  verified: VerifiedLocalGitSource,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (resolved.source.type !== "git" || resolved.source.registered !== false || resolved.revision.type !== "commit") {
    throw new HitchError("verified local Git source cannot be used with this resolution", { code: "local_source_integrity_mismatch", exitCode: 12 });
  }
  if (verified.resolutionIdentity !== resolved.identity || verified.commit !== resolved.revision.commit) {
    throw new HitchError("verified local Git source does not match the locked resolution", { code: "local_source_integrity_mismatch", exitCode: 12 });
  }
  const info = await lstat(verified.directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new HitchError("verified local Git source is not a directory", { code: "local_source_integrity_mismatch", exitCode: 12 });
  }
  const git = commandExecutable("git", env);
  const commitResult = await runCommand(git, ["-C", verified.directory, "rev-parse", "--verify", `${verified.commit}^{commit}`], {
    env,
    signal,
    failureCode: "local_source_integrity_mismatch",
    failureExitCode: 12,
  });
  const treeResult = await runCommand(git, ["-C", verified.directory, "rev-parse", "--verify", `${verified.commit}^{tree}`], {
    env,
    signal,
    failureCode: "local_source_integrity_mismatch",
    failureExitCode: 12,
  });
  if (commitResult.stdout.trim().toLowerCase() !== verified.commit || treeResult.stdout.trim().toLowerCase() !== verified.tree) {
    throw new HitchError("verified local Git source commit or tree changed", { code: "local_source_integrity_mismatch", exitCode: 12 });
  }
}

function recipeIdentity(source: RevisionSourceDefinition): Record<string, unknown> {
  return {
    type: source.type,
    package: source.package,
    packages: source.packages,
    bin: source.bin,
    install_mode: source.install_mode,
    url: source.url,
    commands: source.commands,
    entrypoint: source.entrypoint,
  };
}

async function newStagingDirectory(paths: StatePaths, harnessId: string): Promise<string> {
  await ensureDir(paths.temporary);
  const directory = path.join(paths.temporary, `${harnessId}-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`);
  await ensureDir(directory);
  return directory;
}

interface NpmPackResult {
  name?: string;
  version?: string;
  integrity?: string;
  filename?: string;
}

async function packResolvedNpmTarball(
  npm: string,
  directory: string,
  resolved: ResolvedRevision,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<string> {
  const tarball = resolved.source.tarball;
  if (!tarball) throw new HitchError("npm resolution is missing its tarball", { code: "prepare_failed", exitCode: 5 });
  const result = await runCommand(npm, ["pack", "--json", "--pack-destination", directory, tarball], {
    env,
    signal,
    failureCode: "prepare_failed",
    failureExitCode: 5,
  });
  let packed: NpmPackResult | undefined;
  try {
    const records = JSON.parse(result.stdout) as NpmPackResult[];
    if (Array.isArray(records) && records.length === 1) packed = records[0];
  } catch {
    // The validation error below includes the resolved reference without exposing npm output.
  }
  const filename = packed?.filename;
  if (
    packed?.name !== resolved.source.package
    || packed?.version !== resolved.revision.version
    || packed?.integrity !== resolved.source.integrity
    || typeof filename !== "string"
    || !filename
    || path.basename(filename) !== filename
  ) {
    throw new HitchError(`packed package integrity does not match the resolution for ${resolved.canonical_ref}`, {
      code: "artifact_integrity_mismatch",
      exitCode: 5,
    });
  }
  const archive = path.join(directory, filename);
  try {
    if (!(await lstat(archive)).isFile()) throw new Error("packed archive is not a file");
  } catch (error) {
    throw new HitchError(`npm did not produce a readable package archive for ${resolved.canonical_ref}`, {
      code: "artifact_invalid",
      exitCode: 5,
      cause: error,
    });
  }
  return archive;
}

function normalizePreparationError(error: unknown, reference: string): HitchError {
  if (error instanceof HitchError) return error;
  return new HitchError(`failed to prepare ${reference}: ${(error as Error)?.message || String(error)}`, {
    code: "prepare_failed",
    exitCode: 5,
    cause: error,
  });
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
