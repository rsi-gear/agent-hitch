import { cp, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { benchmarkTreeDigest, loadBenchmark, loadBenchmarkLock } from "../benchmarks/index.js";
import type { LoadedBenchmarkV1 } from "../domain/index.js";
import { atomicWriteJSON, ensureDir, invalidInput, sha256JSON, statePaths, withFileLock } from "../foundation/index.js";
import { newEvalId, validateEvalRequest } from "./request.js";
import { runEval } from "./service.js";
import type { EvalResult, RunEvalOptions } from "./service-types.js";

export async function runBenchmarkEval(options: Omit<RunEvalOptions, "request"> & {
  request: Record<string, unknown>;
  benchmark?: string;
  benchmarkLock?: string;
}): Promise<EvalResult> {
  if (Boolean(options.benchmark) === Boolean(options.benchmarkLock)) throw invalidInput("provide exactly one of --benchmark or --benchmark-lock");
  if (options.request.dataset) throw invalidInput("--dataset and --benchmark are mutually exclusive");
  if (options.resumeExisting || options.precreated || options.remoteWorkExecutor || options.normalizedRequest) throw invalidInput("standard benchmark packages currently support local managed runs only");
  const loaded = options.benchmark ? await loadBenchmark(options.benchmark) : await loadBenchmarkLock(options.benchmarkLock!);
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
  const normalizedRequest = { ...await validateEvalRequest(request), benchmark_id: loaded.manifest.id, benchmark_revision: loaded.lock.package_digest };
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

async function compileBenchmark(loaded: LoadedBenchmarkV1, root: string): Promise<{ source: string; tasks: string; digest: string }> {
  const digest = sha256JSON({ lock: loaded.lock, compiler: "harbor-tool-server@1" });
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
        await atomicWriteJSON(path.join(taskPath, ".hitch-benchmark.json"), {
          schema_version: "1", task_id: task.id, task: task.config,
          profile_digest: loaded.lock.profile_digest, profile: loaded.profile,
          primary_metric: loaded.manifest.primary_metric, metrics: loaded.manifest.metrics,
          tools: task.tools, agent_timeout_sec: (task.harbor.agent as Record<string, unknown>).timeout_sec,
          package_digest: loaded.lock.package_digest, task_digest: loaded.lock.tasks.find((t) => t.task_id === task.id)!.task_digest,
        });
      }
      await atomicWriteJSON(path.join(temporary, "source", "benchmark.lock.json"), loaded.lock);
      await atomicWriteJSON(path.join(temporary, "compiled.json"), { digest, tasks_digest: await benchmarkTreeDigest(path.join(temporary, "tasks")) });
      await rename(temporary, target);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
  return { source: path.join(target, "source"), tasks: path.join(target, "tasks"), digest };
}
