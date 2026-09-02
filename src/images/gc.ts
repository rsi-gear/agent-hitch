import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { EnvironmentImageManifestV1, Sha256 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, hitchRootId, readEvalEnvironmentImageReferences, readJSON, runCommand, sha256JSON, statePaths, withEnvironmentImageReferenceLock, withFileLock } from "../foundation/index.js";
import { parseEnvironmentBuildRecord, parseEnvironmentImageManifest } from "./manifest.js";
import { ENVIRONMENT_IMAGE_LABELS } from "./ownership.js";
import { environmentBuildRecordPath, environmentImageManifestPath, loadEnvironmentImageManifest } from "./service.js";

const TERMINAL_EVAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

export interface EnvironmentImageGcReportV1 {
  schema_version: "1";
  dry_run: boolean;
  scanned: number;
  retained: Array<{ image_id: Sha256; reasons: string[] }>;
  eligible: Array<{ image_id: Sha256; reference: string; config_digest: Sha256 }>;
  removed: Array<{ image_id: Sha256; reference: string; config_digest: Sha256 }>;
  skipped: Array<{ image_id: Sha256; code: string }>;
}

export async function pinEnvironmentImage(root: string, imageId: Sha256, reason?: string): Promise<void> {
  validateRootAndImage(root, imageId);
  if (reason !== undefined && (!reason.trim() || reason.length > 1_024 || /[\0\r\n]/.test(reason))) throw new TypeError("environment image pin reason is invalid");
  await withEnvironmentImageReferenceLock(root, async () => {
    await loadEnvironmentImageManifest(root, imageId);
    const file = environmentImagePinPath(root, imageId);
    const existing = await readJSON<unknown | null>(file, null);
    if (existing !== null) {
      parsePin(existing, imageId);
      return;
    }
    await atomicWriteJSON(file, {
      schema_version: "1",
      image_id: imageId,
      pinned_at: new Date().toISOString(),
      ...(reason === undefined ? {} : { reason }),
    });
  });
}

export async function unpinEnvironmentImage(root: string, imageId: Sha256): Promise<void> {
  validateRootAndImage(root, imageId);
  await withEnvironmentImageReferenceLock(root, () => rm(environmentImagePinPath(root, imageId), { force: true }));
}

export async function gcEnvironmentImages(input: {
  root: string;
  dryRun: boolean;
  minimumAgeMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  run?: (args: string[]) => Promise<{ stdout: string; stderr?: string }>;
}): Promise<EnvironmentImageGcReportV1> {
  if (!input.root || typeof input.dryRun !== "boolean") throw new TypeError("environment image GC input is invalid");
  const minimumAgeMs = input.minimumAgeMs ?? 24 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0) throw new TypeError("environment image GC minimum age is invalid");
  const env = input.env ?? process.env;
  const command = input.run ?? ((args: string[]) => runCommand(env.HITCH_DOCKER_PATH || "docker", args, {
    env,
    ...(input.signal ? { signal: input.signal } : {}),
    timeoutMs: 30_000,
    failureCode: "environment_image_gc_docker_failed",
    failureExitCode: 12,
  }));
  return withEnvironmentImageReferenceLock(input.root, async () => {
    const references = await referencedEnvironmentImages(input.root);
    const manifests = await storedManifests(input.root);
    const retained: EnvironmentImageGcReportV1["retained"] = [];
    const eligible: EnvironmentImageGcReportV1["eligible"] = [];
    const removed: EnvironmentImageGcReportV1["removed"] = [];
    const skipped: EnvironmentImageGcReportV1["skipped"] = [];
    for (const manifest of manifests) {
      const reasons = [...(references.get(manifest.image_id) ?? [])].sort(compare);
      if (reasons.length > 0) {
        retained.push({ image_id: manifest.image_id, reasons });
        continue;
      }
      if (manifest.source.kind === "registry") {
        retained.push({ image_id: manifest.image_id, reasons: ["external-registry-image"] });
        continue;
      }
      if (Date.now() - Date.parse(manifest.created_at) < minimumAgeMs) {
        retained.push({ image_id: manifest.image_id, reasons: ["minimum-age"] });
        continue;
      }
      const candidate = await withFileLock(statePaths(input.root).buildLocks, manifest.build.cache_key, async () => {
        const current = await loadEnvironmentImageManifest(input.root, manifest.image_id);
        if (JSON.stringify(current) !== JSON.stringify(manifest)) throw gcError("environment image changed during GC");
        return inspectGcCandidate(input.root, manifest, command);
      }, { timeoutCode: "environment_image_gc_build_locked", timeoutExitCode: 12, ...(input.signal ? { signal: input.signal } : {}) });
      if ("code" in candidate) {
        skipped.push({ image_id: manifest.image_id, code: candidate.code });
        continue;
      }
      eligible.push(candidate);
      if (input.dryRun) continue;
      const deleted = await withFileLock(statePaths(input.root).buildLocks, manifest.build.cache_key, async () => {
        const current = await loadEnvironmentImageManifest(input.root, manifest.image_id);
        if (JSON.stringify(current) !== JSON.stringify(manifest)) throw gcError("environment image changed during GC");
        const rechecked = await inspectGcCandidate(input.root, manifest, command);
        if ("code" in rechecked) return rechecked;
        await command(["image", "rm", manifest.output.reference]);
        await removeEnvironmentImageRecords(input.root, manifest);
        return rechecked;
      }, { timeoutCode: "environment_image_gc_build_locked", timeoutExitCode: 12, ...(input.signal ? { signal: input.signal } : {}) });
      if ("code" in deleted) skipped.push({ image_id: manifest.image_id, code: deleted.code });
      else removed.push(deleted);
    }
    return {
      schema_version: "1",
      dry_run: input.dryRun,
      scanned: manifests.length,
      retained: retained.sort(byImageId),
      eligible: eligible.sort(byImageId),
      removed: removed.sort(byImageId),
      skipped: skipped.sort(byImageId),
    };
  });
}

