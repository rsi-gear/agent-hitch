import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { EvalRequest } from "../domain/index.js";
import { readResourceInput } from "../resources/index.js";
import { readJSON, sha256JSON, statePaths } from "../foundation/index.js";
import { loadBenchmarkAdapterManifest, readStandardBenchmarkManifest, verifyBenchmarkTaskMembership, verifyBenchmarkTaskSnapshot } from "./benchmark-adapter-manifest.js";
import type { BenchmarkAdapterManifest, BenchmarkAdapterManifestV1 } from "./benchmark-adapter-manifest.js";

declare const executionBrand: unique symbol;
declare const trialBrand: unique symbol;
export interface VerifiedBenchmarkExecution { readonly [executionBrand]: true }
export interface VerifiedTrialBenchmark { readonly [trialBrand]: true }
export interface BenchmarkVerificationBinding {
  root: string; evalId: string; evalDirectory: string; request: EvalRequest; revisionIdentity: string;
}
interface ExecutionReceipt {
  binding: string; datasetRoot: string; dev: number; ino: number;
  manifest: BenchmarkAdapterManifestV1;
}
export interface TrialBenchmarkBinding extends BenchmarkVerificationBinding {
  benchmarkId: string; benchmarkRevision: string; taskId: string; trialDirectory: string;
}
interface TrialReceipt { binding: string; trialDirectory: string; taskId: string; manifest: BenchmarkAdapterManifest | null; descriptor?: unknown | null }
const executions = new WeakMap<VerifiedBenchmarkExecution, ExecutionReceipt>();
const trials = new WeakMap<VerifiedTrialBenchmark, TrialReceipt>();

/** Only a complete content verification can mint the execution capability. */
export async function verifyBenchmarkExecution(input: BenchmarkVerificationBinding): Promise<VerifiedBenchmarkExecution | null> {
  const manifest = await loadBenchmarkAdapterManifest(input.request.dataset);
  if (!manifest || manifest.schema_version !== "1") return null;
  if (manifest.benchmark.id !== input.request.benchmark_id || manifest.dataset_digest !== input.request.benchmark_revision) {
    throw new TypeError("benchmark adapter identity differs from the frozen eval request");
  }
  const root = await realpath(input.root), evalDirectory = await realpath(input.evalDirectory);
  if (evalDirectory !== path.join(statePaths(root).evals, input.evalId)) throw new TypeError("benchmark execution eval directory differs");
  const request = await readJSON<EvalRequest>(path.join(evalDirectory, "request.json"));
  if (requestIdentity(request) !== requestIdentity(input.request)) throw new TypeError("benchmark execution request differs from admission");
  const datasetRoot = await realpath(input.request.dataset), info = await lstat(datasetRoot);
  const receipt = Object.freeze({}) as VerifiedBenchmarkExecution;
  executions.set(receipt, { binding: await binding(input), datasetRoot, dev: info.dev, ino: info.ino, manifest: structuredClone(manifest) });
  return receipt;
}

