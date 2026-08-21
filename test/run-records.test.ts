import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteJSON, ensureDir } from "../src/fs.js";
import { validateRunContext } from "../src/domain/validate.js";
import {
  compareRuns,
  queryRuns,
  rebuildRunIndexes,
  sha256JSON,
} from "../src/run-records.js";
import { TrajectoryProjector } from "../src/trajectories/projector.js";
import { TrajectoryWriter, canonicalTrajectoryFileRef, trajectoryRefV2 } from "../src/trajectories/store.js";
import { forceRemove } from "../test-support/helpers.js";

const digestA = `sha256:${"a".repeat(64)}` as const;
const digestB = `sha256:${"b".repeat(64)}` as const;

test("run contexts are discriminated, strict, and reject mutable benchmark revisions", () => {
  assert.deepEqual(validateRunContext(undefined), { kind: "ad_hoc" });
  assert.deepEqual(validateRunContext({
    kind: "seed_task",
    seed_task_id: "seed-1",
    seed_task_digest: digestA,
    iteration_id: "iteration-2",
  }), {
    kind: "seed_task",
    seed_task_id: "seed-1",
    seed_task_digest: digestA,
    iteration_id: "iteration-2",
  });
  assert.throws(() => validateRunContext({
    kind: "benchmark_task",
    benchmark_id: "bench",
    benchmark_revision: "latest",
    task_id: "task",
    task_digest: digestA,
    verifier_identity: digestB,
  }), /cannot be 'latest'/);
  assert.throws(() => validateRunContext({ kind: "ad_hoc", task_id: "smuggled" }), /unknown field/);
});

test("run queries rebuild from manifests and strict comparison isolates the selected dimension", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-run-records-"));
  t.after(() => forceRemove(root));
  const common = {
    benchmark_id: "bench",
    benchmark_revision: "rev-1",
    task_id: "task-1",
    task_digest: digestA,
    verifier_identity: digestB,
  };
  await writeBenchmarkRun(root, "run_11111111111111111111111111111111", common, "model-a", 1);
  await writeBenchmarkRun(root, "run_22222222222222222222222222222222", common, "model-b", 0.5);
  await writeSeedRun(root, "run_33333333333333333333333333333333");

  const benchmark = await queryRuns({ root, query: { context_kind: "benchmark_task", task_digest: digestA } });
  assert.equal(benchmark.length, 2);
  const seed = await queryRuns({ root, query: { seed_task_id: "seed-1", iteration_id: "iteration-1" } });
  assert.equal(seed.length, 1);

  const comparison = await compareRuns({ root, dimension: "model", query: { context_kind: "benchmark_task" } });
  assert.equal(comparison.strict, true);
  assert.equal(comparison.groups.length, 2);
  assert.deepEqual(comparison.groups.map((group) => group.valid_observations), [1, 1]);
  assert.equal(comparison.excluded.length, 0);

  const corruptDirectory = path.join(root, "runs", "run_22222222222222222222222222222222");
  const trajectoryRef = JSON.parse(await readFile(path.join(corruptDirectory, "trajectory.ref.json"), "utf8")) as {
    files: Array<{ role: string; path: string }>;
  };
  const canonicalPath = trajectoryRef.files.find((file) => file.role === "canonical_session")?.path as string;
  await writeFile(path.join(corruptDirectory, ...canonicalPath.split("/")), "tampered\n", "utf8");
  const corruptComparison = await compareRuns({ root, dimension: "model", query: { context_kind: "benchmark_task" } });
  assert.ok(corruptComparison.excluded.some((entry) => entry.run_id.endsWith("2222") && entry.reasons.includes("trajectory_missing_or_corrupt")));

  const index = await rebuildRunIndexes({ root });
  assert.equal(index.runs.length, 3);
  const persisted = JSON.parse(await readFile(path.join(root, "indexes", "runs.v1.json"), "utf8")) as { runs: unknown[] };
  assert.equal(persisted.runs.length, 3);
});

async function writeBenchmarkRun(
  root: string,
  runId: string,
  common: { benchmark_id: string; benchmark_revision: string; task_id: string; task_digest: typeof digestA; verifier_identity: typeof digestB },
  model: string,
  reward: number,
): Promise<void> {
  const directory = await ensureDir(path.join(root, "runs", runId));
  const projector = new TrajectoryProjector({ runId, cwd: "/workspace", prompt: "test", model, fidelity: "normalized" });
  projector.feed({ type: "message.completed", text: "done" });
  const projected = projector.finalize("succeeded");
  const writer = await TrajectoryWriter.open({
    runDirectory: directory,
    cwd: "/workspace",
    sessionId: projected.header.id,
    fidelity: projected.fidelity,
    header: projected.header,
  });
  for (const event of projected.events) writer.append(event);
  const canonical = await writer.close();
  const file = await canonicalTrajectoryFileRef(directory, canonical);
  await atomicWriteJSON(path.join(directory, "trajectory.ref.json"), trajectoryRefV2({
    runId,
    fidelity: "normalized",
    files: [file],
  }));
  await atomicWriteJSON(path.join(directory, "request.json"), {});
  await atomicWriteJSON(path.join(directory, "resolution.json"), {});
  await atomicWriteJSON(path.join(directory, "result.json"), { run_id: runId, status: "succeeded" });
  await atomicWriteJSON(path.join(directory, "verifier", "result.json"), { rewards: { reward } });
  const now = new Date().toISOString();
  await atomicWriteJSON(path.join(directory, "manifest.json"), {
    schema_version: "1",
    run_id: runId,
    context: { kind: "benchmark_task", ...common },
    status: "succeeded",
    harness: {
      harness_id: "codex",
      requested_ref: "codex@version:1.0.0",
      revision_identity: digestA,
      artifact_id: digestB,
    },
    model: {
      provider: "openai",
      requested_id: model,
      effective_id: `${model}-snapshot`,
      parameters_sha256: sha256JSON({ temperature: 0 }),
      identity_resolved: true,
    },
    protocol: {
      timeout_ms: 1000,
      workspace_mode: "shared",
      initial_workspace_digest: digestA,
      environment_identity: digestB,
    },
    observation: { status: "valid", reward, verifier_result_ref: "verifier/result.json" },
    request_ref: "request.json",
    resolution_ref: "resolution.json",
    result_ref: "result.json",
    trajectory_ref: "trajectory.ref.json",
    created_at: now,
    completed_at: now,
  });
}

async function writeSeedRun(root: string, runId: string): Promise<void> {
  const directory = await ensureDir(path.join(root, "runs", runId));
  const now = new Date().toISOString();
  await atomicWriteJSON(path.join(directory, "request.json"), {});
  await atomicWriteJSON(path.join(directory, "resolution.json"), {});
  await atomicWriteJSON(path.join(directory, "result.json"), {});
  await atomicWriteJSON(path.join(directory, "manifest.json"), {
    schema_version: "1",
    run_id: runId,
    context: { kind: "seed_task", seed_task_id: "seed-1", seed_task_digest: digestA, iteration_id: "iteration-1" },
    status: "succeeded",
    harness: { harness_id: "codex", requested_ref: "codex@version:1", revision_identity: digestA },
    model: { requested_id: "m", effective_id: "m", identity_resolved: false },
    protocol: { timeout_ms: 1, workspace_mode: "shared" },
    request_ref: "request.json",
    resolution_ref: "resolution.json",
    result_ref: "result.json",
    created_at: now,
    completed_at: now,
  });
  await writeFile(path.join(directory, "events.jsonl"), "", "utf8");
}
