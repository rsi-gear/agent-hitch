import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { ensureControllerRuntime, PACKAGE_ROOT, useControllerRuntimeById } from "../controller-runtime/index.js";
import type { ControllerRuntimeUseResult } from "../controller-runtime/index.js";
import { ensureDir, invalidInput, sha256JSON, statePaths } from "../foundation/index.js";

export const VERIFIER_ENVIRONMENT_PROVIDER = "integrations/harbor/hitch_harbor_environment.py";

/** Runtime changes for artifact-only regrades are restricted to one provider.
 * The complete file membership, grader, normalizer, candidate and CLI stay fixed. */
export function verifierRuntimeRepair(source: ControllerRuntimeUseResult, replacement: ControllerRuntimeUseResult) {
  if (source.runtime_id === replacement.runtime_id) return null;
  const before = source.manifest, after = replacement.manifest;
  if (before.schema_version !== after.schema_version || before.node_range !== after.node_range
    || sha256JSON(before.entrypoints) !== sha256JSON(after.entrypoints)
    || before.files.length !== after.files.length) throw invalidInput("verifier runtime repair changes its execution contract");
  const changed = before.files.filter(file => {
    const other = after.files.find(candidate => candidate.path === file.path);
    if (!other || other.executable !== file.executable) throw invalidInput("verifier runtime repair changes file membership or permissions");
    return sha256JSON(file) !== sha256JSON(other);
  });
  if (changed.length !== 1 || changed[0]!.path !== VERIFIER_ENVIRONMENT_PROVIDER) {
    throw invalidInput("verifier runtime repair may change only the Docker environment provider");
  }
  return {
    schema_version: "1", kind: "verifier-environment-runtime-repair",
    source_runtime_id: source.runtime_id, replacement_runtime_id: replacement.runtime_id,
    path: VERIFIER_ENVIRONMENT_PROVIDER, source_sha256: changed[0]!.sha256,
    replacement_sha256: after.files.find(file => file.path === VERIFIER_ENVIRONMENT_PROVIDER)!.sha256,
    unchanged_file_count: before.files.length - 1,
  };
}

/** Build a new immutable runtime without writing into the original CAS entry. */
export async function prepareVerifierEnvironmentRuntime(options: {
  root: string; sourceRuntimeId: string; providerPath?: string;
}): Promise<ControllerRuntimeUseResult> {
  if (!/^sha256:[a-f0-9]{64}$/.test(options.sourceRuntimeId)) throw invalidInput("invalid source controller runtime ID");
  const paths = statePaths(options.root);
  const source = await useControllerRuntimeById(paths, options.sourceRuntimeId.slice(7));
  if (!source.manifest.files.some(file => file.path === VERIFIER_ENVIRONMENT_PROVIDER)) throw invalidInput("source runtime has no Docker environment provider");
  const staging = await mkdtemp(path.join(await ensureDir(paths.temporary), "verifier-runtime-"));
  try {
    for (const file of source.manifest.files) {
      const target = path.join(staging, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(source.directory, "payload", file.path), target);
      await chmod(target, file.executable ? 0o755 : 0o644);
    }
    await copyFile(options.providerPath ?? path.join(PACKAGE_ROOT, VERIFIER_ENVIRONMENT_PROVIDER), path.join(staging, VERIFIER_ENVIRONMENT_PROVIDER));
    await chmod(path.join(staging, VERIFIER_ENVIRONMENT_PROVIDER), source.manifest.files.find(file => file.path === VERIFIER_ENVIRONMENT_PROVIDER)!.executable ? 0o755 : 0o644);
    const replacement = await ensureControllerRuntime({ root: options.root, payloadRoot: staging,
      rules: source.manifest.files.map(file => ({ path: file.path, executable: file.executable })) });
    verifierRuntimeRepair(source, replacement);
    await useControllerRuntimeById(paths, options.sourceRuntimeId.slice(7));
    return replacement;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
