export const DEFAULT_EVAL_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_EVAL_SETUP_TIMEOUT_MS = 30 * 60 * 1_000;
export const DEFAULT_INFRASTRUCTURE_RETRIES = 1;
export const DEFAULT_INFRASTRUCTURE_RETRY_BACKOFF_MS = 1_000;

const HARBOR_EVAL_BYPASS_ARG: Readonly<Record<string, string>> = {
  codex: "--dangerously-bypass-approvals-and-sandbox",
  opencode: "--dangerously-skip-permissions",
};

export function newEvalId(): EvalId {
  return `eval_${randomUUID().replaceAll("-", "")}` as EvalId;
}

export function validateEvalId(value: string): EvalId {
  if (!/^eval_[a-f0-9]{32}$/.test(value)) throw invalidInput(`invalid eval ID: ${value}`);
  return value as EvalId;
}

export interface EvalRequestInput {
  schema_version?: unknown;
  backend?: unknown;
  dataset?: unknown;
  harness_ref?: unknown;
  model?: unknown;
  attempts?: unknown;
  max_concurrent?: unknown;
  infrastructure_retries?: unknown;
  infrastructure_retry_backoff_ms?: unknown;
  timeout_ms?: unknown;
  setup_timeout_ms?: unknown;
  agent_args?: unknown;
  pass_env?: unknown;
}

export async function validateEvalRequest(input: EvalRequestInput): Promise<EvalRequest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidInput("eval request must be a JSON object");
  const allowed = new Set([
    "schema_version", "backend", "dataset", "harness_ref", "model", "attempts",
    "max_concurrent", "infrastructure_retries", "infrastructure_retry_backoff_ms",
    "timeout_ms", "setup_timeout_ms", "agent_args", "pass_env",
  ]);
  const unexpected = Object.keys(input).find((field) => !allowed.has(field));
  if (unexpected) throw invalidInput(`unknown eval request field: ${unexpected}`);
  if (input.schema_version !== undefined && input.schema_version !== SCHEMA_VERSION) throw invalidInput(`unsupported schema_version: ${input.schema_version}`);
  if ((input.backend || "harbor") !== "harbor") throw invalidInput("only the harbor eval backend is currently supported");
  if (typeof input.dataset !== "string" || !input.dataset.trim()) throw invalidInput("dataset must be a non-empty string");
  if (typeof input.harness_ref !== "string" || !input.harness_ref.trim()) throw invalidInput("harness_ref must be a non-empty string");
  const reference = parseHarnessReference(input.harness_ref);
  if (reference.selector.type === "installed") {
    throw invalidInput("eval requires an immutable harness ref: version:<exact> or commit:<sha>");
  }
  assertExactLocalGitEvalReference(reference);
  const benchmark = await resolveDatasetReference(input.dataset.trim());
  const attempts = positiveInteger(input.attempts ?? 1, "attempts");
  const maxConcurrent = positiveInteger(input.max_concurrent ?? 4, "max_concurrent");
  const infrastructureRetries = nonNegativeInteger(
    input.infrastructure_retries ?? DEFAULT_INFRASTRUCTURE_RETRIES,
    "infrastructure_retries",
  );
  const infrastructureRetryBackoff = nonNegativeNumber(
    input.infrastructure_retry_backoff_ms ?? DEFAULT_INFRASTRUCTURE_RETRY_BACKOFF_MS,
    "infrastructure_retry_backoff_ms",
  );
  const timeout = nonNegativeNumber(input.timeout_ms ?? (benchmark.manifest ? 0 : DEFAULT_EVAL_TIMEOUT_MS), "timeout_ms");
  const setupTimeout = nonNegativeNumber(input.setup_timeout_ms ?? DEFAULT_EVAL_SETUP_TIMEOUT_MS, "setup_timeout_ms");
  if (input.model !== undefined && typeof input.model !== "string") throw invalidInput("model must be a string");
  if (input.agent_args !== undefined && (!Array.isArray(input.agent_args) || input.agent_args.some((value) => typeof value !== "string"))) {
    throw invalidInput("agent_args must be an array of strings");
  }
  if (input.pass_env !== undefined && (!Array.isArray(input.pass_env) || input.pass_env.some((value) => typeof value !== "string"))) {
    throw invalidInput("pass_env must be an array of strings");
  }
  const agentArgs = Array.isArray(input.agent_args) ? [...input.agent_args] as string[] : [];
  if (benchmark.manifest) {
    await assertStandardBenchmarkCandidate(input.dataset.trim(), benchmark.manifest, reference.harness_id, agentArgs);
  }
  const bypassArg = HARBOR_EVAL_BYPASS_ARG[reference.harness_id];
  if (bypassArg && !agentArgs.includes(bypassArg)) agentArgs.unshift(bypassArg);
  return {
    schema_version: SCHEMA_VERSION,
    backend: "harbor",
    dataset: String(input.dataset).trim(),
    harness_ref: reference.canonical,
    model: typeof input.model === "string" ? input.model : "",
    attempts,
    max_concurrent: maxConcurrent,
    infrastructure_retries: infrastructureRetries,
    infrastructure_retry_backoff_ms: infrastructureRetryBackoff,
    timeout_ms: timeout,
    setup_timeout_ms: setupTimeout,
    agent_args: agentArgs,
    pass_env: [...new Set(Array.isArray(input.pass_env) ? input.pass_env as string[] : [])],
    benchmark_id: benchmark.benchmark_id,
    benchmark_revision: benchmark.benchmark_revision,
  };
}