async function inspectGcCandidate(
  root: string,
  manifest: EnvironmentImageManifestV1,
  command: (args: string[]) => Promise<{ stdout: string; stderr?: string }>,
): Promise<EnvironmentImageGcReportV1["eligible"][number] | { code: string }> {
  if (!/^hitch-environment:[a-f0-9]{32}$/.test(manifest.output.reference) || !manifest.output.config_digest) return { code: "not-owned-build-output" };
  const record = parseEnvironmentBuildRecord(await readJSON(environmentBuildRecordPath(root, manifest.build.cache_key)));
  if (record.state !== "succeeded" || record.image_id !== manifest.image_id || record.cache_key !== manifest.build.cache_key) throw gcError("environment image build record does not match manifest");
  let inspected: unknown;
  try {
    inspected = JSON.parse((await command(["image", "inspect", "--format", "{{json .}}", manifest.output.reference])).stdout);
  } catch {
    return { code: "docker-image-unavailable" };
  }
  if (!inspected || typeof inspected !== "object" || Array.isArray(inspected)) return { code: "docker-inspect-invalid" };
  const image = inspected as Record<string, unknown>;
  const config = image.Config && typeof image.Config === "object" && !Array.isArray(image.Config) ? image.Config as Record<string, unknown> : {};
  const labels = config.Labels && typeof config.Labels === "object" && !Array.isArray(config.Labels) ? config.Labels as Record<string, unknown> : {};
  if (image.Id !== manifest.output.config_digest) return { code: "config-digest-mismatch" };
  if (labels[ENVIRONMENT_IMAGE_LABELS.rootId] !== hitchRootId(root)
    || labels[ENVIRONMENT_IMAGE_LABELS.cacheKey] !== manifest.build.cache_key) return { code: "ownership-label-mismatch" };
  return { image_id: manifest.image_id, reference: manifest.output.reference, config_digest: manifest.output.config_digest };
}

