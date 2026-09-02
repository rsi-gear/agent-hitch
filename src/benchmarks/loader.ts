import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkEnvironmentRefV1, BenchmarkFileV1, BenchmarkLockV1, BenchmarkTaskV1, LoadedBenchmarkV1, Sha256 } from "../domain/index.js";
import { atomicWriteJSON, invalidInput, sha256Bytes, sha256JSON } from "../foundation/index.js";
import { parseBenchmarkToml } from "./toml.js";
import { fields, object, parseManifest, parseProfile, parseTask, relativePath, unsupported } from "./validation.js";

const RESOLVER_VERSION = "1";

export async function loadBenchmark(directory: string): Promise<LoadedBenchmarkV1> {
  directory = path.resolve(directory);
  const files = await inventory(directory);
  const available = new Set(files.map((f) => f.path));
  const required = (name: string): string => {
    relativePath(name);
    if (!available.has(name)) throw invalidInput(`required package file missing: ${name}`);
    return path.join(directory, name);
  };
  const read = async (name: string) => JSON.parse(await readFile(required(name), "utf8")) as unknown;
  const manifest = parseManifest(parseBenchmarkToml(await readFile(required("benchmark.toml"), "utf8")));
  const profile = parseProfile(await read(manifest.default_profile));
  if (profile.track !== manifest.publication.track) throw invalidInput("profile and publication tracks differ");
  const sourceManifest = await read("source-manifest.json");
  const provenance = object(sourceManifest, "source manifest");
  const transformations: BenchmarkLockV1["transformations"] = [];
  if (provenance.transformations !== undefined && !Array.isArray(provenance.transformations)) throw invalidInput("source transformations must be an array");
  for (const transformation of (provenance.transformations ?? []) as unknown[]) {
    const entry = fields(transformation, ["kind", "before_path", "after_path"], "source transformation");
    if (typeof entry.kind !== "string") throw invalidInput("invalid transformation kind");
    required(relativePath(entry.before_path)); required(relativePath(entry.after_path));
    transformations.push({ kind: entry.kind, before: files.find((f) => f.path === entry.before_path)!.digest, after: files.find((f) => f.path === entry.after_path)!.digest });
  }
  let sourceAdapter: BenchmarkLockV1["source_adapter"];
  if (provenance.adapter !== undefined) {
    const adapter = object(provenance.adapter, "source adapter provenance");
    if (typeof adapter.id !== "string" || typeof adapter.version !== "string") throw invalidInput("invalid source adapter provenance");
    if (adapter.path !== undefined) {
      const adapterPath = relativePath(adapter.path); required(adapterPath);
      sourceAdapter = { id: adapter.id, version: adapter.version, code_digest: files.find((f) => f.path === adapterPath)!.digest };
    }
  }
  const treeDigest = (prefix: string): Sha256 => {
    const subset = files.filter((f) => f.path === prefix || f.path.startsWith(`${prefix}/`));
    if (!subset.length) throw invalidInput(`empty or missing package component: ${prefix}`);
    return sha256JSON(subset.map((f) => ({ ...f, path: f.path.slice(prefix.length) })));
  };
  const components = manifest.runtime_components.map((c) => ({ id: c.id, protocol: c.protocol, content_digest: treeDigest(c.path) }));
  const tasks: LoadedBenchmarkV1["tasks"] = [];
  const lockedTasks: BenchmarkLockV1["tasks"] = [];
  const sourceIds = new Set<string>();
  const actualTaskIds = (await readdir(path.join(directory, manifest.task_root), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (JSON.stringify(actualTaskIds) !== JSON.stringify([...manifest.task_ids].sort())) throw invalidInput("task directory membership differs from manifest task_ids");
  for (const id of [...manifest.task_ids].sort()) {
    const taskPath = `${manifest.task_root}/${id}`;
    const config = parseTask(await read(`${taskPath}/task.hitch.json`), manifest);
    if (sourceIds.has(config.source_task_id)) throw invalidInput("duplicate source_task_id");
    sourceIds.add(config.source_task_id);
    const harbor = parseBenchmarkToml(await readFile(required(`${taskPath}/task.toml`), "utf8"));
    validateHarbor(harbor, config);
    required(`${taskPath}/tests/test.sh`);
    let tools: unknown[] = [];
    if (config.driver.kind === "model-call") {
      if (!config.driver.config.input.startsWith(`${taskPath}/environment/`)) throw invalidInput("model input must be in the candidate environment");
      required(config.driver.config.input);
    }
    if (config.driver.kind === "tool-server") {
      required(`${taskPath}/environment/docker-compose.yaml`);
      required(`${taskPath}/tests/Dockerfile`);
      const schema = await read(config.driver.config.schema);
      validateTools(schema); tools = schema;
    }
    required(`${taskPath}/instruction.md`);
    for (const cap of config.requirements) if (!profile.tool_policy.allowed.includes(cap)) throw invalidInput(`profile does not grant required capability: ${cap}`);
    if (config.driver.kind === "tool-server" && config.driver.config.native_phases
      && config.driver.config.native_phases.shutdown_timeout_ms > profile.budget.collection_timeout_ms) throw invalidInput("native phase shutdown exceeds profile collection allowance");
    for (const [phase, hook] of Object.entries(config.lifecycle)) {
      const limit = phase === "prepare" ? profile.budget.setup_timeout_ms : phase === "cleanup" ? profile.budget.cleanup_grace_ms : profile.budget.collection_timeout_ms;
      if (hook.timeout_ms > limit) throw invalidInput(`hook ${phase} timeout exceeds profile phase budget`);
    }
    const taskDigest = sha256JSON({ tree: treeDigest(taskPath), components, tools: sha256JSON(tools) });
    const environments: BenchmarkEnvironmentRefV1[] = [];
    for (const area of ["environment", "tests"]) {
      const baseImages = new Set<Sha256>();
      const dockerfiles = files.filter((f) => f.path.startsWith(`${taskPath}/${area}/`) && /^Dockerfile(?:\.|$)/.test(path.basename(f.path)));
      for (const dockerfile of dockerfiles) {
        const stages = new Set<string>();
        let continued = false;
        for (const line of (await readFile(required(dockerfile.path), "utf8")).split(/\r?\n/)) {
          const continuation = continued;
          if (line.trim() && !line.trimStart().startsWith("#")) continued = line.trimEnd().endsWith("\\");
          if (continuation) continue;
          const match = /^\s*FROM\s+(?:--platform=linux\/amd64\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
          if (!match) { if (/^\s*FROM\b/i.test(line)) unsupported("unsupported Docker FROM syntax"); continue; }
          const image = match[1]!;
          if (image !== "scratch" && !stages.has(image)) {
            const digest = /@sha256:([a-f0-9]{64})$/.exec(image);
            if (!digest) throw invalidInput(`unresolved base image: ${image}`);
            baseImages.add(`sha256:${digest[1]}`);
          }
          if (match[2]) stages.add(match[2]);
        }
      }
      environments.push({ role: area, kind: "build", context_digest: treeDigest(`${taskPath}/${area}`), base_image_digests: [...baseImages].sort(), platform: "linux/amd64" });
    }
    lockedTasks.push({ task_id: id, source_task_id: config.source_task_id, path: taskPath, task_digest: taskDigest, input_digest: treeDigest(`${taskPath}/instruction.md`), grader_digest: sha256JSON({ tests: treeDigest(`${taskPath}/tests`), components }), environment_refs: environments });
    tasks.push({ id, path: taskPath, config, harbor, tools });
  }
  // Values, modes and paths participate in identity; host directory and mtime do not.
  const packageDigest = sha256JSON(files);
  const resolverFiles = await Promise.all(["loader", "validation", "toml", "metrics"].map(async (name) => sha256Bytes(await readFile(new URL(`./${name}.js`, import.meta.url)))));
  resolverFiles.push(sha256JSON(await inventory(path.dirname(fileURLToPath(import.meta.resolve("smol-toml"))))));
  const lock: BenchmarkLockV1 = {
    schema_version: "1", protocol: "hitch-benchmark@1", benchmark_id: manifest.id, release: manifest.release,
    package_digest: packageDigest,
    source: {
      kind: manifest.source.kind,
      uri: manifest.source.kind === "local" ? `cas:${packageDigest}` : manifest.source.uri!,
      resolved_revision: manifest.source.kind === "local" ? packageDigest : manifest.source.resolved_revision!,
      access: manifest.source.access ?? "public", manifest_digest: sha256JSON(sourceManifest),
    },
    resolver: { id: "hitch-benchmark", version: RESOLVER_VERSION, code_digest: sha256JSON(resolverFiles) },
    ...(sourceAdapter ? { source_adapter: sourceAdapter } : {}),
    components: components.map((c) => ({ role: c.id, uri: `cas:${c.content_digest}`, resolved_revision: c.content_digest, digest: c.content_digest })),
    task_dialect: manifest.task_format, runtime_components: components, tasks: lockedTasks,
    profile_digest: sha256JSON(profile), required_capabilities: [...new Set(tasks.flatMap((t) => t.config.requirements))].sort(),
    metric_spec_digest: sha256JSON({ primary: manifest.primary_metric, metrics: manifest.metrics }), files, transformations,
  };
  return { directory, manifest, profile, tasks, lock };
}

export async function benchmarkTreeDigest(directory: string): Promise<Sha256> {
  return sha256JSON(await inventory(directory));
}

export async function validateBenchmark(directory: string): Promise<Record<string, unknown>> {
  const loaded = await loadBenchmark(directory);
  return { valid: true, protocol: loaded.lock.protocol, benchmark_id: loaded.manifest.id, package_digest: loaded.lock.package_digest, tasks: loaded.lock.tasks, required_capabilities: loaded.lock.required_capabilities };
}

export async function lockBenchmark(directory: string, output = path.join(directory, "benchmark.lock.json")): Promise<BenchmarkLockV1> {
  // A custom lock file outside the package avoids changing package identity.
  const inside = path.relative(path.resolve(directory), path.resolve(output));
  if (!inside.startsWith("..") && !path.isAbsolute(inside) && inside !== "benchmark.lock.json") throw invalidInput("an in-package lock must be named benchmark.lock.json");
  const loaded = await loadBenchmark(directory);
  await atomicWriteJSON(output, loaded.lock);
  return loaded.lock;
}

export async function loadBenchmarkLock(file: string, directory = path.dirname(file)): Promise<LoadedBenchmarkV1> {
  const lock = JSON.parse(await readFile(file, "utf8")) as unknown;
  const loaded = await loadBenchmark(directory);
  if (sha256JSON(lock) !== sha256JSON(loaded.lock)) throw invalidInput("benchmark lock does not match the current package/resolver; create a new lock explicitly");
  return loaded;
}

async function inventory(directory: string, prefix = ""): Promise<BenchmarkFileV1[]> {
  const files: BenchmarkFileV1[] = [];
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalidInput("package directory must be a real directory");
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && entry.name === "benchmark.lock.json" && entry.isFile()) continue;
    relativePath(name);
    const absolute = path.join(directory, entry.name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) unsupported(`package special files/symlinks are unsupported: ${name}`);
    if (stat.isDirectory()) files.push(...await inventory(absolute, name));
    else files.push({ path: name, digest: sha256Bytes(await readFile(absolute)), bytes: stat.size, mode: stat.mode & 0o777 });
  }
  return files;
}

function validateTools(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value) || !value.length) throw invalidInput("tool schema must be a nonempty array");
  const names = new Set<string>();
  for (const tool of value) {
    const item = fields(tool, ["name", "description", "inputSchema"], "tool");
    if (typeof item.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(item.name) || names.has(item.name)) throw invalidInput("invalid or duplicate tool name");
    if (typeof item.description !== "string") throw invalidInput("missing tool description");
    const schema = object(item.inputSchema, "tool inputSchema");
    if (schema.type !== "object") unsupported("tool inputSchema must describe an object");
    names.add(item.name);
  }
}

