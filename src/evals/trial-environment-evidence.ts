import path from "node:path";
import type { EnvironmentImageManifestV1, EnvironmentImageUseV1, ExecutionEvidenceV1, RunEnvironmentImagesV1 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, ensureDir } from "../foundation/index.js";
import type { EvalEnvironmentImageManifestLoader } from "./service-types.js";

export interface TrialEnvironmentImagesV1 {
  uses: EnvironmentImageUseV1[];
  manifests: EnvironmentImageManifestV1[];
}

export async function loadTrialEnvironmentImages(input: {
  taskId: string;
  uses: readonly EnvironmentImageUseV1[];
  loader?: EvalEnvironmentImageManifestLoader;
}): Promise<TrialEnvironmentImagesV1 | undefined> {
  if (input.uses.length === 0) return undefined;
  if (!input.loader) throw new HitchError("environment image manifest loader is unavailable", { code: "environment_image_manifest_unavailable", exitCode: 12 });
  const uses = [...input.uses].sort((left, right) => compare(left.requested_reference, right.requested_reference));
  const manifests = await Promise.all(uses.map((use) => input.loader?.(use.image_id) as Promise<EnvironmentImageManifestV1>));
  const unique = new Map<string, EnvironmentImageManifestV1>();
  for (let index = 0; index < uses.length; index += 1) {
    const use = uses[index] as EnvironmentImageUseV1;
    const manifest = manifests[index] as EnvironmentImageManifestV1;
    validatePair(input.taskId, use, manifest);
    const previous = unique.get(manifest.image_id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(manifest)) throw new TypeError("environment image manifest identity changed");
    unique.set(manifest.image_id, manifest);
  }
  return { uses, manifests: [...unique.values()].sort((left, right) => compare(left.image_id, right.image_id)) };
}

export async function writeTrialEnvironmentImageEvidence(
  runDirectory: string,
  taskId: string,
  evidence?: TrialEnvironmentImagesV1,
): Promise<void> {
  if (!evidence) return;
  const byId = new Map(evidence.manifests.map((manifest) => [manifest.image_id, manifest]));
  for (const use of evidence.uses) {
    const manifest = byId.get(use.image_id);
    if (!manifest) throw new TypeError("environment image evidence manifest is missing");
    validatePair(taskId, use, manifest);
  }
  await ensureDir(path.join(runDirectory, "environment"));
  const persisted: RunEnvironmentImagesV1 = {
    schema_version: "1",
    task_id: taskId,
    uses: evidence.uses,
    manifests: evidence.manifests,
  };
  await atomicWriteJSON(path.join(runDirectory, "environment", "image.manifest.json"), persisted);
}

export function verifyTrialEnvironmentImageExecution(
  execution: ExecutionEvidenceV1,
  evidence?: TrialEnvironmentImagesV1,
): ExecutionEvidenceV1 {
  if (!evidence) return execution;
  const manifests = new Map(evidence.manifests.map((manifest) => [manifest.image_id, manifest]));
  for (const use of evidence.uses) {
    const manifest = manifests.get(use.image_id);
    if (!manifest) throw imageMismatch();
    const expectedConfig = manifest.output.config_digest;
    const matched = execution.observed.containers.some((container) => expectedConfig
      ? container.image_config_digest === expectedConfig
      : container.image_reference === use.reference);
    if (!matched) throw imageMismatch();
  }
  return execution;
}

export function prebuiltTaskImage(evidence?: TrialEnvironmentImagesV1): string | undefined {
  if (!evidence) return undefined;
  const uses = evidence.uses.filter((use) => use.resolution === "prebuilt");
  if (uses.length === 0) return undefined;
  if (uses.length !== 1) throw new TypeError("one trial cannot use multiple prebuilt task images");
  const manifest = evidence.manifests.find((entry) => entry.image_id === uses[0]?.image_id);
  if (!manifest?.output.config_digest) throw new HitchError("prebuilt task image has no immutable local config digest", { code: "environment_image_manifest_unavailable", exitCode: 12 });
  return manifest.output.config_digest;
}

function validatePair(taskId: string, use: EnvironmentImageUseV1, manifest: EnvironmentImageManifestV1): void {
  const referenceMatches = use.resolution === "prebuilt"
    ? use.requested_reference === manifest.output.reference && use.reference === `${manifest.output.reference}@${manifest.output.manifest_digest}`
    : manifest.output.reference === use.reference;
  if (!use.task_ids.includes(taskId) || manifest.schema_version !== "1" || manifest.image_id !== use.image_id
    || !referenceMatches || manifest.output.manifest_digest !== use.manifest_digest
    || manifest.platform !== use.platform || manifest.source.task_id !== undefined && manifest.source.task_id !== taskId) {
    throw new TypeError("environment image manifest does not match the planned trial image");
  }
}

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function imageMismatch(): HitchError {
  return new HitchError("observed trial container image does not match the immutable image plan", { code: "environment_image_mismatch", exitCode: 12 });
}