async function referencedEnvironmentImages(root: string): Promise<Map<Sha256, Set<string>>> {
  const result = new Map<Sha256, Set<string>>();
  const paths = statePaths(root);
  for (const entry of await directories(paths.evals)) {
    if (!/^eval_[a-f0-9]{32}$/.test(entry)) continue;
    const directory = path.join(paths.evals, entry);
    const control = await readJSON<Record<string, unknown> | null>(path.join(directory, "control.json"), null);
    const terminalResult = await readJSON<Record<string, unknown> | null>(path.join(directory, "result.json"), null);
    const terminal = TERMINAL_EVAL_STATES.has(String(control?.state)) || TERMINAL_EVAL_STATES.has(String(terminalResult?.status));
    if (terminal) continue;
    const request = await readJSON<unknown | null>(path.join(directory, "request.json"), null);
    if (request === null && control === null) continue;
    const references = await readEvalEnvironmentImageReferences(directory, entry);
    if (!references) throw gcError(`active eval has no environment image reference fence: ${entry}`);
    if (references.state !== "planned") throw gcError(`active eval image planning is incomplete: ${entry}`);
    for (const imageId of references.image_ids) addReference(result, imageId, "active-eval");
  }
  for (const entry of await directories(paths.runs)) {
    const index = await readJSON<Record<string, unknown> | null>(path.join(paths.runs, entry, "bundle.index.json"), null);
    if (index === null) continue;
    const manifest = await readJSON<Record<string, unknown> | null>(path.join(paths.runs, entry, "manifest.json"), null);
    const { bundle_digest: bundleDigest, created_at: _createdAt, ...bundleIdentity } = index;
    if (index.schema_version !== "1" || index.sealed !== true || typeof index.run_id !== "string"
      || typeof bundleDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(bundleDigest)
      || sha256JSON(bundleIdentity) !== bundleDigest
      || manifest?.sealed !== true || manifest.run_id !== index.run_id) throw gcError(`sealed bundle index is invalid: ${entry}`);
    if (index.environment === undefined) continue;
    const environment = record(index.environment);
    if (!environment || !Array.isArray(environment.images)) throw gcError(`sealed bundle environment is invalid: ${entry}`);
    for (const image of environment.images) {
      const value = record(image);
      if (!value || typeof value.image_id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.image_id)) throw gcError(`sealed bundle image reference is invalid: ${entry}`);
      addReference(result, value.image_id as Sha256, "sealed-bundle");
    }
  }
  for (const entry of await files(paths.environmentImagePins)) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry)) throw gcError("environment image pin filename is invalid");
    const imageId = `sha256:${entry.slice(0, 64)}` as Sha256;
    parsePin(await readJSON(path.join(paths.environmentImagePins, entry)), imageId);
    addReference(result, imageId, "operator-pin");
  }
  return result;
}

async function storedManifests(root: string): Promise<EnvironmentImageManifestV1[]> {
  const result: EnvironmentImageManifestV1[] = [];
  for (const entry of await directories(statePaths(root).environmentImages)) {
    if (!/^[a-f0-9]{64}$/.test(entry)) throw gcError("environment image store entry is invalid");
    const manifest = parseEnvironmentImageManifest(await readJSON(path.join(statePaths(root).environmentImages, entry, "manifest.json")));
    if (manifest.image_id !== `sha256:${entry}`) throw gcError("environment image store path does not match manifest");
    result.push(manifest);
  }
  return result.sort((left, right) => compare(left.image_id, right.image_id));
}

async function removeEnvironmentImageRecords(root: string, manifest: EnvironmentImageManifestV1): Promise<void> {
  const paths = statePaths(root);
  const manifestDirectory = path.dirname(environmentImageManifestPath(root, manifest.image_id));
  const recordDirectory = path.dirname(environmentBuildRecordPath(root, manifest.build.cache_key));
  const buildId = `build_${manifest.build.cache_key.slice("sha256:".length, "sha256:".length + 32)}`;
  await rm(path.join(paths.buildIndexes, `${buildId}.json`), { force: true });
  await rm(recordDirectory, { recursive: true, force: true });
  await rm(manifestDirectory, { recursive: true, force: true });
}

function environmentImagePinPath(root: string, imageId: Sha256): string {
  return path.join(statePaths(root).environmentImagePins, `${imageId.slice("sha256:".length)}.json`);
}

function parsePin(value: unknown, expectedImageId: Sha256): void {
  const pin = record(value);
  if (!pin || Object.keys(pin).some((key) => !["schema_version", "image_id", "pinned_at", "reason"].includes(key))
    || pin.schema_version !== "1" || pin.image_id !== expectedImageId
    || typeof pin.pinned_at !== "string" || !Number.isFinite(Date.parse(pin.pinned_at))
    || pin.reason !== undefined && (typeof pin.reason !== "string" || !pin.reason || pin.reason.length > 1_024 || /[\0\r\n]/.test(pin.reason))) {
    throw gcError("environment image pin is invalid");
  }
}

async function directories(root: string): Promise<string[]> {
  try { return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(compare); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function files(root: string): Promise<string[]> {
  try { return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort(compare); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

function addReference(target: Map<Sha256, Set<string>>, imageId: Sha256, reason: string): void {
  const reasons = target.get(imageId) ?? new Set<string>();
  reasons.add(reason);
  target.set(imageId, reasons);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validateRootAndImage(root: string, imageId: Sha256): void {
  if (!root || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new TypeError("environment image pin identity is invalid");
}

function gcError(message: string): HitchError {
  return new HitchError(message, { code: "environment_image_gc_reference_scan_failed", exitCode: 12 });
}

function byImageId(left: { image_id: Sha256 }, right: { image_id: Sha256 }): number {
  return compare(left.image_id, right.image_id);
}

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