/** The task comes from the imported trial identity, never a caller-selected manifest scope. */
export async function verifyTrialBenchmark(input: BenchmarkVerificationBinding & { benchmarkId: string; benchmarkRevision: string; trialDirectory: string }, taskId: string,
  execution?: VerifiedBenchmarkExecution): Promise<VerifiedTrialBenchmark> {
  const key = await binding(input);
  if (input.benchmarkId !== input.request.benchmark_id || input.benchmarkRevision !== input.request.benchmark_revision) {
    throw new TypeError("trial benchmark differs from the eval request");
  }
  let manifest: BenchmarkAdapterManifest | null;
  let descriptor: unknown | null | undefined;
  if (execution) {
    const admitted = executions.get(execution);
    if (!admitted || admitted.binding !== key) throw new TypeError("benchmark execution receipt identity changed");
    const datasetRoot = await realpath(input.request.dataset), info = await lstat(datasetRoot);
    if (datasetRoot !== admitted.datasetRoot || info.dev !== admitted.dev || info.ino !== admitted.ino) throw new TypeError("benchmark dataset root identity changed");
    const request = await readJSON<EvalRequest>(path.join(input.evalDirectory, "request.json"));
    if (requestIdentity(request) !== requestIdentity(input.request)) throw new TypeError("benchmark execution request changed after admission");
    manifest = await readStandardBenchmarkManifest(datasetRoot);
    if (!manifest || manifest.dataset_digest !== admitted.manifest.dataset_digest || sha256JSON(manifest) !== sha256JSON(admitted.manifest)) {
      throw new TypeError("benchmark adapter manifest changed after eval admission");
    }
    await verifyBenchmarkTaskMembership(datasetRoot, manifest);
    const task = manifest.tasks.find(item => item.task_id === taskId);
    if (!task) throw new TypeError("trial task is absent from the admitted benchmark manifest");
    descriptor = (await verifyBenchmarkTaskSnapshot(datasetRoot, task)).descriptor;
  } else {
    manifest = await loadBenchmarkAdapterManifest(input.request.dataset);
    if (manifest?.schema_version === "1") {
      const task = manifest.tasks.find(item => item.task_id === taskId);
      if (!task) throw new TypeError("trial task is absent from the benchmark manifest");
      // Full compatibility paths retain their native descriptor checks below.
    }
  }
  if (manifest && (manifest.benchmark.id !== input.benchmarkId || manifest.dataset_digest !== input.benchmarkRevision)) {
    throw new TypeError("benchmark adapter manifest changed after eval admission");
  }
  const receipt = Object.freeze({}) as VerifiedTrialBenchmark;
  trials.set(receipt, { binding: key, trialDirectory: path.resolve(input.trialDirectory), taskId, manifest: manifest ? structuredClone(manifest) : null, ...(descriptor === undefined ? {} : { descriptor }) });
  return receipt;
}

export async function verifiedTrialManifest(receipt: VerifiedTrialBenchmark, input: TrialBenchmarkBinding): Promise<BenchmarkAdapterManifest | null> {
  const verified = assertTrialBinding(receipt, input);
  // Refresh metadata only; task content and descriptor bytes remain the verified import snapshot.
  const resource = await readResourceInput(input.request.dataset);
  const current = resource ? ("schema_version" in resource ? resource : { ...resource.manifest, tasks: resource.tasks, dataset_digest: resource.digest })
    : await readStandardBenchmarkManifest(await realpath(input.request.dataset).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return path.resolve(input.request.dataset);
      throw error;
    }));
  if (sha256JSON(current) !== sha256JSON(verified.manifest)) throw new TypeError("benchmark adapter manifest changed during trial import");
  return verified.manifest ? structuredClone(verified.manifest) : null;
}

export function verifiedNativeDescriptor(receipt: VerifiedTrialBenchmark, input: TrialBenchmarkBinding): unknown | null | undefined {
  const verified = assertTrialBinding(receipt, input);
  return verified.descriptor === undefined ? undefined : structuredClone(verified.descriptor);
}

function assertTrialBinding(receipt: VerifiedTrialBenchmark, input: TrialBenchmarkBinding): TrialReceipt {
  const verified = trials.get(receipt);
  if (!verified || !input || verified.binding !== binding(input) || verified.taskId !== input.taskId
    || verified.trialDirectory !== path.resolve(input.trialDirectory)
    || input.benchmarkId !== input.request.benchmark_id || input.benchmarkRevision !== input.request.benchmark_revision) {
    throw new TypeError("trial verification receipt identity changed");
  }
  return verified;
}

function requestIdentity(request: EvalRequest): string {
  const { max_concurrent: _parallelism, ...identity } = request;
  return sha256JSON(identity);
}
function binding(input: BenchmarkVerificationBinding): string {
  return sha256JSON({ root: path.resolve(input.root), evalId: input.evalId, evalDirectory: path.resolve(input.evalDirectory),
    request: requestIdentity(input.request), revision: input.revisionIdentity });
}
