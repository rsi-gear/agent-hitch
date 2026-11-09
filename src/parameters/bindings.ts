import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { canonicalJSON, openContainedRegularFile, packageRoot, sha256Bytes, sha256JSON } from "../foundation/index.js";
import { exact, failure, parseParameterJSON, record } from "./schema.js";
export interface CapabilityBinding {
  id: string; plugin: string; protocol: "hitch-service-actions@1"; capabilities: string[]; coverage: string;
  service: string; output_directory: string; entrypoint: string; source: { path: string; sha256: string }; runtime_image: string;
  dependencies: Record<string, string>; counter: { limit_parameter: string; unit: string };
  dependency_packages: Record<string, string>;
  max_action_seconds: number; resource_budget: { cpu_millis: number; memory_bytes: number };
}
export interface VerifiedCapabilityBindings { bindings: CapabilityBinding[]; digest: string }
const verified = new WeakMap<object, CapabilityBinding[]>();
const identifier = (s: unknown) => typeof s === "string" && /^[a-z][a-z0-9_.-]{0,80}$/.test(s);
export function relativeFile(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.startsWith("/") || /[\\\0\r\n]/.test(value) || value.split("/").some(p => !p || p === "." || p === "..")) failure("unsafe capability source path");
}
export function parseCapabilityBindings(value: unknown): CapabilityBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) failure("invalid capability binding list");
  const result = value.map(raw => {
    const b = record(raw, "capability binding");
    exact(b, ["id", "plugin", "protocol", "capabilities", "coverage", "service", "output_directory", "entrypoint", "source", "runtime_image", "dependencies", "dependency_packages", "counter", "max_action_seconds", "resource_budget"], "capability binding");
    if (!identifier(b.id) || typeof b.plugin !== "string" || !/^[a-z][a-z0-9_.-]+@[0-9]+$/.test(b.plugin) || b.protocol !== "hitch-service-actions@1"
      || !identifier(b.service) || b.service === "main" || typeof b.output_directory !== "string" || !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(b.output_directory) || b.output_directory.split("/").includes("..") || typeof b.coverage !== "string" || !b.coverage
      || typeof b.entrypoint !== "string" || !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.py$/.test(b.entrypoint)
      || typeof b.runtime_image !== "string" || !/^[^\s]+@sha256:[a-f0-9]{64}$/.test(b.runtime_image)
      || !Array.isArray(b.capabilities) || !b.capabilities.length || b.capabilities.some(c => typeof c !== "string" || !/^[a-z][a-z0-9_.-]+@[0-9]+$/.test(c))
      || new Set(b.capabilities).size !== b.capabilities.length || !Number.isSafeInteger(b.max_action_seconds) || Number(b.max_action_seconds) < 1 || Number(b.max_action_seconds) > 86400) failure("invalid capability binding");
    const source = record(b.source, "capability source"); exact(source, ["path", "sha256"], "capability source"); relativeFile(source.path);
    if (!source.path.startsWith(`environment/services/${b.service}/`) || !/^sha256:[a-f0-9]{64}$/.test(String(source.sha256))) failure("capability source must belong to its isolated role");
    const deps = record(b.dependencies, "capability dependencies");
    if (!Object.keys(deps).length || Object.entries(deps).some(([key, value]) => !identifier(key) || typeof value !== "string" || !/^[0-9]+(?:\.[0-9]+){1,3}$/.test(value))) failure("capability dependencies must be fixed versions");
    const packages = record(b.dependency_packages, "capability dependency packages");
    if (Object.entries(packages).some(([key, value]) => !Object.hasOwn(deps, key) || typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(value))) failure("invalid capability dependency package mapping");
    if (Object.keys(deps).some(key => key !== "python" && !Object.hasOwn(packages, key))) failure("capability package identity is missing");
    const counter = record(b.counter, "capability counter"); exact(counter, ["limit_parameter", "unit"], "capability counter");
    if (typeof counter.limit_parameter !== "string" || !counter.limit_parameter.startsWith("/") || typeof counter.unit !== "string" || !counter.unit) failure("invalid capability counter");
    const budget = record(b.resource_budget, "capability resource budget"); exact(budget, ["cpu_millis", "memory_bytes"], "capability resource budget");
    if (![budget.cpu_millis, budget.memory_bytes].every(v => Number.isSafeInteger(v) && Number(v) > 0)) failure("invalid capability resource budget");
    return structuredClone(b) as unknown as CapabilityBinding;
  });
  if (new Set(result.map(b => b.id)).size !== result.length || new Set(result.map(b => b.service)).size !== result.length) failure("duplicate capability binding/service");
  return result;
}
async function safeRead(directory: string, file: string): Promise<Buffer> {
  const opened = await openContainedRegularFile(await realpath(directory), file, 1024 * 1024);
  try { const bytes = await opened.handle.readFile(); await opened.assertUnchanged(); return bytes; } finally { await opened.handle.close(); }
}
export async function verifyCapabilityBindings(contract: { capability_bindings?: unknown }, taskDirectory: string): Promise<VerifiedCapabilityBindings> {
  const bindings = parseCapabilityBindings(contract.capability_bindings);
  if (!bindings.length) { const result = { bindings, digest: sha256JSON([]) }; verified.set(result, structuredClone(bindings)); return result; }
  const root = packageRoot();
  let registry: Record<string, unknown>;
  try { registry = record(parseParameterJSON((await safeRead(root, "integrations/capability-plugins.json")).toString()), "installed capability registry"); }
  catch { return failure("unsupported_constraint: installed capability registry unavailable", "unsupported_constraint"); }
  const compose = record(parseParameterJSON((await safeRead(taskDirectory, "environment/docker-compose.yaml")).toString()), "capability Compose");
  const services = record(compose.services, "capability services");
  const task = parseToml((await safeRead(taskDirectory, "task.toml")).toString());
  const taskEnv = record(task.environment, "task environment"), verifier = record(task.verifier, "verifier"), verifierEnv = record(verifier.environment, "verifier environment");
  const taskAgent = record(task.agent, "task agent");
  for (const binding of bindings) {
    const manifestPath = registry[binding.plugin]; relativeFile(manifestPath);
    const manifest = record(parseParameterJSON((await safeRead(root, manifestPath)).toString()), "installed capability plugin");
    if (manifest.version !== 1 || manifest.id !== binding.plugin || manifest.protocol !== binding.protocol || manifest.coverage !== binding.coverage
      || manifest.entrypoint !== binding.entrypoint || canonicalJSON(manifest.capabilities) !== canonicalJSON(binding.capabilities)
      || canonicalJSON(manifest.dependency_packages) !== canonicalJSON(binding.dependency_packages) || canonicalJSON(manifest.dependencies) !== canonicalJSON(binding.dependencies) || manifest.count_unit !== binding.counter.unit) failure("unsupported_constraint: capability binding differs from installed implementation", "unsupported_constraint");
    relativeFile(manifest.source);
    const installed = await safeRead(root, manifest.source);
    if (sha256Bytes(installed) !== binding.source.sha256 || sha256Bytes(await safeRead(taskDirectory, binding.source.path)) !== binding.source.sha256) failure("unsupported_constraint: trusted capability source differs", "unsupported_constraint");
    if (!Array.isArray(task.artifacts) || !task.artifacts.some(a => a && typeof a === "object" && (a as { source?: unknown }).source === binding.output_directory)) failure("capability output directory must be a declared artifact");
    const service = record(services[binding.service], "capability service");
    exact(service, ["platform", "build", "network_mode", "cpus", "mem_limit", "init"], "isolated capability service");
    if (service.init !== true) failure("capability service requires process reaping");
    if (service.network_mode !== "none" || service.volumes !== undefined || service.ports !== undefined || service.expose !== undefined
      || service.pid !== undefined || service.ipc !== undefined || service.privileged !== undefined || service.networks !== undefined) failure("unsupported_constraint: capability service is not isolated", "unsupported_constraint");
    const build = record(service.build, "capability service build");
    exact(build, ["context", "dockerfile"], "capability service build");
    if (build.context !== `services/${binding.service}` || build.dockerfile !== "Dockerfile") failure("unsupported_constraint: capability build crosses role boundary", "unsupported_constraint");
    let dockerfile = (await safeRead(taskDirectory, `environment/services/${binding.service}/Dockerfile`)).toString();
    // Resource materialization adds inert ownership labels and may relocate an
    // immutable image reference. Neither permits changing executable inputs.
    const labels = /\nLABEL dev\.hitch\.resource\.plan="sha256:[a-f0-9]{64}" dev\.hitch\.resource\.consumer=(.+)\n$/.exec(dockerfile);
    if (labels && JSON.parse(labels[1]!) === canonicalJSON({ role: "service", serviceId: binding.service })) dockerfile = dockerfile.slice(0, labels.index);
    const base = /^FROM (\S+)\n/.exec(dockerfile);
    if (base?.[1]?.endsWith("@" + binding.runtime_image.split("@").at(-1)!)) dockerfile = dockerfile.replace(/^FROM \S+\n/, `FROM ${binding.runtime_image}\n`);
    if (!Array.isArray(manifest.runtime_image_digests) || !manifest.runtime_image_digests.includes(binding.runtime_image.slice(binding.runtime_image.lastIndexOf("@") + 1))
      || typeof manifest.build_template !== "string" || dockerfile !== manifest.build_template.replaceAll("${runtime_image}", binding.runtime_image)) failure("unsupported_constraint: capability runtime/build differs from the installed trusted implementation", "unsupported_constraint");
    if (typeof taskAgent.timeout_sec !== "number" || binding.max_action_seconds > taskAgent.timeout_sec) failure("capability action exceeds whole-task wall limit");
    const cpu = Number(taskEnv.cpus) * 1000, memory = Number(taskEnv.memory_mb) * 1024 * 1024;
    const verifierCpu = Number(verifierEnv.cpus) * 1000, verifierMemory = Number(verifierEnv.memory_mb) * 1024 * 1024;
    let totalCpu = cpu + verifierCpu, totalMemory = memory + verifierMemory;
    for (const [id, raw] of Object.entries(services)) if (id !== "main") {
      const sidecar = record(raw, "task service resources"), c = Number(sidecar.cpus) * 1000, m = Number(sidecar.mem_limit);
      if (!Number.isSafeInteger(c) || c < 1 || !Number.isSafeInteger(m) || m < 128 * 1024 * 1024) failure("capability sidecars need explicit bounded CPU/memory");
      totalCpu += c; totalMemory += m;
    }
    if (![cpu, memory, verifierCpu, verifierMemory].every(v => Number.isFinite(v) && v > 0)
      || totalCpu > binding.resource_budget.cpu_millis || totalMemory > binding.resource_budget.memory_bytes) failure("capability roles exceed the admitted total resource budget");
  }
  const result = { bindings, digest: sha256JSON(bindings) }; verified.set(result, structuredClone(bindings)); return result;
}
export function admittedBindings(value: VerifiedCapabilityBindings | undefined): CapabilityBinding[] {
  if (value === undefined) return [];
  if (!verified.has(value)) failure("capability support requires host-verified bindings", "unsupported_constraint");
  return structuredClone(verified.get(value)!);
}
