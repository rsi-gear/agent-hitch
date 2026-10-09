import type { TestContext } from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EvalId, EvalRequest, RunContextV1 } from "../src/domain/index.js";
import type { ResolvedRevision } from "../src/artifacts/index.js";
import { atomicWriteJSON } from "../src/foundation/index.js";
import { benchmarkTaskDigest, benchmarkVerifierIdentity } from "../src/runs/index.js";
import { buildBenchmarkAdapterManifest } from "../src/evals/benchmark-adapter-manifest.js";
import { importEvalTrialRun } from "../src/evals/trial-import.js";
import { createEvalProgress, writeEvalProgress } from "../src/evals/progress.js";
import { EvalEventSink } from "../src/evals/events.js";
import { ProgressPublisher } from "../src/evals/planned-progress-publisher.js";
import type { VerifiedBenchmarkExecution } from "../src/evals/benchmark-verification.js";
import { TrajectoryProjector } from "../src/trajectories/projector.js";
import { TrajectoryWriter, canonicalTrajectoryFileRef, trajectoryRefV2 } from "../src/trajectories/store.js";

export const publicationTimestamp = "2026-10-09T00:00:00.000Z";
export const publicationCandidate = `sha256:${"a".repeat(64)}` as const;

export async function publicationFixture(t: TestContext, count = 1, standard = true) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "hitch-publication-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evalId = `eval_${"e".repeat(32)}` as EvalId;
  const dataset = path.join(root, "dataset"), evalDirectory = path.join(root, "evals", evalId);
  const taskIds = Array.from({ length: count }, (_, index) => `task-${String(index + 1).padStart(3, "0")}`);
  for (const taskId of taskIds) {
    const directory = path.join(dataset, taskId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "task.toml"), 'schema_version = "1.4"\n');
    await writeFile(path.join(directory, "instruction.md"), `Solve ${taskId}.\n`);
    await writeFile(path.join(directory, "data.txt"), `private fixture input ${taskId}\n`);
  }
  const benchmarkId = "publication-fixture";
  const manifest = await buildBenchmarkAdapterManifest({ dataset, taskIds,
    benchmark: { id: benchmarkId, revision: "1" },
    adapter: { id: "fixture", revision: publicationCandidate, output_protocol: "gear-harbor-eval-result-v1" },
    scoring: {
      total_score: { source_metric: "success", direction: "maximize", range: [0, 1], reducer: "task-macro-mean" },
      process_score: { source_metric: "process_quality", direction: "maximize", range: [0, 1], reducer: "task-macro-mean" },
    } });
  if (standard) await atomicWriteJSON(path.join(dataset, "benchmark.adapter.json"), manifest);
  const benchmarkRevision = standard ? manifest.dataset_digest : "legacy-1";
  const request: EvalRequest = { schema_version: "1", backend: "harbor", dataset, harness_ref: "codex@version:1.0.0", model: "synthetic-model",
    attempts: 1, max_concurrent: count, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0,
    timeout_ms: 0, setup_timeout_ms: 1000, agent_args: [], pass_env: [], benchmark_id: benchmarkId, benchmark_revision: benchmarkRevision };
  const resolvedRevision: ResolvedRevision = { schema_version: "1", requested_ref: request.harness_ref, canonical_ref: request.harness_ref,
    harness_id: "codex", selector: { type: "version", value: "1.0.0" }, source: { type: "npm" },
    revision: { type: "version", version: "1.0.0" }, identity: publicationCandidate, resolved_at: publicationTimestamp };
  await atomicWriteJSON(path.join(evalDirectory, "request.json"), request);
  const input = { root, evalId, evalDirectory, dataset, taskIds, request, resolvedRevision, benchmarkId, benchmarkRevision, manifest };
  for (const [index, taskId] of taskIds.entries()) await writePublicationBundle(input, taskId, index);
  if (!standard) for (const taskId of taskIds) await rm(path.join(evalDirectory, "harbor/job", `${taskId}__1`, "verifier/process.json"));
  const initial = createEvalProgress({ ...input, plannedTasks: count, plannedTrials: count, startedAt: publicationTimestamp });
  await writeEvalProgress(evalDirectory, initial);
  const events: Record<string, unknown>[] = [];
  const sink = new EvalEventSink(evalDirectory, evalId, event => events.push(event));
  await sink.open();
  t.after(() => sink.close());
  const publisher = new ProgressPublisher(initial, { ...input, sink });
  const binding = { ...input, revisionIdentity: resolvedRevision.identity };
  const importTask = (index: number, verifiedBenchmark?: VerifiedBenchmarkExecution) => {
    const taskId = taskIds[index]!;
    return importEvalTrialRun({ ...input, requireCompleteMarker: true, ...(verifiedBenchmark ? { verifiedBenchmark } : {}) }, {
      task_name: taskId, trial_name: `${taskId}__1`, verifier_result: standard
        ? { rewards: { reward: index === 0 ? 0 : 1, total_score: index === 0 ? 0 : 1, process_score: 0.5 } }
        : { rewards: { reward: index === 0 ? 0 : 1 } },
    });
  };
  return { ...input, initial, events, sink, publisher, binding, importTask };
}

