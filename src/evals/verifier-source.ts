import { constants } from "node:fs";
import { cp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseTOML } from "smol-toml";
import { capturePortableHarborRegradeConfig, parsePortableHarborRegradeConfig } from "../backends/index.js";
import type { RemoteVerifierSourceManifestV2 } from "../domain/index.js";
import { HitchError, readJSON, sha256JSON } from "../foundation/index.js";
import { verifyResultBundleIndex } from "../runs/index.js";
import { regradeTreeDigest } from "./regrade-evidence.js";
import { portableRemoteTrial } from "./remote-trial.js";

const MAX_SOURCE_BYTES = 48 * 1024 * 1024;
const SHA = /^sha256:[a-f0-9]{64}$/;
export interface RemoteVerifierSourceCapture {
  manifest: RemoteVerifierSourceManifestV2;
  directory?: string;
}

/** Only recorded artifacts and host lifecycle/response receipts cross this boundary; never agent config or credentials. */
export async function captureRemoteVerifierSource(input: {
  taskId: string; taskDirectory: string; trialDirectory: string; bundleDirectory: string;
  runId: string; runtimeId: string; trial: Record<string, unknown>; destination: string;
}): Promise<RemoteVerifierSourceCapture> {
  const identity = { schema_version: "2" as const, task_id: input.taskId, trial_id: String(input.trial.trial_name), run_id: input.runId,
    controller_runtime_id: input.runtimeId, source_result_digest: sha256JSON(portableRemoteTrial(input.trial)), original_result_digest: sha256JSON(input.trial) };
  const unavailable = (reason: "unsupported-task" | "source-unavailable"): RemoteVerifierSourceCapture => ({ manifest: { ...identity, status: "unavailable", reason } });
  let created = false;
  try {
    const task = parseTOML(await readFile(path.join(input.taskDirectory, "task.toml"), "utf8"));
    if (task.steps || (task.verifier as Record<string, unknown> | undefined)?.environment_mode !== "separate") return unavailable("unsupported-task");
    const bundle = await verifyResultBundleIndex(input.bundleDirectory);
    const result = await readJSON<Record<string, unknown>>(path.join(input.bundleDirectory, "result.json"));
    const config = await readJSON<Record<string, unknown>>(path.join(input.trialDirectory, "config.json"));
    const sourceResult = await readJSON<Record<string, unknown>>(path.join(input.trialDirectory, "result.json"));
    const metadata = (sourceResult.agent_result as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    if (bundle.run_id !== input.runId || result.run_id !== input.runId || result.status !== "succeeded"
      || metadata?.hitch_run_id !== input.runId || metadata.controller_runtime_id !== input.runtimeId
      || sha256JSON(sourceResult) !== identity.original_result_digest || (config.task as { path?: unknown } | undefined)?.path !== input.taskDirectory
      || sourceResult.config !== undefined && sha256JSON(sourceResult.config) !== sha256JSON(config)
      || typeof sourceResult.id !== "string" || !sourceResult.id) return unavailable("source-unavailable");
    const taskDigest = await regradeTreeDigest(input.taskDirectory);
    const regradeConfig = capturePortableHarborRegradeConfig(config, input.taskDirectory);
    const artifacts = path.join(input.trialDirectory, "artifacts");
    const artifactsDigest = await regradeTreeDigest(artifacts, MAX_SOURCE_BYTES);
    await mkdir(input.destination, { recursive: false, mode: 0o700 });
    created = true;
    await writeFile(path.join(input.destination, "regrade-config.json"), `${JSON.stringify(regradeConfig)}\n`, { flag: "wx", mode: 0o600 });
    await cp(artifacts, path.join(input.destination, "artifacts"), { recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true });
    const lifecycle = await regularFile(path.join(input.trialDirectory, "benchmark-lifecycle.json"));
    const journal = JSON.parse(lifecycle.toString()) as Record<string, unknown>;
    if (journal.schema_version !== "1" || journal.failure !== null || !journal.phases || typeof journal.phases !== "object" || Array.isArray(journal.phases)) throw invalid("source lifecycle is incomplete");
    await writeFile(path.join(input.destination, "benchmark-lifecycle.json"), lifecycle, { flag: "wx", mode: 0o600 });
    const response = await regularFile(path.join(input.trialDirectory, "hitch-final-response.json")).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (response) {
      const exported = JSON.parse(response.toString()) as Record<string, unknown>;
      if (exported.schema_version !== "1" || exported.source !== "hitch-run-result" || exported.run_id !== input.runId
        || exported.termination !== result.status || typeof result.output !== "string" || exported.response !== result.output) throw invalid("source response differs from the sealed candidate");
      await writeFile(path.join(input.destination, "hitch-final-response.json"), response, { flag: "wx", mode: 0o600 });
    }
    if (await regradeTreeDigest(artifacts, MAX_SOURCE_BYTES) !== artifactsDigest
      || await regradeTreeDigest(path.join(input.destination, "artifacts"), MAX_SOURCE_BYTES) !== artifactsDigest
      || await regradeTreeDigest(input.taskDirectory) !== taskDigest
      || sha256JSON(await verifyResultBundleIndex(input.bundleDirectory)) !== sha256JSON(bundle)) throw invalid("source changed while capturing verifier inputs");
    const manifest: RemoteVerifierSourceManifestV2 = { ...identity, status: "available", source_bundle_digest: sha256JSON(bundle),
      source_config_digest: sha256JSON(config), regrade_config_digest: sha256JSON(regradeConfig), task_digest: taskDigest, artifacts_digest: artifactsDigest,
      snapshot_digest: await regradeTreeDigest(input.destination, MAX_SOURCE_BYTES) };
    return { manifest: parseRemoteVerifierSourceManifest(manifest), directory: input.destination };
  } catch {
    if (created) await rm(input.destination, { recursive: true, force: true });
    return unavailable("source-unavailable");
  }
}

export function parseRemoteVerifierSourceManifest(value: unknown): RemoteVerifierSourceManifestV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("verifier source manifest is invalid");
  const r = value as Record<string, unknown>;
  const keys = ["schema_version", "task_id", "trial_id", "run_id", "controller_runtime_id", "source_result_digest",
    ...(r.original_result_digest !== undefined ? ["original_result_digest"] : []),
    ...(r.status === "available" ? ["status", "source_bundle_digest", "source_config_digest", "task_digest", "artifacts_digest", "snapshot_digest", ...(r.regrade_config_digest !== undefined ? ["regrade_config_digest"] : [])] : ["status", "reason"])];
  if (Object.keys(r).sort().join(",") !== keys.sort().join(",") || r.schema_version !== "2"
    || typeof r.task_id !== "string" || !r.task_id || r.task_id.length > 512
    || typeof r.trial_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(r.trial_id)
    || typeof r.run_id !== "string" || !/^run_[a-f0-9]{32}$/.test(r.run_id)
    || ![r.controller_runtime_id, r.source_result_digest, ...(r.original_result_digest !== undefined ? [r.original_result_digest] : [])].every(v => typeof v === "string" && SHA.test(v))
    || !(r.status === "available" && [r.source_bundle_digest, r.source_config_digest, r.task_digest, r.artifacts_digest, r.snapshot_digest, ...(r.regrade_config_digest !== undefined ? [r.regrade_config_digest] : [])].every(v => typeof v === "string" && SHA.test(v))
      || r.status === "unavailable" && typeof r.reason === "string" && ["unsupported-task", "source-unavailable", "source-too-large"].includes(r.reason))) throw invalid("verifier source manifest identity is invalid");
  return structuredClone(r) as unknown as RemoteVerifierSourceManifestV2;
}