function validateHarbor(h: Record<string, unknown>, task: BenchmarkTaskV1): void {
  if (task.driver.kind !== "tool-server") {
    // Preserve the native Harbor task rather than imposing the sidecar dialect.
    // The existing Harbor inspector validates the full resource/config model.
    fields(h, ["schema_version", "version", "task", "metadata", "agent", "environment", "verifier", "artifacts", "solution", "source"], "Harbor task");
    if (h.schema_version !== undefined && h.schema_version !== "1.4") unsupported("unsupported Harbor task schema");
    const agent = object(h.agent, "Harbor agent");
    if (typeof agent.timeout_sec !== "number" || agent.timeout_sec <= 0) throw invalidInput("task agent timeout must be positive");
    const environment = object(h.environment, "Harbor environment");
    if (environment.network_mode !== undefined && environment.network_mode !== "public") unsupported("terminal profile requires public network");
    const verifier = object(h.verifier, "Harbor verifier");
    const mode = verifier.environment_mode ?? "shared";
    if (!["shared", "separate"].includes(String(mode))) unsupported("unsupported verifier mode");
    if (!task.requirements.includes(`${mode}-verifier`)) throw invalidInput("verifier isolation must be declared in requirements");
    if (task.submission.final_response && mode !== "separate") throw invalidInput("canonical final response requires a separate verifier");
    if (mode === "separate" && task.submission.kind !== "artifacts") throw invalidInput("separate verifier requires explicit artifacts");
    const artifacts = h.artifacts ?? [];
    if (!Array.isArray(artifacts)) throw invalidInput("invalid Harbor artifacts");
    const paths = artifacts.map(a => typeof a === "string" ? a : object(a, "artifact").source);
    if (task.submission.kind === "artifacts" && JSON.stringify([...paths].sort()) !== JSON.stringify([...task.submission.paths].sort())) throw invalidInput("submission paths and Harbor artifacts differ");
    return;
  }
  const service = task.driver.config.service, paths = task.submission.paths;
  fields(h, ["schema_version", "metadata", "agent", "environment", "verifier", "artifacts"], "Harbor task");
  if (h.schema_version !== "1.4") unsupported("unsupported Harbor task schema");
  const agent = fields(h.agent, ["timeout_sec"], "Harbor agent");
  if (typeof agent.timeout_sec !== "number" || agent.timeout_sec <= 0) throw invalidInput("task agent timeout must be positive");
  const environment = fields(h.environment, ["cpus", "memory_mb", "storage_mb", "build_timeout_sec", "workdir", "network_mode"], "Harbor environment");
  if (environment.network_mode !== "public") unsupported("MVP task network must be explicitly public");
  const verifier = fields(h.verifier, ["timeout_sec", "environment_mode", "environment"], "Harbor verifier");
  if (verifier.environment_mode !== "separate") unsupported("tool-server tasks require a separate verifier");
  fields(verifier.environment, ["cpus", "memory_mb", "storage_mb", "build_timeout_sec", "network_mode"], "Harbor verifier environment");
  if (!Array.isArray(h.artifacts)) throw invalidInput("missing authoritative artifacts");
  const sources = h.artifacts.map((a) => {
    const artifact = fields(a, ["source", "service"], "artifact");
    if (artifact.service !== service) unsupported("tool-server snapshots must originate from the declared sidecar");
    return artifact.source;
  });
  if (JSON.stringify([...sources].sort()) !== JSON.stringify([...paths].sort())) throw invalidInput("submission paths and Harbor artifacts differ");
}