export async function resolveBenchmarkReference(dataset: string): Promise<{ benchmark_id: string; benchmark_revision: string }> {
  const { benchmark_id, benchmark_revision } = await resolveDatasetReference(dataset);
  return { benchmark_id, benchmark_revision };
}

async function resolveDatasetReference(dataset: string): Promise<{
  benchmark_id: string;
  benchmark_revision: string;
  manifest: BenchmarkAdapterManifestV1 | null;
}> {
  const raw = dataset.trim();
  const local = path.resolve(raw);
  try {
    if ((await stat(local)).isDirectory()) {
      const manifest = await loadBenchmarkAdapterManifest(local);
      if (manifest) {
        return {
          benchmark_id: manifest.benchmark.id,
          benchmark_revision: manifest.dataset_digest,
          manifest,
        };
      }
      return {
        benchmark_id: `local:${path.basename(local)}`,
        benchmark_revision: await workspaceDigest(local, { excludedTopLevel: new Set([".git"]) }),
        manifest: null,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const separator = raw.lastIndexOf("@");
  if (separator <= 0 || separator === raw.length - 1) {
    throw invalidInput("dataset must include an immutable revision (for example benchmark@1.0)");
  }
  const benchmarkId = raw.slice(0, separator);
  const revision = raw.slice(separator + 1);
  if (revision.toLowerCase() === "latest") throw invalidInput("dataset revision cannot be latest");
  return { benchmark_id: benchmarkId, benchmark_revision: revision, manifest: null };
}

export async function resolveLocalDatasetTaskIds(dataset: string): Promise<string[] | null> {
  const local = path.resolve(dataset.trim());
  try {
    if (!(await stat(local)).isDirectory()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (await isRegularFile(path.join(local, "task.toml"))) return [path.basename(local)];
  const entries = await readdir(local, { withFileTypes: true });
  const tasks: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && await isRegularFile(path.join(local, entry.name, "task.toml"))) tasks.push(entry.name);
  }
  return tasks;
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw invalidInput(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalidInput(`${name} must be a non-negative integer`);
  return parsed;
}

function nonNegativeNumber(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw invalidInput(`${name} must be a non-negative number`);
  return parsed;
}
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { EvalId, EvalRequest } from "../domain/index.js";
import { SCHEMA_VERSION, invalidInput } from "../foundation/index.js";
import { assertExactLocalGitEvalReference, parseHarnessReference } from "../revisions/index.js";
import { workspaceDigest } from "../workspaces/index.js";
import { loadBenchmarkAdapterManifest, type BenchmarkAdapterManifestV1 } from "./benchmark-adapter-manifest.js";
import { assertStandardBenchmarkCandidate } from "./benchmark-candidate.js";