export async function verifyRemoteVerifierSourceSnapshot(input: {
  manifest: RemoteVerifierSourceManifestV2; snapshotDirectory: string; taskDirectory: string; bundleDirectory: string;
}): Promise<void> {
  const m = parseRemoteVerifierSourceManifest(input.manifest);
  if (m.status !== "available" || m.source_bundle_digest !== sha256JSON(await verifyResultBundleIndex(input.bundleDirectory))) throw invalid("verifier source bundle digest mismatch");
  await verifyRemoteVerifierSourceContents(input);
}

export async function verifyRemoteVerifierSourceContents(input: {
  manifest: RemoteVerifierSourceManifestV2; snapshotDirectory: string; taskDirectory: string; bundleDirectory: string;
}): Promise<void> {
  const m = parseRemoteVerifierSourceManifest(input.manifest);
  if (m.status !== "available" || m.task_digest !== await regradeTreeDigest(input.taskDirectory)
    || m.artifacts_digest !== await regradeTreeDigest(path.join(input.snapshotDirectory, "artifacts"), MAX_SOURCE_BYTES)
    || m.snapshot_digest !== await regradeTreeDigest(input.snapshotDirectory, MAX_SOURCE_BYTES)) throw invalid("verifier source snapshot digest mismatch");
  if (m.regrade_config_digest) {
    const config = parsePortableHarborRegradeConfig(JSON.parse((await regularFile(path.join(input.snapshotDirectory, "regrade-config.json"))).toString()));
    if (sha256JSON(config) !== m.regrade_config_digest || config.source_config_digest !== m.source_config_digest) throw invalid("verifier source config digest mismatch");
  }
  const task = parseTOML(await readFile(path.join(input.taskDirectory, "task.toml"), "utf8"));
  const journal = JSON.parse((await regularFile(path.join(input.snapshotDirectory, "benchmark-lifecycle.json"))).toString()) as Record<string, unknown>;
  if (task.steps || (task.verifier as Record<string, unknown> | undefined)?.environment_mode !== "separate"
    || journal.schema_version !== "1" || journal.failure !== null || !journal.phases || typeof journal.phases !== "object" || Array.isArray(journal.phases)) throw invalid("verifier source lifecycle/task contract is invalid");
  const response = await regularFile(path.join(input.snapshotDirectory, "hitch-final-response.json")).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (response) {
    const exported = JSON.parse(response.toString()) as Record<string, unknown>;
    const result = await readJSON<Record<string, unknown>>(path.join(input.bundleDirectory, "result.json"));
    if (exported.schema_version !== "1" || exported.source !== "hitch-run-result" || exported.run_id !== m.run_id
      || exported.termination !== result.status || result.status !== "succeeded" || typeof result.output !== "string" || exported.response !== result.output) throw invalid("source response differs from the sealed candidate");
  }
}

async function regularFile(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw invalid("unsafe verifier source receipt");
    return await handle.readFile();
  } finally { await handle.close(); }
}
function invalid(message: string): HitchError { return new HitchError(message, { code: "remote_verifier_source_invalid", exitCode: 12 }); }
