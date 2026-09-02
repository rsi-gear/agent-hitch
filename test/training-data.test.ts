import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteJSON, ensureDir, readJSON } from "../src/foundation/index.js";
import { deriveTrainingDataCandidate, parseTrainingDataCandidate, writeResultBundleIndex } from "../src/runs/index.js";
import { TrajectoryProjector, TrajectoryWriter, canonicalTrajectoryFileRef, trajectoryRefV2 } from "../src/trajectories/index.js";

test("training-data candidates are content-addressed read-only derivations with explicit eligibility", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-training-candidate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const runDirectory = await writeBenchmarkRun(root, runId, true);
  const sealedBefore = await readFile(path.join(runDirectory, "bundle.index.json"));

  const review = await deriveTrainingDataCandidate({ root, runId });
  assert.equal(review.candidate.eligibility, "review-required");
  assert.deepEqual(review.candidate.reasons, ["context-license-unknown"]);
  assert.equal(review.candidate.metadata.capture_completeness, "complete");
  assert.equal(review.created, true);
  assert.deepEqual(parseTrainingDataCandidate(await readJSON(review.path)), review.candidate);

  const eligible = await deriveTrainingDataCandidate({ root, runId, policy: { contextLicense: "allowed" } });
  assert.equal(eligible.candidate.eligibility, "eligible");
  assert.deepEqual(eligible.candidate.reasons, []);
  assert.notEqual(eligible.candidate.candidate_id, review.candidate.candidate_id);
  const repeated = await deriveTrainingDataCandidate({ root, runId, policy: { contextLicense: "allowed" } });
  assert.equal(repeated.created, false);
  assert.deepEqual(repeated.candidate, eligible.candidate);
  assert.deepEqual(await readFile(path.join(runDirectory, "bundle.index.json")), sealedBefore);

  const denied = await deriveTrainingDataCandidate({ root, runId, policy: { contextLicense: "denied" } });
  assert.equal(denied.candidate.eligibility, "ineligible");
  assert.deepEqual(denied.candidate.reasons, ["context-license-denied"]);
});

test("infrastructure diagnostic runs are always ineligible training-data candidates", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-training-diagnostic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = "run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await writeBenchmarkRun(root, runId, false);
  const derived = await deriveTrainingDataCandidate({ root, runId, policy: { contextLicense: "allowed" } });
  assert.equal(derived.candidate.eligibility, "ineligible");
  assert.deepEqual(derived.candidate.reasons, [
    "infrastructure-diagnostic", "observation-invalid", "trajectory-incomplete", "verifier-evidence-incomplete",
  ]);
});

async function writeBenchmarkRun(root: string, runId: string, valid: boolean): Promise<string> {
  const directory = await ensureDir(path.join(root, "runs", runId));
  const now = new Date().toISOString();
  await atomicWriteJSON(path.join(directory, "request.json"), { schema_version: "1", prompt: "test" });
  await atomicWriteJSON(path.join(directory, "resolution.json"), { schema_version: "1", identity: `sha256:${"1".repeat(64)}` });
  await atomicWriteJSON(path.join(directory, "result.json"), { schema_version: "1", run_id: runId, status: valid ? "succeeded" : "failed", exit_code: valid ? 0 : 12 });
  if (valid) {
    await ensureDir(path.join(directory, "verifier"));
    await atomicWriteJSON(path.join(directory, "verifier", "result.json"), { rewards: { reward: 1 } });
    await writeTrajectory(directory, runId);
  }
  await atomicWriteJSON(path.join(directory, "manifest.json"), {
    schema_version: "1",
    run_id: runId,
    status: valid ? "succeeded" : "failed",
    context: {
      kind: "benchmark_task", benchmark_id: "demo", benchmark_revision: "1.0", task_id: "task-a",
      task_digest: `sha256:${"2".repeat(64)}`, verifier_identity: `sha256:${"3".repeat(64)}`,
    },
    parent: { kind: "eval", eval_id: `eval_${"4".repeat(32)}`, trial_id: "trial-a", attempt: 1 },
    harness: { harness_id: "codex", requested_ref: "codex@version:1.0.0", revision_identity: `sha256:${"5".repeat(64)}` },
    model: { provider: "openai", requested_id: "gpt-test", effective_id: "gpt-test-2026", identity_resolved: true },
    protocol: { timeout_ms: 1_000, workspace_mode: "shared" },
    observation: valid
      ? { status: "valid", reward: 1, verifier_result_ref: "verifier/result.json" }
      : { status: "invalid", invalid_reason: "infrastructure_failure" },
    request_ref: "request.json",
    resolution_ref: "resolution.json",
    result_ref: "result.json",
    ...(valid ? { trajectory_ref: "trajectory.ref.json" } : {}),
    created_at: now,
    completed_at: now,
    sealed: true,
  });
  await writeResultBundleIndex(directory);
  return directory;
}

async function writeTrajectory(directory: string, runId: string): Promise<void> {
  const projector = new TrajectoryProjector({ runId, cwd: "/workspace", prompt: "test", model: "gpt-test", fidelity: "normalized" });
  projector.feed({ type: "session.created", session_id: "session-test" });
  projector.feed({ type: "message.completed", text: "done" });
  const projected = projector.finalize("succeeded");
  const writer = await TrajectoryWriter.open({
    runDirectory: directory, cwd: "/workspace", sessionId: projected.header.id, fidelity: projected.fidelity, header: projected.header,
  });
  for (const event of projected.events) writer.append(event);
  const file = await canonicalTrajectoryFileRef(directory, await writer.close());
  await atomicWriteJSON(path.join(directory, "trajectory.ref.json"), trajectoryRefV2({ runId, fidelity: "normalized", files: [file] }));
}
