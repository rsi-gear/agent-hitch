import type { EnvironmentImageFallbackV1, EnvironmentImageUseV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import type { EvalEnvironmentImageBuilder, EvalEnvironmentImageResolver } from "./service-types.js";
import type { LocalTaskPlanningInputV1 } from "./task-resources.js";

export interface PlannedEnvironmentImagesV1 {
  uses: EnvironmentImageUseV1[];
  fallbacks: EnvironmentImageFallbackV1[];
}

export const DEFAULT_ENVIRONMENT_IMAGE_PLATFORM = "linux/amd64";

export async function planEnvironmentImages(input: {
  tasks: readonly LocalTaskPlanningInputV1[];
  mode: "backend" | "prebuild-preferred" | "prebuild-required";
  benchmarkId: string;
  benchmarkRevision: string;
  platform?: string;
  resolver?: EvalEnvironmentImageResolver;
  builder?: EvalEnvironmentImageBuilder;
  signal?: AbortSignal;
}): Promise<PlannedEnvironmentImagesV1> {
  const platform = input.platform ?? DEFAULT_ENVIRONMENT_IMAGE_PLATFORM;
  const uses: EnvironmentImageUseV1[] = [];
  const fallbacks: EnvironmentImageFallbackV1[] = input.tasks.flatMap((task) => task.environment_image_fallbacks.map((entry) => ({
    task_id: task.task_id,
    source: entry.source,
    service: entry.service,
    code: entry.code,
  })));
  const requests = canonicalRequests(input.tasks, platform);
  const builds = canonicalBuilds(input.tasks, platform);
  if (input.mode === "backend") {
    fallbacks.push(...requests.flatMap((entry) => fallbacksFor(entry, "policy-backend")));
    fallbacks.push(...builds.flatMap((entry) => fallbacksFor(entry, "policy-backend")));
  } else {
    if (!input.resolver) fallbacks.push(...requests.flatMap((entry) => fallbacksFor(entry, "resolver-unavailable")));
    else for (const entry of requests) {
      try {
        const resolved = await input.resolver({
          benchmarkId: input.benchmarkId,
          benchmarkRevision: input.benchmarkRevision,
          taskId: entry.taskId,
          reference: entry.reference,
          platform: entry.platform,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!validResolvedImage(entry.reference, entry.platform, resolved)) throw new TypeError("environment image resolver output is invalid");
        uses.push({
          task_ids: [entry.taskId],
          role: entry.role,
          image_id: resolved.image_id,
          requested_reference: entry.reference,
          reference: resolved.reference,
          manifest_digest: resolved.manifest_digest,
          platform: resolved.platform,
          resolution: "registry",
          cache_hit: resolved.cache_hit,
        });
      } catch (error) {
        if ((error as { code?: string }).code === "cancelled") throw error;
        fallbacks.push(...fallbacksFor(entry, "resolution-failed"));
      }
    }
    if (!input.builder) fallbacks.push(...builds.flatMap((entry) => fallbacksFor(entry, "resolver-unavailable")));
    else for (const entry of builds) {
      try {
        const built = await input.builder({
          benchmarkId: input.benchmarkId,
          benchmarkRevision: input.benchmarkRevision,
          taskId: entry.taskId,
          contextDirectory: entry.contextDirectory,
          dockerfile: entry.dockerfile,
          platform: entry.platform,
          ...(entry.sourceKind ? { sourceKind: entry.sourceKind } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!validBuiltImage(entry.platform, built)) throw new TypeError("environment image builder output is invalid");
        uses.push({
          task_ids: [entry.taskId],
          role: entry.role,
          ...(entry.service ? { service: entry.service } : {}),
          image_id: built.image_id,
          requested_reference: built.requested_reference,
          reference: built.reference,
          manifest_digest: built.manifest_digest,
          platform: built.platform,
          resolution: "prebuilt",
          cache_hit: built.cache_hit,
        });
      } catch (error) {
        if ((error as { code?: string }).code === "cancelled") throw error;
        fallbacks.push(...fallbacksFor(entry, "resolution-failed"));
      }
    }
  }
  const result = { uses: canonicalUses(uses), fallbacks: canonicalFallbacks(fallbacks) };
  if (input.mode === "prebuild-required" && result.fallbacks.length > 0) {
    throw new HitchError("required environment image prebuild is unavailable for one or more task services", {
      code: "environment_prebuild_unavailable",
      exitCode: 10,
    });
  }
  return result;
}

function canonicalBuilds(tasks: readonly LocalTaskPlanningInputV1[], defaultPlatform: string): Array<{
  taskId: string;
  platform: string;
  contextDirectory: string;
  dockerfile: string;
  role: "candidate" | "verifier";
  service?: string;
  sourceKind?: "compose-build";
  bindings: Array<{ source: "task" | "verifier" | "compose"; service: string }>;
}> {
  return tasks.flatMap((task) => task.environment_builds.map((entry) => ({
    taskId: task.task_id,
    platform: entry.platform ?? (entry.source === "verifier" ? defaultPlatform : task.runtime_platform ?? defaultPlatform),
    role: entry.source === "verifier" ? "verifier" as const : "candidate" as const,
    contextDirectory: entry.context_directory,
    dockerfile: entry.dockerfile,
    ...(entry.source === "compose" ? { service: entry.service, sourceKind: "compose-build" as const } : {}),
    bindings: [{ source: entry.source, service: entry.service }],
  }))).sort((left, right) => compare(`${left.taskId}\0${left.contextDirectory}\0${left.dockerfile}\0${left.service ?? ""}`, `${right.taskId}\0${right.contextDirectory}\0${right.dockerfile}\0${right.service ?? ""}`));
}

export function resolvedImageMapping(images: readonly EnvironmentImageUseV1[], role: "candidate" | "verifier" = "candidate"): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const image of images) {
    // Historical registry uses lost their source role during grouping. Keep
    // their original global substitution semantics without rewriting records.
    if (image.resolution === "prebuilt" || image.role !== undefined && image.role !== role) continue;
    const existing = result[image.requested_reference];
    if (existing !== undefined && existing !== image.reference) throw new TypeError("environment image reference resolved to multiple immutable images");
    result[image.requested_reference] = image.reference;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => compare(left, right)));
}

function canonicalRequests(tasks: readonly LocalTaskPlanningInputV1[], defaultPlatform: string): Array<{
  taskId: string;
  platform: string;
  reference: string;
  role: "candidate" | "verifier";
  bindings: Array<{ source: "task" | "verifier" | "compose"; service: string }>;
}> {
  const grouped = new Map<string, { taskId: string; platform: string; reference: string; role: "candidate" | "verifier"; bindings: Array<{ source: "task" | "verifier" | "compose"; service: string }> }>();
  for (const task of tasks) for (const entry of task.environment_images) {
    const role = entry.source === "verifier" ? "verifier" : "candidate";
    const key = `${task.task_id}\0${entry.reference}\0${role}`;
    const request = grouped.get(key) ?? { taskId: task.task_id, platform: role === "verifier" ? defaultPlatform : task.runtime_platform ?? defaultPlatform, reference: entry.reference, role, bindings: [] };
    request.bindings.push({ source: entry.source, service: entry.service });
    grouped.set(key, request);
  }
  return [...grouped.values()].sort((left, right) => compare(`${left.taskId}\0${left.reference}\0${left.role}`, `${right.taskId}\0${right.reference}\0${right.role}`));
}

function fallbacksFor(
  request: { taskId: string; bindings: Array<{ source: "task" | "verifier" | "compose"; service: string }> },
  code: "policy-backend" | "resolver-unavailable" | "resolution-failed",
): EnvironmentImageFallbackV1[] {
  return request.bindings.map((entry) => ({ task_id: request.taskId, source: entry.source, service: entry.service, code }));
}

function validResolvedImage(
  requested: string,
  platform: string,
  resolved: Awaited<ReturnType<EvalEnvironmentImageResolver>>,
): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(resolved.image_id)
    && /^sha256:[a-f0-9]{64}$/.test(resolved.manifest_digest)
    && resolved.platform === platform
    && resolved.reference.endsWith(`@${resolved.manifest_digest}`)
    && repositoryOf(requested) === repositoryOf(resolved.reference)
    && typeof resolved.cache_hit === "boolean";
}

