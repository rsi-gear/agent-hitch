import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { channel } from "node:diagnostics_channel";
import path from "node:path";
import type { Sha256 } from "../domain/index.js";
import { invalidInput, openContainedRegularFile } from "../foundation/index.js";
import { readResourceInput, type ResourceDataset } from "../resources/index.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export interface BenchmarkScoreDefinitionV1 {
  source_metric: string;
  direction: "maximize" | "minimize";
  range: readonly [number, number];
  reducer: "task-macro-mean";
}

export interface BenchmarkScoreContractV1 {
  total_score: BenchmarkScoreDefinitionV1;
  process_score?: BenchmarkScoreDefinitionV1;
}

export interface BenchmarkAdapterManifestV1 {
  schema_version: "1";
  kind: "gear-harbor-benchmark";
  benchmark: { id: string; revision: string };
  adapter: { id: string; revision: string; output_protocol: "gear-harbor-eval-result-v1" };
  scoring: BenchmarkScoreContractV1;
  /** Gear owns extraction semantics; Hitch retains and integrity-binds this registry. */
  raw_metrics?: { schema_version: "1"; metrics: Array<Record<string, unknown>> };
  tasks: Array<{ task_id: string; task_digest: Sha256 }>;
  dataset_digest: Sha256;
}
export type BenchmarkAdapterManifest = BenchmarkAdapterManifestV1 | ResourceDataset;

/** Build the canonical manifest for an already-materialized Harbor dataset. */
export async function buildBenchmarkAdapterManifest(input: {
  dataset: string;
  benchmark: BenchmarkAdapterManifestV1["benchmark"];
  adapter: BenchmarkAdapterManifestV1["adapter"];
  scoring: BenchmarkScoreContractV1;
  taskIds: readonly string[];
}): Promise<BenchmarkAdapterManifestV1> {
  const ids = [...input.taskIds].sort();
  if (!ids.length || new Set(ids).size !== ids.length) throw invalidInput("benchmark adapter task IDs must be non-empty and unique");
  const tasks = await Promise.all(ids.map(async (id) => {
    const valid = taskId(id);
    const directory = path.join(path.resolve(input.dataset), valid);
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw invalidInput(`manifest task is missing: ${valid}`);
      throw error;
    });
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalidInput(`manifest task is not a directory: ${valid}`);
    return { task_id: valid, task_digest: await taskTreeDigest(directory) };
  }));
  const body = {
    schema_version: "1" as const,
    kind: "gear-harbor-benchmark" as const,
    benchmark: input.benchmark,
    adapter: input.adapter,
    scoring: input.scoring,
    tasks,
  };
  return { ...body, dataset_digest: sha256(canonicalJson(body)) };
}

/** Load and integrity-check the optional Gear standardized-dataset manifest. */
export async function loadBenchmarkAdapterManifest(dataset: string): Promise<BenchmarkAdapterManifest | null> {
  const resource = await readResourceInput(dataset);
  if (resource) return "schema_version" in resource ? resource : { ...resource.manifest, tasks: resource.tasks, dataset_digest: resource.digest };
  const root = await realpath(dataset).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return path.resolve(dataset);
    throw error;
  });
  const manifest = await readStandardBenchmarkManifest(root);
  if (!manifest) return null;
  await verifyBenchmarkTaskMembership(root, manifest);
  for (const task of manifest.tasks) {
    if (await taskTreeDigest(path.join(root, task.task_id)) !== task.task_digest) throw invalidInput(`manifest task digest mismatch: ${task.task_id}`);
  }
  return manifest;
}

