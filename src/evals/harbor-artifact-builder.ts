import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { artifactMatches } from "../artifacts/index.js";
import type { ArtifactManifest, ResolvedRevision } from "../artifacts/index.js";
import { HARBOR_NODE_VERSION_WITH_PREFIX, HARBOR_PNPM_VERSION, verifyLocalGitTransport } from "../backends/index.js";
import type { HarborPreparedArtifactUse, LocalGitTransportUse } from "../backends/index.js";
import type { HarborTrialRuntimeContract } from "../backends/index.js";
import type { VerifiedLocalGitSource } from "../domain/index.js";
import {
  HitchError,
  atomicWriteJSON,
  digest,
  ensureDir,
  hitchRootId,
  readJSON,
  runCommand,
  statePaths,
  withFileLock,
} from "../foundation/index.js";
import { HARBOR_ARTIFACT_BUILDER_RECIPE_VERSION, ensureHarborArtifactBuilderImage } from "./harbor-artifact-builder-image.js";
import type { HarborBuilderImage } from "./harbor-artifact-builder-image.js";

export interface HarborArtifactPreparationResult {
  artifact: HarborPreparedArtifactUse;
  cacheHit: boolean;
  source: "dedicated-builder" | "test-host";
  builderImage?: string;
  builderImageId?: string;
}

export type EvalHarborArtifactBuilder = (input: {
  root: string;
  resolvedRevision: ResolvedRevision;
  runtimeDirectory: string;
  runtimeId: string;
  runtimeContract: HarborTrialRuntimeContract;
  localTransport?: LocalGitTransportUse;
  verifiedLocalGitSource?: VerifiedLocalGitSource;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}) => Promise<HarborArtifactPreparationResult>;

interface ArtifactExpectation {
  harnessId: string;
  revisionIdentity: string;
  platform: string;
}

