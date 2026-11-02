import path from "node:path";
import type { EnvironmentImageManifestV1, EnvironmentImageUseV1, ExecutionEvidenceV1, RunEnvironmentImagesV1 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, ensureDir, readJSON, sha256JSON } from "../foundation/index.js";
import type { EvalEnvironmentImageManifestLoader } from "./service-types.js";
import { writeTrialExecutionEvidence } from "./trial-execution-evidence.js";
import { parseEnvironmentImageUses } from "./execution-plan-images.js";
import { resolvedImageMapping } from "./environment-image-planning.js";

export interface TrialEnvironmentImagesV1 {
  uses: EnvironmentImageUseV1[];
  manifests: EnvironmentImageManifestV1[];
}

/** Read only this execution's verifier bindings from previously sealed inputs. */
export async function loadVerifierEnvironmentImages(input: {
  manifestFile: string; taskId: string; uses: readonly EnvironmentImageUseV1[]; sourceConfig: Record<string, unknown>;
}): Promise<TrialEnvironmentImagesV1 | undefined> {
  const uses = input.uses.filter((use) => use.role === "verifier" && use.task_ids.includes(input.taskId));
  if (uses.length === 0) return undefined; // Legacy plans never promised role-specific observations.
  const saved = await readJSON<RunEnvironmentImagesV1>(input.manifestFile);
  const recorded = parseEnvironmentImageUses(saved.uses, [input.taskId], "sealed environment images");
  if (saved.schema_version !== "1" || saved.task_id !== input.taskId
    || uses.some((use) => !recorded.some((entry) => sha256JSON(entry) === sha256JSON(use)))) throw imageMismatch();
  const evidence = await loadTrialEnvironmentImages({ taskId: input.taskId, uses, loader: async (id) => {
    const manifest = saved.manifests.find((entry) => entry.image_id === id);
    if (!manifest) throw imageMismatch();
    return manifest;
  } });
  const environment = input.sourceConfig.environment as { kwargs?: Record<string, unknown> } | undefined;
  const kwargs = environment?.kwargs ?? {};
  if (sha256JSON(kwargs.hitch_prebuilt_verifier_image ?? null) !== sha256JSON(prebuiltVerifierImage(evidence) ?? null)
    || sha256JSON(kwargs.hitch_verifier_resolved_images ?? null) !== sha256JSON(resolvedImageMapping(input.uses, "verifier"))) throw imageMismatch();
  return evidence;
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
  trial?: Record<string, unknown>,
): ExecutionEvidenceV1 {
  if (!evidence) return execution;
  // Harbor explicitly records null executions when setup failed before Target
  // or verifier started. Missing containers must not hide that upstream error.
  const unstartedFailure = trialFailedBeforeExecution(trial);
  const manifests = new Map(evidence.manifests.map((manifest) => [manifest.image_id, manifest]));
  for (const use of evidence.uses) {
    const manifest = manifests.get(use.image_id);
    if (!manifest) throw imageMismatch();
    const expectedConfig = manifest.output.config_digest;
    const roleContainers = execution.observed.containers.filter((container) => use.role !== undefined
      ? container.role === use.role : use.resolution !== "prebuilt" || container.role !== "verifier");
    const boundService = use.service ?? (use.role === "verifier" || use.resolution === "prebuilt" && roleContainers.some((container) => container.service !== undefined) ? "main" : undefined);
    const observed = roleContainers.filter((container) => (!boundService || container.service === boundService)
      && (expectedConfig ? container.image_config_digest !== undefined : container.image_reference !== undefined));
    if (observed.length === 0) {
      if (unstartedFailure || use.role === "verifier" && verifierDidNotStart(trial)) continue;
      throw new HitchError("immutable trial container image evidence is unavailable", {
        code: "environment_image_evidence_unavailable", exitCode: 12,
      });
    }
    const matched = observed.some((container) => expectedConfig
      ? container.image_config_digest === expectedConfig
      : container.image_reference === use.reference);
    if (!matched) throw imageMismatch();
  }
  return execution;
}

export function trialFailedBeforeExecution(trial?: Record<string, unknown>): boolean {
  if (trial?.agent_execution !== null || trial?.verifier !== null || !trial.exception_info || typeof trial.exception_info !== "object") return false;
  const type = (trial.exception_info as Record<string, unknown>).exception_type;
  return typeof type === "string" && /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(type);
}

