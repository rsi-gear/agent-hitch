import { randomBytes } from "node:crypto";
import { chmod, cp, lstat, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { artifactDirectoryIntegrity } from "../artifacts/index.js";
import type { ArtifactManifest } from "../artifacts/index.js";
import { HARBOR_NODE_VERSION_WITH_PREFIX } from "../backends/index.js";
import { HitchError, atomicWriteJSON, digest, ensureDir, fingerprintExecutable, readJSON, runCommand, statePaths, withFileLock } from "../foundation/index.js";
import type { HarborBuilderImage } from "./harbor-artifact-builder-image.js";

export const HARBOR_NODE_RUNTIME_RECIPE = "1";
export const HARBOR_NODE_RUNTIME_DIRECTORY = ".hitch-node-runtime";
const ARCHIVE = "node-runtime.tar.gz";
const MANIFEST = "node-runtime.json";
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

export interface HarborNodeRuntimeManifest {
  schema_version: "1";
  recipe_version: string;
  runtime_id: string;
  node_version: string;
  platform: string;
  libc: "glibc";
  builder_image_id: string;
  archive_sha256: string;
  archive_bytes: number;
}

interface NodeRuntime {
  directory: string;
  manifest: HarborNodeRuntimeManifest;
}

/** Export once from the pinned Linux builder; trial setup never downloads Node. */
export async function prepareHarborNodeRuntime(input: {
  root: string;
  docker: string;
  builder: HarborBuilderImage;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<NodeRuntime> {
  const base = path.join(statePaths(input.root).store, "harbor-artifacts", "node-runtimes");
  const [artifacts, locks, temporary, refs, invalid] = await Promise.all(
    ["artifacts", "locks", "tmp", "refs", "invalid"].map((name) => ensureDir(path.join(base, name))),
  ) as [string, string, string, string, string];
  const identity = {
    schema_version: "1" as const,
    recipe_version: HARBOR_NODE_RUNTIME_RECIPE,
    node_version: HARBOR_NODE_VERSION_WITH_PREFIX,
    platform: input.builder.artifactPlatform,
    libc: "glibc" as const,
    builder_image_id: input.builder.id,
  };
  const key = digest(identity).slice("sha256:".length);
  const ref = path.join(refs, `${key}.json`);
  return withFileLock(locks, key, async () => {
    const previous = await readJSON<{ runtime_id?: unknown } | null>(ref, null).catch(() => null);
    if (typeof previous?.runtime_id === "string" && /^sha256:[a-f0-9]{64}$/.test(previous.runtime_id)) {
      const directory = path.join(artifacts, previous.runtime_id.slice("sha256:".length));
      try {
        const manifest = await verifyHarborNodeRuntime(directory, identity);
        if (manifest.runtime_id !== previous.runtime_id) throw runtimeError("cache reference identity mismatch");
        return { directory, manifest };
      } catch {
        if (await lstat(directory).catch(() => null)) {
          await rename(directory, path.join(invalid, `${path.basename(directory)}-${randomBytes(6).toString("hex")}`));
        }
      }
    }
    const staging = await mkdtemp(path.join(temporary, "export-"));
    const container = `hitch-node-runtime-${process.pid}-${randomBytes(6).toString("hex")}`;
    const options = {
      env: input.env, ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: 180_000, failureCode: "harbor_node_runtime_prepare_failed", failureExitCode: 12,
    };
    try {
      await runCommand(input.docker, [
        "run", "--name", container, "--network", "none", "--platform", input.builder.dockerPlatform,
        // Never resolve a mutable tag after the builder's image inspection.
        input.builder.id, "sh", "-ceu", [
          `test "$(node -p process.version)" = "${identity.node_version}"`,
          `test "$(node -p 'process.platform + \"-\" + process.arch')" = "${identity.platform}"`,
          "getconf GNU_LIBC_VERSION",
          "test -x /usr/local/bin/node",
          // Keep npm/npx available as with the former nvm install. Do not ship
          // the builder's pnpm, headers, or system libraries into task images.
          `tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -czf /tmp/${ARCHIVE} -C /usr/local bin/node bin/npm bin/npx lib/node_modules/npm`,
        ].join("\n"),
      ], options);
      await runCommand(input.docker, ["cp", `${container}:/tmp/${ARCHIVE}`, path.join(staging, ARCHIVE)], options);
      const archive = path.join(staging, ARCHIVE);
      const info = await lstat(archive);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_ARCHIVE_BYTES) throw runtimeError("exported archive is invalid");
      const payload = { ...identity, archive_sha256: await fingerprintExecutable(archive), archive_bytes: info.size };
      const manifest: HarborNodeRuntimeManifest = { ...payload, runtime_id: digest(payload) };
      await atomicWriteJSON(path.join(staging, MANIFEST), manifest);
      await verifyHarborNodeRuntime(staging, identity);
      const destination = path.join(artifacts, manifest.runtime_id.slice("sha256:".length));
      if (await lstat(destination).catch(() => null)) {
        try { await verifyHarborNodeRuntime(destination, manifest); }
        catch { await rename(destination, path.join(invalid, `${path.basename(destination)}-${randomBytes(6).toString("hex")}`)); }
      }
      if (!await lstat(destination).catch(() => null)) await rename(staging, destination);
      await atomicWriteJSON(ref, { runtime_id: manifest.runtime_id });
      return { directory: destination, manifest };
    } finally {
      await runCommand(input.docker, ["rm", "--force", container], { env: input.env, timeoutMs: 30_000 }).catch(() => {});
      await rm(staging, { recursive: true, force: true });
    }
  }, {
    timeoutCode: "harbor_node_runtime_locked", timeoutExitCode: 12,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export async function verifyHarborNodeRuntime(
  directory: string,
  expected: Partial<HarborNodeRuntimeManifest>,
): Promise<HarborNodeRuntimeManifest> {
  const info = await lstat(directory);
  const manifestInfo = await lstat(path.join(directory, MANIFEST));
  if (!info.isDirectory() || info.isSymbolicLink() || !manifestInfo.isFile() || manifestInfo.size > 16_384) {
    throw runtimeError("cache entry is not a regular runtime bundle");
  }
  const manifest = await readJSON<HarborNodeRuntimeManifest>(path.join(directory, MANIFEST));
  const { runtime_id, ...payload } = manifest;
  const archive = path.join(directory, ARCHIVE);
  const archiveInfo = await lstat(archive);
  if (Object.keys(manifest).sort().join(",") !== "archive_bytes,archive_sha256,builder_image_id,libc,node_version,platform,recipe_version,runtime_id,schema_version"
    || manifest.schema_version !== "1" || manifest.recipe_version !== HARBOR_NODE_RUNTIME_RECIPE
    || manifest.node_version !== HARBOR_NODE_VERSION_WITH_PREFIX || manifest.libc !== "glibc"
    || !/^linux-(x64|arm64)$/.test(manifest.platform)
    || !/^sha256:[a-f0-9]{64}$/.test(manifest.builder_image_id)
    || !archiveInfo.isFile() || archiveInfo.size <= 0 || archiveInfo.size > MAX_ARCHIVE_BYTES
    || archiveInfo.size !== manifest.archive_bytes || await fingerprintExecutable(archive) !== manifest.archive_sha256
    || digest(payload) !== runtime_id
    || Object.entries(expected).some(([key, value]) => manifest[key as keyof HarborNodeRuntimeManifest] !== value)) {
    throw runtimeError("cache identity or archive checksum mismatch");
  }
  return manifest;
}

/** Compose in staging, then seal a NEW identity; never mutate a published artifact. */
export async function attachHarborNodeRuntime(
  directory: string, manifest: ArtifactManifest, runtime: NodeRuntime,
): Promise<{ directory: string; manifest: ArtifactManifest }> {
  const destination = path.join(directory, HARBOR_NODE_RUNTIME_DIRECTORY);
  if (await lstat(destination).catch(() => null)) throw runtimeError("harness uses the reserved offline runtime directory");
  await cp(runtime.directory, destination, { recursive: true, errorOnExist: true, force: false });
  await verifyHarborNodeRuntime(destination, runtime.manifest);
  // mkdtemp cache roots are private. This public runtime payload must remain
  // readable when a task runs Hitch as a non-root user; seal these modes too.
  await chmod(destination, 0o755);
  await chmod(path.join(destination, MANIFEST), 0o644);
  await chmod(path.join(destination, ARCHIVE), 0o644);
  const integrity = await artifactDirectoryIntegrity(directory);
  const artifactId = digest({
    kind: "harbor-offline-node-artifact-v1", harness_artifact_id: manifest.artifact_id,
    node_runtime_id: runtime.manifest.runtime_id, artifact_integrity: integrity,
  });
  const composed: ArtifactManifest = {
    ...manifest, artifact_id: artifactId, artifact_integrity: integrity,
    toolchain: { ...manifest.toolchain, node_runtime: runtime.manifest.runtime_id },
  };
  await atomicWriteJSON(path.join(directory, "artifact.json"), composed);
  const renamed = path.join(path.dirname(directory), artifactId.slice("sha256:".length));
  await rename(directory, renamed);
  return { directory: renamed, manifest: composed };
}

function runtimeError(message: string): HitchError {
  return new HitchError(`Harbor offline Node runtime: ${message}`, { code: "harbor_node_runtime_invalid", exitCode: 12 });
}