async function writePublicationBundle(input: {
  root: string; evalId: EvalId; evalDirectory: string; benchmarkId: string; benchmarkRevision: string;
}, taskId: string, index: number) {
  const trialId = `${taskId}__1`, runId = `run_${(index + 1).toString(16).padStart(32, "0")}`;
  const directory = path.join(input.evalDirectory, "harbor/job", trialId, "hitch-run-bundle");
  const context: RunContextV1 = { kind: "benchmark_task", benchmark_id: input.benchmarkId, benchmark_revision: input.benchmarkRevision,
    task_id: taskId, task_digest: benchmarkTaskDigest(input.benchmarkId, input.benchmarkRevision, taskId),
    verifier_identity: benchmarkVerifierIdentity(input.benchmarkId, input.benchmarkRevision) };
  const parent = { kind: "eval", eval_id: input.evalId, trial_id: trialId, attempt: 1 };
  await atomicWriteJSON(path.join(directory, "manifest.json"), { schema_version: "1", run_id: runId, context, parent, status: "succeeded",
    harness: { harness_id: "codex", requested_ref: "codex@version:1.0.0", revision_identity: publicationCandidate },
    model: { requested_id: "synthetic-model", effective_id: "synthetic-model", identity_resolved: false },
    protocol: { timeout_ms: 1000, workspace_mode: "shared" }, request_ref: "request.json", resolution_ref: "resolution.json",
    result_ref: "result.json", trajectory_ref: "trajectory.ref.json", created_at: publicationTimestamp, sealed: true });
  await atomicWriteJSON(path.join(directory, "request.json"), { context, parent });
  await atomicWriteJSON(path.join(directory, "resolution.json"), {});
  await atomicWriteJSON(path.join(directory, "result.json"), { run_id: runId, status: "succeeded", started_at: publicationTimestamp, completed_at: publicationTimestamp });
  await writeFile(path.join(directory, "events.jsonl"), "");
  const projector = new TrajectoryProjector({ runId, cwd: "/workspace", prompt: "fixture", model: "synthetic-model", fidelity: "normalized" });
  projector.feed({ type: "message.completed", text: "done" });
  const projected = projector.finalize("succeeded");
  const writer = await TrajectoryWriter.open({ runDirectory: directory, cwd: "/workspace", sessionId: projected.header.id,
    fidelity: projected.fidelity, header: projected.header });
  for (const event of projected.events) writer.append(event);
  const file = await canonicalTrajectoryFileRef(directory, await writer.close());
  await atomicWriteJSON(path.join(directory, "trajectory.ref.json"), trajectoryRefV2({ runId, fidelity: "normalized", providerSessionId: "fixture-native-session", files: [file] }));
  await atomicWriteJSON(path.join(directory, "bundle.complete.json"), { schema_version: "1", run_id: runId, eval_id: input.evalId, trial_id: trialId });
  await atomicWriteJSON(path.join(path.dirname(directory), "verifier/process.json"), {
    schema_version: "1", metric: "process_quality", score: 0.5, detail_status: "aggregate-only",
  });
  await atomicWriteJSON(path.join(path.dirname(directory), "lock.json"), { task: { name: taskId } });
}