export const prepareHarborArtifact: EvalHarborArtifactBuilder = async (input) => {
  if (input.localTransport) {
    await verifyLocalGitTransport(input.localTransport, {
      expected: {
        harnessId: input.resolvedRevision.harness_id,
        resolutionIdentity: input.resolvedRevision.identity,
        commit: input.localTransport.manifest.commit,
      },
      ...(input.signal ? { signal: input.signal } : {}),
      env: input.env,
    });
  }
  const docker = input.env.HITCH_DOCKER_PATH?.trim() || "docker";
  const cache = await harborArtifactCache(input.root);
  const builder = await ensureHarborArtifactBuilderImage({
    root: input.root,
    cache,
    docker,
    dockerPlatform: input.runtimeContract.dockerPlatform,
    env: input.env,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (builder.artifactPlatform !== input.runtimeContract.artifactPlatform
    || input.runtimeContract.nodeVersion !== HARBOR_NODE_VERSION_WITH_PREFIX) {
    throw new HitchError("Harbor artifact builder does not match the planner-pinned trial runtime", {
      code: "harbor_artifact_builder_contract_mismatch",
      exitCode: 12,
    });
  }
  const key = digest({
    kind: "harbor-artifact-builder",
    recipe_version: HARBOR_ARTIFACT_BUILDER_RECIPE_VERSION,
    controller_runtime_id: input.runtimeId,
    revision_identity: input.resolvedRevision.identity,
    builder_image_id: builder.id,
    platform: input.runtimeContract.artifactPlatform,
    node: input.runtimeContract.nodeVersion,
    pnpm: HARBOR_PNPM_VERSION,
  });
  const expected: ArtifactExpectation = {
    harnessId: input.resolvedRevision.harness_id,
    revisionIdentity: input.resolvedRevision.identity,
    platform: input.runtimeContract.artifactPlatform,
  };
  const artifact = await withFileLock(cache.locks, key, async () => {
    const cached = await readCachedArtifact(cache, key, expected);
    if (cached) return { artifact: cached, cacheHit: true };
    const prepared = await buildArtifact({ ...input, cache, docker, builder });
    try {
      const promoted = await promoteArtifact(cache, prepared.directory, prepared.manifest, expected);
      await atomicWriteJSON(path.join(cache.refs, `${key.slice("sha256:".length)}.json`), {
        schema_version: "1",
        preparation_key: key,
        artifact_id: promoted.artifact_id,
        controller_runtime_id: input.runtimeId,
        builder_image_id: builder.id,
        node_version: HARBOR_NODE_VERSION_WITH_PREFIX,
        pnpm_version: HARBOR_PNPM_VERSION,
      });
      return { artifact: promoted, cacheHit: false };
    } finally {
      await rm(prepared.stagingRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, {
    timeoutCode: "harbor_artifact_builder_locked",
    timeoutExitCode: 12,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return {
    ...artifact,
    source: "dedicated-builder",
    builderImage: builder.reference,
    builderImageId: builder.id,
  };
};

export function harborArtifactDirectory(root: string, artifactId: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(artifactId)) {
    throw new HitchError(`invalid Harbor artifact ID: ${artifactId}`, { code: "artifact_invalid", exitCode: 5 });
  }
  return path.join(statePaths(root).store, "harbor-artifacts", "artifacts", artifactId.slice("sha256:".length));
}

export async function loadHarborArtifact(
  root: string,
  summary: {
    artifact_id: string;
    artifact_integrity: string;
    entrypoint_integrity: string;
    harness_id: string;
    revision_identity: string;
    platform: string;
  },
): Promise<HarborPreparedArtifactUse> {
  const directory = harborArtifactDirectory(root, summary.artifact_id);
  const manifest = await verifyArtifact(directory, {
    harnessId: summary.harness_id,
    revisionIdentity: summary.revision_identity,
    platform: summary.platform,
  });
  if (manifest.artifact_integrity !== summary.artifact_integrity
    || manifest.entrypoint_integrity !== summary.entrypoint_integrity) {
    throw new HitchError("Harbor artifact no longer matches the eval-pinned integrity", {
      code: "artifact_integrity_mismatch",
      exitCode: 5,
    });
  }
  return artifactUse(directory, manifest);
}

async function harborArtifactCache(root: string): Promise<{
  root: string;
  artifacts: string;
  locks: string;
  temporary: string;
  invalid: string;
  refs: string;
}> {
  const rootDirectory = await ensureDir(path.join(statePaths(root).store, "harbor-artifacts"));
  const [artifacts, locks, temporary, invalid, refs] = await Promise.all([
    ensureDir(path.join(rootDirectory, "artifacts")),
    ensureDir(path.join(rootDirectory, "locks")),
    ensureDir(path.join(rootDirectory, "tmp")),
    ensureDir(path.join(rootDirectory, "invalid")),
    ensureDir(path.join(rootDirectory, "refs")),
  ]);
  return { root: rootDirectory, artifacts, locks, temporary, invalid, refs };
}

async function buildArtifact(input: {
  root: string;
  resolvedRevision: ResolvedRevision;
  runtimeDirectory: string;
  runtimeId: string;
  localTransport?: LocalGitTransportUse;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  cache: Awaited<ReturnType<typeof harborArtifactCache>>;
  docker: string;
  builder: HarborBuilderImage;
}): Promise<{ directory: string; manifest: ArtifactManifest; stagingRoot: string }> {
  const entrypoint = await controllerEntrypoint(input.runtimeDirectory, input.runtimeId);
  const state = await mkdtemp(path.join(input.cache.temporary, "artifact-build-"));
  const containerName = `hitch-artifact-builder-${process.pid}-${randomBytes(6).toString("hex")}`;
  let completed = false;
  try {
    const args = [
      "run", "--name", containerName,
      "--platform", input.builder.dockerPlatform,
      "--label", "io.hitch.harbor-artifact-builder=true",
      "--label", `io.hitch.root-id=${hitchRootId(input.root)}`,
      // Clone/install/build on the container's native Linux filesystem. A
      // bind-mounted macOS/Windows state root changes filesystem semantics and
      // can make pnpm copyfile fail before an artifact exists.
      "--env", "HITCH_ROOT=/tmp/hitch-state",
      "--env", "HOME=/tmp/hitch-builder-home",
      "--mount", bindMount(path.join(input.runtimeDirectory, "payload"), "/opt/hitch", true),
    ];
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const gid = typeof process.getgid === "function" ? process.getgid() : null;
    if (uid !== null && gid !== null) args.push("--user", `${uid}:${gid}`);
    if (input.localTransport) {
      args.push("--env", "HITCH_HARBOR_INTERNAL=1");
      args.push("--mount", bindMount(input.localTransport.directory, "/hitch-local-source-input", true));
    }
    args.push(input.builder.reference, "sh", "-ceu", builderScript(Boolean(input.localTransport)), "sh", `/opt/hitch/${entrypoint}`, lockedHarnessRef(input.resolvedRevision));
    if (input.localTransport) {
      args.push(
        input.localTransport.manifest.commit,
        input.localTransport.manifest.tree,
        input.localTransport.manifest.payload_sha256,
        String(input.localTransport.manifest.payload_bytes),
      );
    }
    const result = await runCommand(input.docker, args, {
      env: input.env,
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: 30 * 60 * 1_000,
      failureCode: "harbor_artifact_build_failed",
      failureExitCode: 12,
    });
    const payload = parsePrepareOutput(result.stdout);
    const artifactId = payload.artifact_id;
    const artifacts = path.join(state, "store", "artifacts");
    await mkdir(artifacts, { recursive: true });
    await runCommand(input.docker, [
      "cp",
      `${containerName}:/tmp/hitch-state/store/artifacts/${artifactId.slice("sha256:".length)}`,
      artifacts,
    ], {
      env: input.env,
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: 10 * 60 * 1_000,
      failureCode: "harbor_artifact_export_failed",
      failureExitCode: 12,
    });
    const directory = path.join(state, "store", "artifacts", artifactId.slice("sha256:".length));
    const manifest = await verifyArtifact(directory, {
      harnessId: input.resolvedRevision.harness_id,
      revisionIdentity: input.resolvedRevision.identity,
      platform: input.builder.artifactPlatform,
    });
    if (manifest.artifact_id !== artifactId) {
      throw new HitchError("dedicated builder returned a different artifact directory", {
        code: "harbor_artifact_build_failed",
        exitCode: 12,
      });
    }
    completed = true;
    return { directory, manifest, stagingRoot: state };
  } finally {
    await runCommand(input.docker, ["rm", "--force", containerName], { env: input.env, timeoutMs: 30_000 }).catch(() => {});
    if (!completed) await rm(state, { recursive: true, force: true }).catch(() => {});
  }
}

function builderScript(localSource: boolean): string {
  const common = [
    "mkdir -p \"$HOME\"",
    `test \"$(node -p process.version)\" = \"${HARBOR_NODE_VERSION_WITH_PREFIX}\"`,
    `test \"$(pnpm --version)\" = \"${HARBOR_PNPM_VERSION}\"`,
  ];
  if (!localSource) {
    return [...common, "exec node \"$1\" prepare \"$2\" --json"].join("\n");
  }
  return [
    ...common,
    "mkdir -p /tmp/hitch-state/local-source",
    "node -e 'const fs=require(\"node:fs\");const crypto=require(\"node:crypto\");const [file,digest,size]=process.argv.slice(1);if(fs.statSync(file).size!==Number(size))throw new Error(\"local source payload size mismatch\");const hash=crypto.createHash(\"sha256\");const stream=fs.createReadStream(file);stream.on(\"data\",chunk=>hash.update(chunk));stream.on(\"end\",()=>{if(\"sha256:\"+hash.digest(\"hex\")!==digest)throw new Error(\"local source payload digest mismatch\")})' /hitch-local-source-input/payload.pack \"$5\" \"$6\"",
    "git init --bare /tmp/hitch-state/local-source/repo.git >/dev/null",
    "git -C /tmp/hitch-state/local-source/repo.git index-pack --stdin < /hitch-local-source-input/payload.pack >/dev/null",
    "test \"$(git -C /tmp/hitch-state/local-source/repo.git rev-parse \"$3^{commit}\")\" = \"$3\"",
    "test \"$(git -C /tmp/hitch-state/local-source/repo.git rev-parse \"$3^{tree}\")\" = \"$4\"",
    "printf '%s\\n' \"$3\" > /tmp/hitch-state/local-source/repo.git/shallow",
    "git -C /tmp/hitch-state/local-source/repo.git update-ref refs/heads/hitch-local \"$3\"",
    "exec node \"$1\" prepare \"$2\" --internal-locked-resolution /hitch-local-source-input/resolution.json --internal-local-git-manifest /hitch-local-source-input/manifest.json --internal-local-git-source /tmp/hitch-state/local-source/repo.git --json",
  ].join("\n");
}

async function controllerEntrypoint(runtimeDirectory: string, runtimeId: string): Promise<string> {
  const manifest = await readJSON<Record<string, unknown>>(path.join(runtimeDirectory, "manifest.json"));
  const entrypoints = manifest.entrypoints && typeof manifest.entrypoints === "object" && !Array.isArray(manifest.entrypoints)
    ? manifest.entrypoints as Record<string, unknown>
    : {};
  const cli = entrypoints.cli && typeof entrypoints.cli === "object" && !Array.isArray(entrypoints.cli)
    ? entrypoints.cli as Record<string, unknown>
    : {};
  const entrypoint = cli.path;
  if (manifest.runtime_id !== runtimeId || typeof entrypoint !== "string" || !entrypoint
    || path.posix.isAbsolute(entrypoint) || entrypoint.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new HitchError("controller runtime cannot be mounted in the Harbor artifact builder", {
      code: "controller_runtime_integrity_mismatch",
      exitCode: 12,
    });
  }
  const file = path.join(runtimeDirectory, "payload", ...entrypoint.split("/"));
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new HitchError("controller runtime builder entrypoint is unavailable", {
      code: "controller_runtime_integrity_mismatch",
      exitCode: 12,
    });
  }
  return entrypoint;
}

function bindMount(source: string, destination: string, readonly: boolean): string {
  const absolute = path.resolve(source);
  if (absolute.includes(",") || /[\r\n\0]/.test(absolute)) {
    throw new HitchError("Harbor artifact builder mount path is unsupported", { code: "invalid_input", exitCode: 2 });
  }
  return `type=bind,source=${absolute},target=${destination}${readonly ? ",readonly" : ""}`;
}

function parsePrepareOutput(stdout: string): ArtifactManifest {
  let value: unknown;
  try { value = JSON.parse(stdout.trim()); } catch (error) {
    throw new HitchError("dedicated builder returned invalid prepare output", {
      code: "harbor_artifact_build_failed",
      exitCode: 12,
      cause: error,
    });
  }
  const artifact = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).artifact
    : null;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)
    || !/^sha256:[0-9a-f]{64}$/.test(String((artifact as Record<string, unknown>).artifact_id || ""))) {
    throw new HitchError("dedicated builder returned invalid artifact metadata", {
      code: "harbor_artifact_build_failed",
      exitCode: 12,
    });
  }
  return artifact as ArtifactManifest;
}

async function readCachedArtifact(
  cache: Awaited<ReturnType<typeof harborArtifactCache>>,
  key: string,
  expected: ArtifactExpectation,
): Promise<HarborPreparedArtifactUse | null> {
  const ref = await readJSON<{ artifact_id?: unknown } | null>(path.join(cache.refs, `${key.slice("sha256:".length)}.json`), null).catch(() => null);
  if (!ref || typeof ref.artifact_id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(ref.artifact_id)) return null;
  const directory = path.join(cache.artifacts, ref.artifact_id.slice("sha256:".length));
  try {
    return artifactUse(directory, await verifyArtifact(directory, expected));
  } catch {
    await quarantine(cache, directory);
    return null;
  }
}

async function promoteArtifact(
  cache: Awaited<ReturnType<typeof harborArtifactCache>>,
  source: string,
  manifest: ArtifactManifest,
  expected: ArtifactExpectation,
): Promise<HarborPreparedArtifactUse> {
  const destination = path.join(cache.artifacts, manifest.artifact_id.slice("sha256:".length));
  const existing = await lstat(destination).catch(() => null);
  if (existing) {
    try { return artifactUse(destination, await verifyArtifact(destination, expected)); }
    catch { await quarantine(cache, destination); }
  }
  await rename(source, destination);
  return artifactUse(destination, await verifyArtifact(destination, expected));
}

async function verifyArtifact(directory: string, expected: ArtifactExpectation): Promise<ArtifactManifest> {
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw artifactError("artifact directory is invalid");
  const manifest = await readJSON<ArtifactManifest>(path.join(directory, "artifact.json"));
  if (manifest.schema_version !== "1" || !/^sha256:[0-9a-f]{64}$/.test(manifest.artifact_id)
    || !/^sha256:[0-9a-f]{64}$/.test(String(manifest.artifact_integrity || ""))
    || !/^sha256:[0-9a-f]{64}$/.test(String(manifest.entrypoint_integrity || ""))
    || manifest.harness_id !== expected.harnessId
    || manifest.revision_identity !== expected.revisionIdentity
    || manifest.resolved_revision?.identity !== expected.revisionIdentity
    || manifest.platform !== expected.platform
    || manifest.toolchain?.node !== HARBOR_NODE_VERSION_WITH_PREFIX
    || (manifest.harness_id === "deepseek" && manifest.source_type === "git" && manifest.toolchain?.pnpm !== HARBOR_PNPM_VERSION)
    || manifest.source_type === "installed"
    || typeof manifest.adapter_version !== "string" || !manifest.adapter_version
    || typeof manifest.recipe_version !== "string" || !manifest.recipe_version
    || !await artifactMatches(directory, manifest)) {
    throw artifactError("artifact identity or integrity is invalid");
  }
  if (path.basename(directory) !== manifest.artifact_id.slice("sha256:".length)
    && path.basename(path.dirname(directory)) === "artifacts") throw artifactError("artifact directory name is invalid");
  return manifest;
}

function artifactUse(directory: string, manifest: ArtifactManifest): HarborPreparedArtifactUse {
  return {
    directory,
    artifact_id: manifest.artifact_id,
    artifact_integrity: String(manifest.artifact_integrity),
    entrypoint_integrity: String(manifest.entrypoint_integrity),
    harness_id: manifest.harness_id,
    revision_identity: manifest.revision_identity,
    adapter_version: manifest.adapter_version,
    recipe_version: manifest.recipe_version,
    platform: manifest.platform,
    node_version: String(manifest.toolchain.node),
    source_type: manifest.source_type,
    storage: "harbor-artifact-cache-v2",
  };
}

async function quarantine(cache: Awaited<ReturnType<typeof harborArtifactCache>>, directory: string): Promise<void> {
  const info = await lstat(directory).catch(() => null);
  if (!info) return;
  await rename(directory, path.join(cache.invalid, `${path.basename(directory)}-${randomBytes(6).toString("hex")}`)).catch(() => {});
}

function lockedHarnessRef(resolved: ResolvedRevision): string {
  if (resolved.revision.type === "version" && resolved.revision.version) return `${resolved.harness_id}@version:${resolved.revision.version}`;
  if (resolved.revision.type === "commit" && resolved.revision.commit) return `${resolved.harness_id}@commit:${resolved.revision.commit}`;
  throw new HitchError("Harbor artifact builder requires an exact managed revision", { code: "invalid_resolution", exitCode: 2 });
}

function artifactError(message: string): HitchError {
  return new HitchError(`Harbor prepared ${message}`, { code: "artifact_integrity_mismatch", exitCode: 5 });
}