/** Internal metadata view. Content verification remains mandatory at admission. */
export async function readStandardBenchmarkManifest(root: string): Promise<BenchmarkAdapterManifestV1 | null> {
  let raw: unknown;
  try {
    const safe = await openContainedRegularFile(root, "benchmark.adapter.json", 16 * 1024 * 1024);
    try {
      raw = JSON.parse((await safe.handle.readFile()).toString("utf8"));
      await safe.assertUnchanged();
    } finally { await safe.handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw invalidInput("benchmark.adapter.json is invalid JSON");
    throw error;
  }
  const manifest = parseManifest(raw);
  const { dataset_digest: _digest, ...body } = manifest;
  if (manifest.dataset_digest !== sha256(canonicalJson(body))) throw invalidInput("benchmark adapter dataset digest mismatch");
  return manifest;
}

export async function verifyBenchmarkTaskMembership(root: string, manifest: BenchmarkAdapterManifestV1): Promise<void> {
  for (const task of manifest.tasks) {
    const info = await lstat(path.join(root, task.task_id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw invalidInput(`manifest task is missing: ${task.task_id}`);
      throw error;
    });
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalidInput(`manifest task is not a directory: ${task.task_id}`);
  }
  const taskDirectories: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const taskInfo = await lstat(path.join(root, entry.name, "task.toml"));
      if (taskInfo.isFile() && !taskInfo.isSymbolicLink()) taskDirectories.push(entry.name);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (JSON.stringify(taskDirectories.sort()) !== JSON.stringify(manifest.tasks.map(task => task.task_id))) {
    throw invalidInput("benchmark adapter manifest task set does not match the dataset");
  }
}

/** Snapshot one admitted task, including descriptor bytes from the same verified read. */
export async function verifyBenchmarkTaskSnapshot(root: string, task: BenchmarkAdapterManifestV1["tasks"][number]): Promise<{ descriptor: unknown | null }> {
  const snapshot = await scanTaskTree(path.join(root, task.task_id));
  if (snapshot.digest !== task.task_digest) throw invalidInput(`manifest task digest mismatch: ${task.task_id}`);
  return { descriptor: snapshot.descriptor === undefined ? null : JSON.parse(snapshot.descriptor.toString("utf8")) };
}

export function scoreWithinRange(score: number, definition: BenchmarkScoreDefinitionV1): boolean {
  return score >= definition.range[0] && score <= definition.range[1];
}

function parseManifest(value: unknown): BenchmarkAdapterManifestV1 {
  const record = object(value, "benchmark adapter manifest");
  exact(record, ["schema_version", "kind", "benchmark", "adapter", "scoring", "raw_metrics", "tasks", "dataset_digest"], "benchmark adapter manifest");
  if (record.schema_version !== "1" || record.kind !== "gear-harbor-benchmark") throw invalidInput("unsupported benchmark adapter manifest");
  const benchmark = namedRevision(record.benchmark, "benchmark");
  const adapterRecord = object(record.adapter, "adapter");
  exact(adapterRecord, ["id", "revision", "output_protocol"], "adapter");
  if (adapterRecord.output_protocol !== "gear-harbor-eval-result-v1") throw invalidInput("unsupported benchmark adapter output protocol");
  const adapter = { id: identifier(adapterRecord.id, "adapter id"), revision: immutableRevision(adapterRecord.revision, "adapter revision"), output_protocol: adapterRecord.output_protocol } as const;
  const scoringRecord = object(record.scoring, "scoring");
  exact(scoringRecord, ["total_score", "process_score"], "scoring");
  const scoring: BenchmarkScoreContractV1 = {
    total_score: scoreDefinition(scoringRecord.total_score, "total_score"),
    ...(scoringRecord.process_score === undefined ? {} : { process_score: scoreDefinition(scoringRecord.process_score, "process_score") }),
  };
  if (!Array.isArray(record.tasks) || record.tasks.length === 0) throw invalidInput("benchmark adapter tasks must be a non-empty array");
  const tasks = record.tasks.map((raw, index) => {
    const task = object(raw, `task ${index}`);
    exact(task, ["task_id", "task_digest"], `task ${index}`);
    return { task_id: taskId(task.task_id), task_digest: digest(task.task_digest, `task ${index} digest`) };
  });
  const ids = tasks.map((task) => task.task_id);
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify([...ids].sort())) {
    throw invalidInput("benchmark adapter task IDs must be unique and sorted");
  }
  return {
    schema_version: "1",
    kind: "gear-harbor-benchmark",
    benchmark,
    adapter,
    scoring,
    ...(record.raw_metrics === undefined ? {} : { raw_metrics: rawMetricRegistry(record.raw_metrics) }),
    tasks,
    dataset_digest: digest(record.dataset_digest, "dataset digest"),
  };
}

function rawMetricRegistry(value: unknown): NonNullable<BenchmarkAdapterManifestV1["raw_metrics"]> {
  const registry = object(value, "raw_metrics");
  exact(registry, ["schema_version", "metrics"], "raw_metrics");
  if (registry.schema_version !== "1" || !Array.isArray(registry.metrics)) {
    throw invalidInput("unsupported raw metric registry");
  }
  const metrics = registry.metrics.map((value, index) => {
    const metric = object(value, `raw metric ${index}`);
    identifier(metric.id, `raw metric ${index} id`);
    return metric;
  });
  if (new Set(metrics.map((metric) => metric.id)).size !== metrics.length) {
    throw invalidInput("duplicate raw metric id");
  }
  return { schema_version: "1", metrics };
}

