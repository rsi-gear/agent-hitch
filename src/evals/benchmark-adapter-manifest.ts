import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Sha256 } from "../domain/index.js";
import { invalidInput } from "../foundation/index.js";

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
  tasks: Array<{ task_id: string; task_digest: Sha256 }>;
  dataset_digest: Sha256;
}

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
export async function loadBenchmarkAdapterManifest(dataset: string): Promise<BenchmarkAdapterManifestV1 | null> {
  const root = path.resolve(dataset);
  let raw: unknown;
  try {
    const info = await lstat(path.join(root, "benchmark.adapter.json"));
    if (!info.isFile() || info.isSymbolicLink()) throw invalidInput("benchmark.adapter.json must be a regular file");
    raw = JSON.parse(await readFile(path.join(root, "benchmark.adapter.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw invalidInput("benchmark.adapter.json is invalid JSON");
    throw error;
  }
  const manifest = parseManifest(raw);
  const actualTasks: Array<{ task_id: string; task_digest: Sha256 }> = [];
  for (const task of manifest.tasks) {
    const directory = path.join(root, task.task_id);
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw invalidInput(`manifest task is missing: ${task.task_id}`);
      throw error;
    });
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalidInput(`manifest task is not a directory: ${task.task_id}`);
    const digest = await taskTreeDigest(directory);
    if (digest !== task.task_digest) throw invalidInput(`manifest task digest mismatch: ${task.task_id}`);
    actualTasks.push({ task_id: task.task_id, task_digest: digest });
  }
  const taskDirectories: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const taskInfo = await lstat(path.join(root, entry.name, "task.toml"));
      if (taskInfo.isFile() && !taskInfo.isSymbolicLink()) taskDirectories.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (JSON.stringify(taskDirectories.sort()) !== JSON.stringify(actualTasks.map((task) => task.task_id))) {
    throw invalidInput("benchmark adapter manifest task set does not match the dataset");
  }
  const body = {
    schema_version: manifest.schema_version,
    kind: manifest.kind,
    benchmark: manifest.benchmark,
    adapter: manifest.adapter,
    scoring: manifest.scoring,
    tasks: actualTasks,
  };
  const expected = sha256(canonicalJson(body));
  if (manifest.dataset_digest !== expected) throw invalidInput("benchmark adapter dataset digest mismatch");
  return manifest;
}

export function scoreWithinRange(score: number, definition: BenchmarkScoreDefinitionV1): boolean {
  return score >= definition.range[0] && score <= definition.range[1];
}

function parseManifest(value: unknown): BenchmarkAdapterManifestV1 {
  const record = object(value, "benchmark adapter manifest");
  exact(record, ["schema_version", "kind", "benchmark", "adapter", "scoring", "tasks", "dataset_digest"], "benchmark adapter manifest");
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
    tasks,
    dataset_digest: digest(record.dataset_digest, "dataset digest"),
  };
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

async function taskTreeDigest(root: string): Promise<Sha256> {
  const rows: Array<{ path: string; mode: "file" | "executable"; sha256: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw invalidInput(`benchmark task contains a symlink: ${relative}`);
      if (info.isDirectory()) await visit(absolute);
      else if (info.isFile()) rows.push({ path: relative, mode: info.mode & 0o111 ? "executable" : "file", sha256: createHash("sha256").update(await readFile(absolute)).digest("hex") });
      else throw invalidInput(`benchmark task contains a special file: ${relative}`);
    }
  };
  await visit(root);
  return sha256(JSON.stringify(rows));
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
