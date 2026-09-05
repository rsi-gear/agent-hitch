import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyTOML } from "smol-toml";
import { benchmarkTreeDigest, loadBenchmark, loadBenchmarkLock } from "../benchmarks/index.js";
import type { LoadedBenchmarkV1 } from "../domain/index.js";
import { atomicWriteJSON, ensureDir, invalidInput, sha256JSON, statePaths, withFileLock } from "../foundation/index.js";
import { newEvalId, validateEvalRequest } from "./request.js";
import { buildBenchmarkAdapterManifest, loadBenchmarkAdapterManifest } from "./benchmark-adapter-manifest.js";
import { runEval } from "./service.js";
import type { EvalResult, RunEvalOptions } from "./service-types.js";

export const STANDARD_BENCHMARK_COMPILER = "harbor-package@6";

export async function runBenchmarkEval(options: Omit<RunEvalOptions, "request"> & {
  request: Record<string, unknown>;
  benchmark?: string;
  benchmarkLock?: string;
}): Promise<EvalResult> {
  if (Boolean(options.benchmark) === Boolean(options.benchmarkLock)) throw invalidInput("provide exactly one of --benchmark or --benchmark-lock");
  if (options.request.dataset) throw invalidInput("--dataset and --benchmark are mutually exclusive");
  if (options.resumeExisting || options.precreated || options.remoteWorkExecutor || options.normalizedRequest) throw invalidInput("standard benchmark packages currently support local managed runs only");
  const loaded = options.benchmark ? await loadBenchmark(options.benchmark) : await loadBenchmarkLock(options.benchmarkLock!);
  if (loaded.tasks.some(t => t.config.driver.kind === "model-call") && (!String(options.request.harness_ref).startsWith("model-call@") || (Array.isArray(options.request.agent_args) && options.request.agent_args.length))) throw invalidInput("no-tools tasks require the trusted model-call harness without agent overrides");
  if (loaded.tasks.some(t => t.config.driver.kind !== "model-call" && t.config.requirements.includes("native-image-input")) && !String(options.request.harness_ref).startsWith("codex@")) throw invalidInput("native-image agent tasks currently require the Codex image-capable harness");
  const evalId = options.evalId ?? newEvalId();
  const compiled = await compileBenchmark(loaded, options.root);
  const request = {
    ...options.request, dataset: compiled.tasks,
    attempts: options.request.attempts ?? loaded.profile.sampling.attempts_per_task,
    max_concurrent: options.request.max_concurrent ?? 1,
    // Zero disables the legacy blanket timeout; each task/bridge owns its budget.
    timeout_ms: options.request.timeout_ms ?? 0,
    setup_timeout_ms: options.request.setup_timeout_ms ?? loaded.profile.budget.setup_timeout_ms,
    infrastructure_retries: options.request.infrastructure_retries ?? loaded.profile.grading.infrastructure_retries,
  };
  const directory = path.join(statePaths(options.root).evals, evalId, "benchmark");
  const normalizedRequest = await validateEvalRequest(request);
  if (normalizedRequest.benchmark_id !== loaded.manifest.id) throw invalidInput("compiled benchmark manifest identity mismatch");
  return runEval({ ...options, evalId, request, normalizedRequest, executionStrategy: "local-task-slots-v1", onControlPhase: async (phase, work) => {
    if (phase === "planning") {
      await ensureDir(directory);
      await atomicWriteJSON(path.join(directory, "benchmark.lock.json"), loaded.lock);
      await atomicWriteJSON(path.join(directory, "manifest.json"), loaded.manifest);
      await atomicWriteJSON(path.join(directory, "effective-profile.json"), {
        ...loaded.profile,
        effective: { attempts: request.attempts, max_concurrent: request.max_concurrent, timeout_ms: request.timeout_ms, seed_applied_to_model: false },
      });
      await atomicWriteJSON(path.join(directory, "package.json"), { source: compiled.source, tasks: compiled.tasks, package_digest: loaded.lock.package_digest, compiled_digest: compiled.digest });
    }
    await options.onControlPhase?.(phase, work);
  } });
}