function namedRevision(value: unknown, label: string): { id: string; revision: string } {
  const record = object(value, label);
  exact(record, ["id", "revision"], label);
  return { id: identifier(record.id, `${label} id`), revision: immutableRevision(record.revision, `${label} revision`) };
}

function scoreDefinition(value: unknown, label: string): BenchmarkScoreDefinitionV1 {
  const record = object(value, label);
  exact(record, ["source_metric", "direction", "range", "reducer"], label);
  if (record.direction !== "maximize" && record.direction !== "minimize") throw invalidInput(`${label} direction is invalid`);
  if (record.reducer !== "task-macro-mean") throw invalidInput(`${label} reducer is invalid`);
  if (!Array.isArray(record.range) || record.range.length !== 2 || record.range.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw invalidInput(`${label} range is invalid`);
  }
  const range = [record.range[0] as number, record.range[1] as number] as const;
  if (range[0] > range[1]) throw invalidInput(`${label} range is reversed`);
  return { source_metric: identifier(record.source_metric, `${label} source metric`), direction: record.direction, range, reducer: "task-macro-mean" };
}

const contentReads = channel("hitch.benchmark.task-content-read");

async function taskTreeDigest(root: string): Promise<Sha256> { return (await scanTaskTree(root)).digest; }

async function scanTaskTree(inputRoot: string): Promise<{ digest: Sha256; descriptor?: Buffer }> {
  const original = await lstat(inputRoot);
  if (!original.isDirectory() || original.isSymbolicLink()) throw invalidInput("benchmark task directory is unsafe");
  const root = await realpath(inputRoot);
  const resolved = await lstat(root);
  if (resolved.dev !== original.dev || resolved.ino !== original.ino) throw invalidInput("benchmark task root identity changed");
  const rows: Array<{ path: string; mode: "file" | "executable"; sha256: string }> = [];
  const fingerprints: Array<{ path: string; info: Awaited<ReturnType<typeof lstat>> }> = [];
  let descriptor: Buffer | undefined;
  const visit = async (directory: string): Promise<void> => {
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw invalidInput("benchmark task directory is unsafe");
    fingerprints.push({ path: directory, info: before });
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw invalidInput(`benchmark task contains a symlink: ${relative}`);
      if (info.isDirectory()) await visit(absolute);
      else if (info.isFile()) {
        // Dataset hardlinks remain supported. Open without following links and
        // verify pathname/handle identity and content metadata before closing.
        const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes: Buffer;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw invalidInput("benchmark file identity changed while opening");
          bytes = await handle.readFile();
          const after = await handle.stat(), pathname = await lstat(absolute);
          if (pathname.isSymbolicLink() || pathname.dev !== info.dev || pathname.ino !== info.ino
            || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs
            || await realpath(absolute) !== absolute) throw invalidInput("benchmark file changed while being read");
        } finally { await handle.close(); }
        fingerprints.push({ path: absolute, info });
        if (contentReads.hasSubscribers) contentReads.publish({ root, path: relative, bytes: bytes.length });
        if (relative === ".hitch-benchmark.json") descriptor = bytes;
        rows.push({ path: relative, mode: info.mode & 0o111 ? "executable" : "file", sha256: createHash("sha256").update(bytes).digest("hex") });
      } else throw invalidInput(`benchmark task contains a special file: ${relative}`);
    }
  };
  await visit(root);
  for (const saved of fingerprints) {
    const current = await lstat(saved.path);
    if (current.isSymbolicLink() || current.dev !== saved.info.dev || current.ino !== saved.info.ino
      || current.mode !== saved.info.mode || current.size !== saved.info.size
      || current.mtimeMs !== saved.info.mtimeMs || current.ctimeMs !== saved.info.ctimeMs) {
      throw invalidInput("benchmark task changed while being verified");
    }
  }
  return { digest: sha256(JSON.stringify(rows)), ...(descriptor === undefined ? {} : { descriptor }) };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): Sha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}` as Sha256;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(record: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  const extra = Object.keys(record).find((field) => !allowed.has(field));
  if (extra) throw invalidInput(`${label} has unknown field: ${extra}`);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw invalidInput(`${label} is invalid`);
  return value;
}

function immutableRevision(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.toLowerCase() === "latest") throw invalidInput(`${label} is invalid`);
  return value;
}

function taskId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value) || value === "." || value === "..") throw invalidInput("task id is invalid");
  return value;
}

function digest(value: unknown, label: string): Sha256 {
  if (typeof value !== "string" || !SHA256.test(value)) throw invalidInput(`${label} is invalid`);
  return value as Sha256;
}
