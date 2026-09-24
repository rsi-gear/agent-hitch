import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { canonical, object, parseStrictJson, type Binding, type Consumer } from "./protocol.js";
export const roleDirectory = (consumer: Consumer) => consumer.role === "candidate" ? "environment/candidate" : consumer.role === "verifier" ? "tests" : `environment/services/${consumer.serviceId}`;

export async function validateRoleContexts(directory: string, bindings: Binding[], platform: string, images: Array<{ resource: string; reference: string }>): Promise<void> {
  // Package-native phase supervision has its own evidence/replay contract.
  // This backend cannot silently bypass it by treating its descriptor as a
  // normal resource task. A future backend must version that integration.
  if (await lstat(path.join(directory, ".hitch-benchmark.json")).catch(e => { if (e.code !== "ENOENT") throw e; return undefined; })) throw new Error("resource role-context backend does not support Package-native phase descriptors");
  const task = parseToml(await readFile(path.join(directory, "task.toml"), "utf8")) as { verifier?: { environment_mode?: unknown } };
  if (task.verifier?.environment_mode !== "separate") throw new Error("resource tasks require a separate verifier environment");
  const compose = object(parseStrictJson(await readFile(path.join(directory, "environment/docker-compose.yaml"), "utf8")), ["services", "networks", "volumes"]);
  const services = compose.services as Record<string, Record<string, unknown>>;
  if (!services || typeof services !== "object" || !services.main) throw new Error("resource tasks require an explicit candidate Compose service");
  for (const [id, service] of Object.entries(services)) {
    if (!service || typeof service !== "object" || service.platform !== platform) throw new Error("resource service platform mismatch");
    object(service, ["platform", "build", "command", "entrypoint", "environment", "networks", "depends_on", "healthcheck", "working_dir", "init", "user", "ports", "expose"]);
    const consumer: Consumer = id === "main" ? { role: "candidate" } : { role: "service", serviceId: id };
    const expected = id === "main" ? "candidate" : `services/${id}`;
    const build = object(service.build, ["context", "dockerfile"]);
    if (build.context !== expected && build.context !== `./${expected}` || build.dockerfile !== "Dockerfile") throw new Error("resource task build context crosses role boundary");
    if (service.volumes !== undefined) throw new Error("resource task host/volume mounts require an explicitly supported backend capability");
    await checkBases(consumer);
  }
  await checkBases({ role: "verifier" });
  for (const binding of bindings) if (binding.consumer.role === "service" && !services[binding.consumer.serviceId]) throw new Error("resource binding references an absent service");
  async function checkBases(consumer: Consumer) {
    const text = await readFile(path.join(directory, roleDirectory(consumer), "Dockerfile"), "utf8");
    const bases = [...text.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+\S+)?\s*$/gim)].map(m => m[1]!);
    if (/^\s*(?:ADD\s|RUN\s+(?!--network=none\s)|COPY\s+--from|#\s*syntax=)/gim.test(text) || /--mount[=\s]/i.test(text)) throw new Error("resource Dockerfile has undeclared external build inputs");
    const assigned = bindings.filter(b => canonical(b.consumer) === canonical(consumer) && b.use === "environment-image");
    for (const binding of assigned) {
      if (binding.use === "environment-image" && binding.slot !== "build-base") throw new Error("role-context backend requires explicit build-base image bindings");
      const image = images.find(i => i.resource === binding.resource);
      if (!image || !bases.some(base => base.endsWith(`@${image.reference.split('@')[1]}`))) throw new Error("resource image binding does not match role Dockerfile");
    }
    if (!bases.length || bases.some(base => !/@sha256:[a-f0-9]{64}$/.test(base) || !images.some(image => base.endsWith(`@${image.reference.split('@')[1]}`) && assigned.some(b => b.resource === image.resource)))) throw new Error("resource Dockerfile bases must use immutable digests");
  }
}
