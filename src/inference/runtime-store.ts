import { lstat } from "node:fs/promises";
import path from "node:path";
import type { InferenceRuntimeManifestV1, LocalInferenceBackend, Sha256 } from "../domain/index.js";
import {
  HitchError,
  atomicWriteJSON,
  ensureDir,
  readJSON,
  runCommand,
  statePaths,
  withFileLock,
} from "../foundation/index.js";
import type { CommandResult } from "../foundation/index.js";
import { parseInferenceRuntimeManifest } from "./manifest.js";
import { runtimeCatalogEntry } from "./runtime-catalog.js";

export interface PrepareInferenceRuntimeOptions {
  root: string;
  backend: Exclude<LocalInferenceBackend, "metal">;
  offline?: boolean;
  dockerExecutable?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  run?: (executable: string, args: string[]) => Promise<CommandResult>;
}

export async function prepareInferenceRuntime(options: PrepareInferenceRuntimeOptions): Promise<{
  manifest: InferenceRuntimeManifestV1;
  cache_hit: boolean;
}> {
  const expected = runtimeCatalogEntry(options.backend);
  const runtimeDirectory = path.join(statePaths(options.root).inferenceRuntimes, expected.runtime_id.slice("sha256:".length));
  const manifestFile = path.join(runtimeDirectory, "manifest.json");
  const cached = await loadRuntimeFile(manifestFile);
  const env = options.env ?? process.env;
  const docker = options.dockerExecutable || env.HITCH_DOCKER_PATH || "docker";
  const invoke = options.run ?? ((executable: string, args: string[]) => runCommand(executable, args, {
    env, timeoutMs: 30 * 60_000, failureCode: "inference_runtime_unavailable", failureExitCode: 3,
    ...(options.signal ? { signal: options.signal } : {}),
  }));
  if (cached && cached.runtime_id === expected.runtime_id && await inspectRuntimeImage(expected, docker, invoke)) {
    return { manifest: cached, cache_hit: true };
  }
  return withFileLock(statePaths(options.root).inferenceOperationLocks, expected.runtime_id, async () => {
    const afterWait = await loadRuntimeFile(manifestFile);
    if (afterWait && afterWait.runtime_id === expected.runtime_id && await inspectRuntimeImage(expected, docker, invoke)) {
      return { manifest: afterWait, cache_hit: true };
    }
    if (options.offline) {
      throw new HitchError(`SGLang ${options.backend} runtime is not prepared; run hitch local prepare with network access`, {
        code: "inference_runtime_unavailable", exitCode: 3,
      });
    }
    const packageInfo = expected.package;
    if (packageInfo.kind !== "oci") throw new TypeError("P0 runtime package must be OCI");
    options.onProgress?.(`Pulling SGLang ${expected.sglang_version} ${options.backend} runtime ${packageInfo.image_digest}`);
    await invoke(docker, ["pull", "--platform", packageInfo.platform, packageInfo.image]);
    if (!await inspectRuntimeImage(expected, docker, invoke)) {
      throw new HitchError("pulled SGLang image does not match the catalog digest or platform", {
        code: "inference_runtime_integrity_failed", exitCode: 5,
      });
    }
    await ensureDir(runtimeDirectory);
    await atomicWriteJSON(manifestFile, expected);
    return { manifest: parseInferenceRuntimeManifest(await readJSON(manifestFile)), cache_hit: false };
  }, { timeoutCode: "inference_runtime_locked", timeoutExitCode: 5, signal: options.signal });
}

export async function loadInferenceRuntime(root: string, runtimeId: Sha256): Promise<InferenceRuntimeManifestV1> {
  const file = path.join(statePaths(root).inferenceRuntimes, runtimeId.slice("sha256:".length), "manifest.json");
  const manifest = await loadRuntimeFile(file);
  if (!manifest || manifest.runtime_id !== runtimeId) {
    throw new HitchError(`inference runtime is missing or invalid: ${runtimeId}`, {
      code: "inference_runtime_integrity_failed", exitCode: 5,
    });
  }
  return manifest;
}

async function inspectRuntimeImage(
  manifest: InferenceRuntimeManifestV1,
  docker: string,
  invoke: (executable: string, args: string[]) => Promise<CommandResult>,
): Promise<boolean> {
  if (manifest.package.kind !== "oci") return false;
  let result: CommandResult;
  try { result = await invoke(docker, ["image", "inspect", "--format", "{{json .}}", manifest.package.image]); } catch { return false; }
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch { return false; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const image = value as Record<string, unknown>;
  const digests = Array.isArray(image.RepoDigests) ? image.RepoDigests.filter((item): item is string => typeof item === "string") : [];
  return image.Os === "linux" && image.Architecture === "amd64"
    && digests.some((item) => item.endsWith(`@${manifest.package.kind === "oci" ? manifest.package.image_digest : ""}`));
}

async function loadRuntimeFile(file: string): Promise<InferenceRuntimeManifestV1 | null> {
  try {
    if (!(await lstat(file)).isFile()) return null;
    return parseInferenceRuntimeManifest(await readJSON(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof TypeError) return null;
    throw error;
  }
}