export async function compileBenchmark(loaded: LoadedBenchmarkV1, root: string): Promise<{ source: string; tasks: string; digest: string }> {
  const digest = sha256JSON({ lock: loaded.lock, compiler: STANDARD_BENCHMARK_COMPILER });
  const store = await ensureDir(path.join(root, "store", "benchmarks"));
  const target = path.join(store, digest.slice(7));
  await withFileLock(path.join(store, "locks"), digest, async () => {
    try {
      const existing = await loadBenchmark(path.join(target, "source"));
      if (sha256JSON(existing.lock) !== sha256JSON(loaded.lock)) throw invalidInput("stored benchmark integrity mismatch");
      const metadata = JSON.parse(await readFile(path.join(target, "compiled.json"), "utf8")) as { digest: string; tasks_digest: string };
      if (metadata.digest !== digest) throw invalidInput("stored benchmark compiler identity mismatch");
      if (metadata.tasks_digest !== await benchmarkTreeDigest(path.join(target, "tasks"))) throw invalidInput("compiled benchmark tasks were modified");
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = await mkdtemp(path.join(store, ".building-"));
    try {
      await cp(loaded.directory, path.join(temporary, "source"), { recursive: true, dereference: false });
      const snapshot = await loadBenchmark(path.join(temporary, "source"));
      if (sha256JSON(snapshot.lock) !== sha256JSON(loaded.lock)) throw invalidInput("benchmark changed while being sealed");
      await mkdir(path.join(temporary, "tasks"));
      for (const task of snapshot.tasks) {
        const taskPath = path.join(temporary, "tasks", task.id);
        await cp(path.join(snapshot.directory, task.path), taskPath, { recursive: true });
        const nativePhases = task.config.driver.kind === "tool-server" && task.config.driver.config.native_phases;
        let finalizationTimeoutMs = loaded.profile.budget.collection_timeout_ms + loaded.profile.budget.cleanup_grace_ms;
        if (nativePhases) {
          // Hitch enforces the original candidate budget in its private phase
          // supervisor. Harbor's outer guard also allows final evidence export
          // and failure teardown without extending the model's deadline.
          // Cancellation/export and host inspection each have a shutdown
          // allowance, bounded by collection_timeout_ms; snapshot has its own.
          const collections = nativePhases.protocol === "hitch-native-phase-control@2" ? 4 : 3;
          finalizationTimeoutMs = collections * loaded.profile.budget.collection_timeout_ms + 2 * loaded.profile.budget.cleanup_grace_ms;
        }
        // The inner Hitch invocation retains the source budget. The outer
        // Harbor guard must also permit process retirement and result export.
        const execution = structuredClone(task.harbor);
        const agent = execution.agent as Record<string, unknown>;
        agent.timeout_sec = Number(agent.timeout_sec) + Math.ceil(finalizationTimeoutMs / 1000);
        await writeFile(path.join(taskPath, "task.toml"), stringifyTOML(execution));
        await atomicWriteJSON(path.join(taskPath, ".hitch-benchmark.json"), {
          schema_version: "1", task_id: task.id, task: task.config,
          profile_digest: loaded.lock.profile_digest, profile: loaded.profile,
          primary_metric: loaded.manifest.primary_metric, metrics: loaded.manifest.metrics,
          score_contract: { total_score: loaded.manifest.primary_metric },
          tools: task.tools, agent_timeout_sec: (task.harbor.agent as Record<string, unknown>).timeout_sec,
          agent_finalization_timeout_ms: finalizationTimeoutMs,
          ...(task.config.driver.kind === "model-call" ? { candidate_input: JSON.parse(await readFile(path.join(snapshot.directory, task.config.driver.config.input), "utf8")) } : {}),
          package_digest: loaded.lock.package_digest, task_digest: loaded.lock.tasks.find((t) => t.task_id === task.id)!.task_digest,
        });
      }
      const primary = loaded.manifest.metrics[loaded.manifest.primary_metric]!;
      const standardManifest = await buildBenchmarkAdapterManifest({
        dataset: path.join(temporary, "tasks"),
        benchmark: { id: loaded.manifest.id, revision: loaded.lock.package_digest },
        adapter: { id: "hitch-package-v1-compiler", revision: digest, output_protocol: "gear-harbor-eval-result-v1" },
        scoring: {
          total_score: {
            source_metric: loaded.manifest.primary_metric,
            direction: primary.direction,
            range: primary.range,
            reducer: "task-macro-mean",
          },
        },
        taskIds: snapshot.tasks.map((task) => task.id),
      });
      await atomicWriteJSON(path.join(temporary, "tasks", "benchmark.adapter.json"), standardManifest);
      await atomicWriteJSON(path.join(temporary, "source", "benchmark.lock.json"), loaded.lock);
      await atomicWriteJSON(path.join(temporary, "compiled.json"), { digest, tasks_digest: await benchmarkTreeDigest(path.join(temporary, "tasks")) });
      await rename(temporary, target);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
  return { source: path.join(target, "source"), tasks: path.join(target, "tasks"), digest };
}

/** Compile any supported Package v1 benchmark into a standalone Harbor dataset. */
export async function exportStandardBenchmarkDataset(packageDirectory: string, outputDirectory: string): Promise<Record<string, unknown>> {
  const output = path.resolve(outputDirectory);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output); // Refuse to overwrite any existing path.
  const temporaryRoot = await mkdtemp(path.join(path.dirname(output), ".hitch-standard-compile-"));
  try {
    const loaded = await loadBenchmark(packageDirectory);
    const compiled = await compileBenchmark(loaded, temporaryRoot);
    for (const entry of await readdir(compiled.tasks)) {
      await cp(path.join(compiled.tasks, entry), path.join(output, entry), { recursive: true, errorOnExist: true, force: false });
    }
    const manifest = await loadBenchmarkAdapterManifest(output);
    if (!manifest) throw invalidInput("compiled benchmark did not produce a standard manifest");
    return {
      dataset: output,
      benchmark_id: manifest.benchmark.id,
      benchmark_revision: manifest.dataset_digest,
      source_package_digest: loaded.lock.package_digest,
      tasks: manifest.tasks.map((task) => task.task_id),
      scoring: manifest.scoring,
    };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