function validBuiltImage(
  platform: string,
  built: Awaited<ReturnType<EvalEnvironmentImageBuilder>>,
): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(built.image_id)
    && /^sha256:[a-f0-9]{64}$/.test(built.manifest_digest)
    && built.platform === platform
    && built.reference === `${built.requested_reference}@${built.manifest_digest}`
    && validImageReference(built.requested_reference)
    && typeof built.cache_hit === "boolean";
}

function validImageReference(value: string): boolean {
  return Boolean(value) && value.length <= 1_024 && !/[\s\0]/.test(value) && !value.includes("://") && !value.includes("$");
}

function repositoryOf(reference: string): string {
  const withoutDigest = reference.split("@")[0] as string;
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

function canonicalUses(value: EnvironmentImageUseV1[]): EnvironmentImageUseV1[] {
  return [...value].sort((left, right) => compare(`${left.task_ids[0]}\0${left.requested_reference}\0${left.service ?? ""}\0${left.role ?? ""}`, `${right.task_ids[0]}\0${right.requested_reference}\0${right.service ?? ""}\0${right.role ?? ""}`));
}

function canonicalFallbacks(value: EnvironmentImageFallbackV1[]): EnvironmentImageFallbackV1[] {
  const unique = new Map(value.map((entry) => [`${entry.task_id}\0${entry.source}\0${entry.service}\0${entry.code}`, entry]));
  return [...unique.values()].sort((left, right) => compare(
    `${left.task_id}\0${left.source}\0${left.service}\0${left.code}`,
    `${right.task_id}\0${right.source}\0${right.service}\0${right.code}`,
  ));
}

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
