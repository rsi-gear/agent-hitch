import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import { createEvalProgress, mergeEvalProgressTrial } from "../src/evals/index.js";
import { freezeRemoteVerifierSelection } from "../src/evals/remote-verifier-selection.js";
import { atomicWriteJSON, readJSON, sha256JSON } from "../src/foundation/index.js";
import { remoteVerifierFixture } from "../test-support/remote-verifier.js";

test("remote scoring freezes original sources before dispatch and restores them independently of updated progress", async t => {
  const f = await remoteVerifierFixture(t), rerunId = f.physical.rerun_id;
  const progress = mergeEvalProgressTrial(createEvalProgress({ evalId: f.evalId, benchmarkId: f.request.benchmark_id,
    benchmarkRevision: f.request.benchmark_revision, plannedTasks: 1, plannedTrials: 1, startedAt: new Date().toISOString() }), f.descriptor.source_ref);
  const input = { ...f, rerunId, rerunDirectory: path.join(f.evalDirectory, "reruns", rerunId), progress,
    slots: [{ task_id: "one", attempt: 1 }], taskRoot: f.request.dataset, sourceRuntimeId: f.runtime.runtime_id, verifierRuntimeId: f.runtime.runtime_id };
  const first = await freezeRemoteVerifierSelection(input), file = path.join(input.rerunDirectory, "verifier-selection.json");
  const original = await readJSON<Record<string, unknown>>(file);
  const replay = await freezeRemoteVerifierSelection({ ...input, progress: { ...progress, trials: [], generation: progress.generation + 1 } });
  assert.equal(sha256JSON(first.map(i => i.record)), sha256JSON(replay.map(i => i.record)));
  assert.equal(first[0]!.source.execution.work_id, f.execution.work_id, "source follows the actual candidate restart");
  await assert.rejects(freezeRemoteVerifierSelection({ ...input, verifierRuntimeId: `sha256:${"f".repeat(64)}` }), { code: "execution_state_ambiguous" });
  await atomicWriteJSON(file, { ...original, items: [{ ...first[0]!.record, work_id: f.execution.work_id }] });
  await assert.rejects(freezeRemoteVerifierSelection(input), { code: "execution_state_ambiguous" });
  await atomicWriteJSON(file, original);
  const other = path.join(f.evalDirectory, "reruns", `rerun_${"2".repeat(32)}`);
  await assert.rejects(freezeRemoteVerifierSelection({ ...input, rerunId: `rerun_${"2".repeat(32)}`, rerunDirectory: other,
    slots: [...input.slots, { task_id: "missing", attempt: 1 }] }));
  assert.equal(await readJSON(path.join(other, "verifier-selection.json"), null), null, "no partial selection is published");
  await atomicWriteJSON(path.join(input.rerunDirectory, "remote-work", `${first[0]!.work.work_id}.json`), { state: "running" });
  await rm(file);
  await assert.rejects(freezeRemoteVerifierSelection(input), { code: "execution_state_ambiguous" });
});
