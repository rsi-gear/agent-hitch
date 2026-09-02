import type { EnvironmentImageFallbackV1, EnvironmentImageUseV1, Sha256 } from "../domain/index.js";

export function imagesForTasks(images: readonly EnvironmentImageUseV1[], taskIds: readonly string[]): EnvironmentImageUseV1[] {
  const selected = new Set(taskIds);
  return images.filter((image) => image.task_ids.some((taskId) => selected.has(taskId)));
}

export function parseEnvironmentImageUses(value: unknown, taskIds: readonly string[], label: string): EnvironmentImageUseV1[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const allowedTasks = new Set(taskIds);
  const uses = value.map((entry, index) => {
    if (!isRecord(entry)) throw new TypeError(`${label} ${index} is invalid`);
    assertOnlyKeys(entry, ["task_ids", "image_id", "requested_reference", "reference", "manifest_digest", "platform", "resolution", "cache_hit"], `${label} ${index}`);
    if (!Array.isArray(entry.task_ids) || entry.task_ids.length === 0 || entry.task_ids.some((task) => typeof task !== "string" || !allowedTasks.has(task))
      || new Set(entry.task_ids).size !== entry.task_ids.length || !isSha256(entry.image_id) || !isSha256(entry.manifest_digest)
      || !validImageReference(entry.requested_reference) || !validImageReference(entry.reference)
      || !(entry.reference as string).endsWith(`@${entry.manifest_digest}`)
      || imageRepository(entry.requested_reference as string) !== imageRepository(entry.reference as string)
      || typeof entry.platform !== "string" || !entry.platform
      || !new Set(["registry", "prebuilt", "backend-build"]).has(entry.resolution as string) || typeof entry.cache_hit !== "boolean") {
      throw new TypeError(`${label} ${index} is invalid`);
    }
    return { ...entry, task_ids: [...entry.task_ids].sort(compareBytes) } as EnvironmentImageUseV1;
  });
  const canonical = [...uses].sort((left, right) => compareBytes(`${left.task_ids.join("\0")}\0${left.requested_reference}`, `${right.task_ids.join("\0")}\0${right.requested_reference}`));
  if (new Set(canonical.map((entry) => `${entry.task_ids.join("\0")}\0${entry.requested_reference}`)).size !== canonical.length) throw new TypeError(`${label} are duplicated`);
  return canonical;
}

export function parseEnvironmentImageFallbacks(value: unknown, taskIds: readonly string[]): EnvironmentImageFallbackV1[] {
  if (!Array.isArray(value)) throw new TypeError("execution plan image fallbacks must be an array");
  const tasks = new Set(taskIds);
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new TypeError(`execution plan image fallback ${index} is invalid`);
    assertOnlyKeys(entry, ["task_id", "source", "service", "code"], `execution plan image fallback ${index}`);
    if (typeof entry.task_id !== "string" || !tasks.has(entry.task_id) || !new Set(["task", "verifier", "compose"]).has(entry.source as string)
      || typeof entry.service !== "string" || !entry.service
      || !new Set(["backend-build", "dynamic-image", "policy-backend", "resolver-unavailable", "resolution-failed"]).has(entry.code as string)) {
      throw new TypeError(`execution plan image fallback ${index} is invalid`);
    }
    return entry as unknown as EnvironmentImageFallbackV1;
  });
}

function validImageReference(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 && !/[\s\0]/.test(value) && !value.includes("://") && !value.includes("$");
}

function imageRepository(reference: string): string {
  const withoutDigest = reference.split("@")[0] as string;
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareBytes(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unexpected) throw new TypeError(`${label} has unknown field: ${unexpected}`);
}
