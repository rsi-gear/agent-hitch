import { constants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { HitchError, packageRoot, resolveExecutable, runCommand } from "../../foundation/index.js";
import { locateHarbor } from "./tools.js";

const INSPECTOR = path.join(packageRoot(), "integrations", "harbor", "hitch_harbor_task_resources.py");

export interface HarborTaskResourceDeclarationV1 {
  schema_version: "1";
  runtime_platform?: string;
  task: { cpu_millis?: number; memory_bytes?: number; gpu_count?: number };
  verifier: { separate: boolean; environment?: { cpu_millis?: number; memory_bytes?: number; gpu_count?: number } };
  compose_services: Array<{ name: string; replicas: number; cpu_millis?: number; memory_bytes?: number; gpu_count?: number }>;
  provider_sidecars: { main_egress: boolean; verifier_egress: boolean };
  environment_images: HarborEnvironmentImageDeclarationV1[];
  environment_image_fallbacks: HarborEnvironmentImageFallbackV1[];
  environment_builds: HarborEnvironmentBuildDeclarationV1[];
}

export interface HarborEnvironmentImageDeclarationV1 {
  source: "task" | "verifier" | "compose";
  service: string;
  reference: string;
}

export interface HarborEnvironmentImageFallbackV1 {
  source: "task" | "verifier" | "compose";
  service: string;
  code: "backend-build" | "dynamic-image";
}

export interface HarborEnvironmentBuildDeclarationV1 {
  source: "task";
  service: "main";
  context: "environment";
  dockerfile: "Dockerfile";
}

export async function inspectHarborTaskResources(input: {
  root: string;
  taskDirectory: string;
  harborExecutable?: string;
  inspectorPath?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<HarborTaskResourceDeclarationV1> {
  const env = input.env ?? process.env;
  const harbor = await locateHarbor({ root: input.root, explicit: input.harborExecutable, env });
  if (!harbor.executable) throw unavailable(`Harbor executable not found: ${harbor.requested}`);
  const python = await harborPython(harbor.executable, env);
  if (!python) throw unavailable("could not locate Harbor's Python interpreter");
  let output: string;
  try {
    output = (await runCommand(python, [input.inspectorPath ?? INSPECTOR, input.taskDirectory], {
      env,
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: 10_000,
      failureCode: "task_resource_inspection_failed",
      failureExitCode: 10,
    })).stdout;
  } catch (error) {
    if (error instanceof HitchError) throw error;
    throw unavailable((error as Error)?.message || String(error));
  }
  try {
    return parseHarborTaskResourceDeclaration(JSON.parse(output));
  } catch (error) {
    throw new HitchError(`Harbor task resource inspector returned invalid output: ${(error as Error).message}`, {
      code: "task_resource_inspection_invalid",
      exitCode: 10,
      cause: error,
    });
  }
}

export function parseHarborTaskResourceDeclaration(value: unknown): HarborTaskResourceDeclarationV1 {
  const root = exactRecord(value, [
    "schema_version", "task", "verifier", "compose_services", "provider_sidecars",
    "environment_images", "environment_image_fallbacks",
    "environment_builds",
  ], "task resource declaration", ["runtime_platform"]);
  if (root.schema_version !== "1") throw new TypeError("task resource declaration schema is invalid");
  const runtimePlatform = root.runtime_platform === undefined ? undefined : normalizeRuntimePlatform(root.runtime_platform);
  const task = resourcePair(root.task, "task resources");
  const verifierRecord = exactRecord(root.verifier, ["separate"], "verifier resources", ["environment"]);
  if (typeof verifierRecord.separate !== "boolean") throw new TypeError("verifier resource mode is invalid");
  const verifier = {
    separate: verifierRecord.separate,
    ...(verifierRecord.environment === undefined ? {} : { environment: resourcePair(verifierRecord.environment, "verifier environment resources") }),
  };
  if (!Array.isArray(root.compose_services)) throw new TypeError("Compose resource services are invalid");
  const composeServices = root.compose_services.map((entry, index) => {
    const service = exactRecord(entry, ["name", "replicas"], `Compose service ${index}`, ["cpu_millis", "memory_bytes", "gpu_count"]);
    if (typeof service.name !== "string" || !service.name || !Number.isSafeInteger(service.replicas) || (service.replicas as number) < 1) {
      throw new TypeError(`Compose service ${index} identity is invalid`);
    }
    return { name: service.name, replicas: service.replicas as number, ...resourcePair(service, `Compose service ${index} resources`) };
  });
  if (new Set(composeServices.map((service) => service.name)).size !== composeServices.length) throw new TypeError("Compose service names are duplicated");
  const sidecars = exactRecord(root.provider_sidecars, ["main_egress", "verifier_egress"], "provider sidecars");
  if (typeof sidecars.main_egress !== "boolean" || typeof sidecars.verifier_egress !== "boolean") throw new TypeError("provider sidecar declaration is invalid");
  const environmentImages = imageDeclarations(root.environment_images);
  const environmentImageFallbacks = imageFallbacks(root.environment_image_fallbacks);
  const environmentBuilds = imageBuilds(root.environment_builds);
  return {
    schema_version: "1",
    ...(runtimePlatform ? { runtime_platform: runtimePlatform } : {}),
    task,
    verifier,
    compose_services: composeServices,
    provider_sidecars: { main_egress: sidecars.main_egress, verifier_egress: sidecars.verifier_egress },
    environment_images: environmentImages,
    environment_image_fallbacks: environmentImageFallbacks,
    environment_builds: environmentBuilds,
  };
}

function normalizeRuntimePlatform(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("task runtime platform is invalid");
  const normalized = value.trim().toLowerCase()
    .replace(/^linux\/x86_64$/, "linux/amd64")
    .replace(/^linux\/aarch64$/, "linux/arm64");
  if (normalized !== "linux/amd64" && normalized !== "linux/arm64") {
    throw new TypeError("task runtime platform is unsupported");
  }
  return normalized;
}

function imageBuilds(value: unknown): HarborEnvironmentBuildDeclarationV1[] {
  if (!Array.isArray(value)) throw new TypeError("environment build declarations are invalid");
  return value.map((entry, index) => {
    const record = exactRecord(entry, ["source", "service", "context", "dockerfile"], `environment build ${index}`);
    if (record.source !== "task" || record.service !== "main" || record.context !== "environment" || record.dockerfile !== "Dockerfile") {
      throw new TypeError(`environment build ${index} is invalid`);
    }
    return record as unknown as HarborEnvironmentBuildDeclarationV1;
  });
}

function imageDeclarations(value: unknown): HarborEnvironmentImageDeclarationV1[] {
  if (!Array.isArray(value)) throw new TypeError("environment image declarations are invalid");
  const result = value.map((entry, index) => {
    const record = exactRecord(entry, ["source", "service", "reference"], `environment image ${index}`);
    if (!new Set(["task", "verifier", "compose"]).has(record.source as string)
      || typeof record.service !== "string" || !record.service
      || typeof record.reference !== "string" || !validImageReference(record.reference)) {
      throw new TypeError(`environment image ${index} is invalid`);
    }
    return record as unknown as HarborEnvironmentImageDeclarationV1;
  });
  const keys = result.map((entry) => `${entry.source}\0${entry.service}`);
  if (new Set(keys).size !== keys.length) throw new TypeError("environment image declarations are duplicated");
  return result;
}

function imageFallbacks(value: unknown): HarborEnvironmentImageFallbackV1[] {
  if (!Array.isArray(value)) throw new TypeError("environment image fallbacks are invalid");
  return value.map((entry, index) => {
    const record = exactRecord(entry, ["source", "service", "code"], `environment image fallback ${index}`);
    if (!new Set(["task", "verifier", "compose"]).has(record.source as string)
      || typeof record.service !== "string" || !record.service
      || (record.code !== "backend-build" && record.code !== "dynamic-image")) {
      throw new TypeError(`environment image fallback ${index} is invalid`);
    }
    return record as unknown as HarborEnvironmentImageFallbackV1;
  });
}

function validImageReference(value: string): boolean {
  return value.length <= 1_024 && !/[\s\0]/.test(value) && !value.includes("://") && !value.includes("$");
}

async function harborPython(harborExecutable: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const sibling = path.join(path.dirname(harborExecutable), process.platform === "win32" ? "python.exe" : "python");
  const candidates = [env.HITCH_HARBOR_PYTHON_PATH, sibling];
  if (process.platform !== "win32") {
    try {
      const firstLine = (await readFile(harborExecutable, "utf8")).split(/\r?\n/, 1)[0] || "";
      const shebang = firstLine.match(/^#!([^\s]+)$/)?.[1];
      if (shebang) candidates.unshift(shebang);
    } catch { /* locateHarbor already validated executable access */ }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.isAbsolute(candidate) || candidate.includes("/") || candidate.includes("\\")
      ? await preserveExecutableShim(candidate)
      : await resolveExecutable(candidate, env.PATH || "", env.PATHEXT);
    if (resolved) return resolved;
  }
  return null;
}

async function preserveExecutableShim(candidate: string): Promise<string | null> {
  const resolved = path.resolve(candidate);
  try {
    await access(resolved, constants.X_OK);
    if ((await lstat(resolved)).isDirectory()) return null;
    // A virtualenv's python is commonly a symlink to the base interpreter.
    // Spawning the symlink is what activates the venv prefix and site-packages;
    // realpath would silently turn it back into the system interpreter.
    return resolved;
  } catch {
    return null;
  }
}

function resourcePair(value: unknown, label: string): { cpu_millis?: number; memory_bytes?: number; gpu_count?: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  for (const field of ["cpu_millis", "memory_bytes", "gpu_count"] as const) {
    if (record[field] !== undefined && (!Number.isSafeInteger(record[field]) || (record[field] as number) < 1)) throw new TypeError(`${label} ${field} is invalid`);
  }
  return {
    ...(record.cpu_millis === undefined ? {} : { cpu_millis: record.cpu_millis as number }),
    ...(record.memory_bytes === undefined ? {} : { memory_bytes: record.memory_bytes as number }),
    ...(record.gpu_count === undefined ? {} : { gpu_count: record.gpu_count as number }),
  };
}

function exactRecord(value: unknown, required: string[], label: string, optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in record)) || Object.keys(record).some((key) => !allowed.has(key))) throw new TypeError(`${label} fields are invalid`);
  return record;
}

function unavailable(message: string): HitchError {
  return new HitchError(`Harbor task resource inspection is unavailable: ${message}`, { code: "task_resource_inspection_unavailable", exitCode: 10 });
}