/** Keep unverified observations in the work directory even when image validation rejects the trial. */
export async function recordTrialEnvironmentImageExecution(
  directory: string,
  execution: ExecutionEvidenceV1,
  evidence?: TrialEnvironmentImagesV1,
): Promise<ExecutionEvidenceV1> {
  await persistTrialEnvironmentImageExecution(directory, execution, evidence);
  return verifyTrialEnvironmentImageExecution(execution, evidence);
}

/** Persist before per-trial validation can decide whether setup ever finished. */
export async function persistTrialEnvironmentImageExecution(
  directory: string,
  execution: ExecutionEvidenceV1,
  evidence?: TrialEnvironmentImagesV1,
): Promise<ExecutionEvidenceV1> {
  await writeTrialExecutionEvidence(directory, execution, { evalId: execution.eval_id, taskId: execution.task_id });
  await writeTrialEnvironmentImageEvidence(directory, execution.task_id, evidence);
  return execution;
}

export function prebuiltTaskImage(evidence?: TrialEnvironmentImagesV1): string | undefined {
  return prebuiltMainImage(evidence, "candidate");
}

export function prebuiltVerifierImage(evidence?: TrialEnvironmentImagesV1): string | undefined {
  return prebuiltMainImage(evidence, "verifier");
}

function prebuiltMainImage(evidence: TrialEnvironmentImagesV1 | undefined, role: "candidate" | "verifier"): string | undefined {
  if (!evidence) return undefined;
  const uses = evidence.uses.filter((use) => use.resolution === "prebuilt" && use.service === undefined && (use.role ?? "candidate") === role);
  if (uses.length === 0) return undefined;
  if (uses.length !== 1) throw new TypeError("one trial cannot use multiple prebuilt task images");
  const manifest = evidence.manifests.find((entry) => entry.image_id === uses[0]?.image_id);
  if (!manifest?.output.config_digest) throw new HitchError("prebuilt task image has no immutable local config digest", { code: "environment_image_manifest_unavailable", exitCode: 12 });
  return manifest.output.config_digest;
}

export function prebuiltServiceImages(evidence?: TrialEnvironmentImagesV1): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const use of evidence?.uses ?? []) {
    if (use.resolution !== "prebuilt" || use.service === undefined || use.role === "verifier") continue;
    const manifest = evidence?.manifests.find((entry) => entry.image_id === use.image_id);
    if (!manifest?.output.config_digest) throw new HitchError("prebuilt service image has no immutable local config digest", { code: "environment_image_manifest_unavailable", exitCode: 12 });
    if (result[use.service] !== undefined && result[use.service] !== manifest.output.config_digest) throw new TypeError("one trial cannot bind a service to multiple prebuilt images");
    result[use.service] = manifest.output.config_digest;
  }
  return result;
}

function validatePair(taskId: string, use: EnvironmentImageUseV1, manifest: EnvironmentImageManifestV1): void {
  const referenceMatches = use.resolution === "prebuilt"
    ? use.requested_reference === manifest.output.reference && use.reference === `${manifest.output.reference}@${manifest.output.manifest_digest}`
    : manifest.output.reference === use.reference;
  if (!use.task_ids.includes(taskId) || manifest.schema_version !== "1" || manifest.image_id !== use.image_id
    || !referenceMatches || manifest.output.manifest_digest !== use.manifest_digest
    || manifest.platform !== use.platform || manifest.source.task_id !== undefined && manifest.source.task_id !== taskId
    || use.service !== undefined && (use.resolution !== "prebuilt" || manifest.source.kind !== "compose-build")) {
    throw new TypeError("environment image manifest does not match the planned trial image");
  }
}

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function imageMismatch(): HitchError {
  return new HitchError("observed trial container image does not match the immutable image plan", { code: "environment_image_mismatch", exitCode: 12 });
}

function verifierDidNotStart(trial?: Record<string, unknown>): boolean {
  if (!trial?.exception_info || typeof trial.exception_info !== "object") return false;
  const type = (trial.exception_info as Record<string, unknown>).exception_type;
  if (type === "VerifierEnvironmentStartTimeoutError" || type === "VerifierEnvironmentStartError") return true;
  // A missing verifier timing record proves that Harbor never entered scoring;
  // require an explicit failure, rather than infer a phase from elapsed time.
  return trial.verifier === null && trial.agent_execution !== undefined
    && typeof type === "string" && /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(type);
}
