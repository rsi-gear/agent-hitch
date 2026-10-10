import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJSON, readJSON } from "../src/foundation/index.js";
import { createEvalProgress, mergeEvalProgressTrial, parseEvalProgress, readEvalProgress, readEvalState, replaceInvalidEvalProgressTrial, withEvalProgressLock, writeEvalProgress } from "../src/evals/progress.js";
import { persistTerminalEvalResult } from "../src/evals/eval-state.js";
import { inspectEval } from "../src/evals/records.js";
import { prepareEvalDirectory } from "../src/evals/directory.js";
import { writeSyntheticEvalResult } from "../src/control-plane/synthetic-result.js";
import { recoverPersistedEvals } from "../src/control-plane/eval-recovery.js";
import { EvalScheduler, ResourceLedger } from "../src/control-plane/index.js";
import { publicationFixture, publicationTimestamp } from "../test-support/benchmark-publication-fixture.js";

function terminal(s: Awaited<ReturnType<typeof publicationFixture>>, status: "succeeded" | "failed" | "cancelled" = "cancelled") {
  return { schema_version: "1", eval_id: s.evalId, benchmark_id: s.benchmarkId, benchmark_revision: s.benchmarkRevision,
    status, exit_code: status === "succeeded" ? 0 : 9, trials: [], started_at: publicationTimestamp, completed_at: publicationTimestamp };
}

test("failed progress publication does not advance memory and the same slot retry persists exactly once", async t => {
  const s = await publicationFixture(t), ref = await s.importTask(0);
  await rm(path.join(s.evalDirectory, "progress.json")); await mkdir(path.join(s.evalDirectory, "progress.json"));
  await assert.rejects(s.publisher.publish(ref, "first"));
  assert.equal(s.publisher.current().generation, 0); assert.deepEqual(s.publisher.current().trials, []);
  await assert.rejects(s.publisher.settle());
  await rm(path.join(s.evalDirectory, "progress.json"), { recursive: true }); await atomicWriteJSON(path.join(s.evalDirectory, "progress.json"), s.initial);
  await s.publisher.publish(ref, "retry"); await s.publisher.close();
  assert.deepEqual((await readEvalProgress(s.evalDirectory))?.trials, [ref]);
  assert.equal(s.events.filter(event => event.type === "eval.trial.published").length, 1);
});

test("cancel finalization drains queued publications and late publishers cannot resurrect running", async t => {
  const s = await publicationFixture(t, 2), refs = await Promise.all([s.importTask(0), s.importTask(1)]);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const locked = withEvalProgressLock(s.evalDirectory, async () => { enter(); await gate; }); await entered;
  const publications = refs.map((ref, index) => s.publisher.publish(ref, `queued-${index}`));
  const finalized = s.publisher.close().then(() => persistTerminalEvalResult(s.evalDirectory, terminal(s)));
  release(); await locked; await Promise.all(publications); await finalized;
  const state = await readEvalState(s.evalDirectory);
  assert.equal(state.progress?.status, "cancelled"); assert.equal(state.result?.status, "cancelled");
  assert.deepEqual(state.progress?.trials, refs); assert.deepEqual(state.result?.trials, refs);
  assert.equal(state.progress?.generation, 2);
  await assert.rejects(s.publisher.publish(refs[0]!, "late"), /publisher is closed/);
  assert.equal((await writeEvalProgress(s.evalDirectory, s.initial)).status, "cancelled");
  const other = { trial_id: "late__1", task_id: "late", run_id: `run_${"c".repeat(32)}`, attempt: 1, observation_status: "valid" as const, reward: 0 };
  await assert.rejects(writeEvalProgress(s.evalDirectory, mergeEvalProgressTrial({ ...s.initial, planned_tasks: 3, planned_trials: 3 }, other)), /identity changed|terminal eval/);
});

test("control-plane synthetic cancellation retains already published evidence", async t => {
  const s = await publicationFixture(t), ref = await s.importTask(0);
  await s.publisher.publish(ref, "published"); await s.publisher.close();
  await atomicWriteJSON(path.join(s.evalDirectory, "control.json"), { schema_version: "1", eval_id: s.evalId, generation: 0,
    state: "cancelling", requested_parallelism: 1, admitted_parallelism: 0, created_at: publicationTimestamp, updated_at: publicationTimestamp });
  await writeSyntheticEvalResult({ directory: s.evalDirectory, evalId: s.evalId, request: s.request,
    status: "cancelled", code: "cancelled", message: "fixture cancellation", completedAt: publicationTimestamp });
  const state = await readEvalState(s.evalDirectory);
  assert.deepEqual(state.result?.trials, [ref]); assert.deepEqual(state.progress?.trials, [ref]);
  assert.equal(state.progress?.status, "cancelled"); assert.equal(state.progress?.generation, 1);
});

test("real inspect reconciles a crash between result and progress writes", async t => {
  const s = await publicationFixture(t), ref = await s.importTask(0);
  await s.publisher.publish(ref, "published"); await s.publisher.close();
  await atomicWriteJSON(path.join(s.evalDirectory, "result.json"), { ...terminal(s), trials: [ref], generation: 1 });
  assert.equal((await readJSON<{ status: string }>(path.join(s.evalDirectory, "progress.json"))).status, "running");
  const observed = await inspectEval(s.evalId, { root: s.root });
  assert.equal(observed.result?.status, "cancelled"); assert.equal(observed.progress?.status, "cancelled");
  assert.deepEqual(observed.progress?.trials, [ref]);
  assert.equal((await readJSON<{ status: string }>(path.join(s.evalDirectory, "progress.json"))).status, "cancelled");
});

test("real observers wait for one serialized progress/result snapshot during terminal publication", async t => {
  const s = await publicationFixture(t), ref = await s.importTask(0);
  await s.publisher.publish(ref, "published"); await s.publisher.close();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const writer = withEvalProgressLock(s.evalDirectory, async () => {
    await atomicWriteJSON(path.join(s.evalDirectory, "result.json"), { ...terminal(s), generation: 1, trials: [ref] });
    enter(); await gate;
    await atomicWriteJSON(path.join(s.evalDirectory, "progress.json"), { ...s.publisher.current(), status: "cancelled" });
  });
  await entered;
  const inspected = inspectEval(s.evalId, { root: s.root });
  const snapshot = readEvalState(s.evalDirectory);
  release(); await writer;
  for (const observed of [await inspected, await snapshot]) {
    assert.equal(observed.progress?.status, observed.result?.status);
    assert.deepEqual(observed.progress?.trials, observed.result?.trials);
  }
});

test("startup recovery and scheduler status reconcile an authoritative terminal result with stale running progress", async t => {
  const s = await publicationFixture(t);
  const resources = { cpu_millis: 1000, memory_bytes: 1024, container_slots: 1, build_slots: 0 };
  const ledger = new ResourceLedger(resources); ledger.tryAcquire("capacity-blocker", "eval", resources);
  let executions = 0;
  const scheduler = new EvalScheduler({ root: s.root, resources: ledger, trialResources: resources,
    executor: async () => { executions++; throw new Error("must remain queued"); } });
  await scheduler.initialize(); t.after(() => scheduler.shutdown());
  const id = await scheduler.submit({ dataset: "demo@1.0", harness_ref: s.request.harness_ref, max_concurrent: 1 });
  const directory = path.join(s.root, "evals", id);
  const frozen = (await scheduler.status(id))!.request;
  const progress = createEvalProgress({ evalId: id, benchmarkId: frozen.benchmark_id, benchmarkRevision: frozen.benchmark_revision,
    plannedTasks: 1, plannedTrials: 1, startedAt: publicationTimestamp });
  await writeEvalProgress(directory, progress);
  await atomicWriteJSON(path.join(directory, "result.json"), { ...terminal(s), eval_id: id, benchmark_id: frozen.benchmark_id, benchmark_revision: frozen.benchmark_revision, generation: 0 });
  assert.deepEqual(await recoverPersistedEvals({ root: s.root, evalsRoot: path.join(s.root, "evals") }), []);
  const status = await scheduler.status(id);
  assert.equal(status?.control.state, "cancelled"); assert.equal(status?.progress?.status, "cancelled"); assert.equal(status?.result?.status, "cancelled");
  assert.equal(executions, 0);
  await scheduler.shutdown();
});

test("terminal progress allows explicit invalid-slot repair and preserves a valid zero", async t => {
  const s = await publicationFixture(t, 2), valid = await Promise.all([s.importTask(0), s.importTask(1)]);
  const { reward: _reward, scores: _scores, ...base } = valid[1]!;
  const invalid = { ...base, observation_status: "invalid" as const, invalid_reason: "verifier_result_missing" };
  let progress = mergeEvalProgressTrial(mergeEvalProgressTrial(s.initial, valid[0]!), invalid);
  progress = await writeEvalProgress(s.evalDirectory, progress);
  await persistTerminalEvalResult(s.evalDirectory, { ...terminal(s, "failed"), trials: progress.trials });
  const repaired = replaceInvalidEvalProgressTrial(progress, valid[1]!);
  await assert.rejects(writeEvalProgress(s.evalDirectory, repaired), /terminal eval/);
  await writeEvalProgress(s.evalDirectory, repaired, { terminalRepair: true });
  const beforeFinalization = await readEvalState(s.evalDirectory);
  assert.equal(beforeFinalization.progress?.generation, 3);
  assert.deepEqual(beforeFinalization.progress?.trials, repaired.trials, "the old failed result cannot downgrade a newer valid repair");
  const result = await persistTerminalEvalResult(s.evalDirectory, { ...terminal(s, "succeeded"), trials: repaired.trials });
  const current = await readEvalProgress(s.evalDirectory);
  assert.equal(current?.status, "succeeded"); assert.equal(current?.generation, 3);
  assert.deepEqual(current?.trials, result.trials); assert.deepEqual(current?.trials[0], valid[0]); assert.equal(current?.trials[0]?.reward, 0);
  const conflict = { ...valid[0]!, run_id: `run_${"c".repeat(32)}`, trial_id: "conflict__1" };
  await assert.rejects(persistTerminalEvalResult(s.evalDirectory, { ...terminal(s), trials: [conflict] }), /durable valid trial/);
});

test("explicit preparation restart removes only an empty failed result", async t => {
  const s = await publicationFixture(t);
  await persistTerminalEvalResult(s.evalDirectory, terminal(s, "failed"));
  await rm(path.join(s.evalDirectory, "progress.json"));
  await prepareEvalDirectory({ evalsDirectory: path.join(s.root, "evals"), evalId: s.evalId, request: s.request, precreated: true, replaceTerminal: true });
  await writeEvalProgress(s.evalDirectory, s.initial);
  assert.equal((await readEvalProgress(s.evalDirectory))?.status, "running");
  const ref = await s.importTask(0);
  await persistTerminalEvalResult(s.evalDirectory, { ...terminal(s, "failed"), trials: [ref] });
  await assert.rejects(prepareEvalDirectory({ evalsDirectory: path.join(s.root, "evals"), evalId: s.evalId, request: s.request,
    precreated: true, replaceTerminal: true }), /only failed pre-execution/);
});

test("progress parser accepts all terminal projections and rejects unknown status", async t => {
  const s = await publicationFixture(t);
  for (const status of ["running", "succeeded", "failed", "cancelled"]) assert.equal(parseEvalProgress({ ...s.initial, status }).status, status);
  assert.throws(() => parseEvalProgress({ ...s.initial, status: "unknown" }), /benchmark\/status/);
});

test("real inspect recovers result-only new references and generation after terminal write interruption", async t => {
  const s = await publicationFixture(t), ref = await s.importTask(0);
  assert.deepEqual((await readEvalProgress(s.evalDirectory))?.trials, []);
  await atomicWriteJSON(path.join(s.evalDirectory, "result.json"), { ...terminal(s), generation: 1, trials: [ref] });
  const observed = await inspectEval(s.evalId, { root: s.root });
  assert.equal(observed.progress?.status, "cancelled"); assert.equal(observed.progress?.generation, 1);
  assert.deepEqual(observed.progress?.trials, [ref]); assert.deepEqual(observed.result?.trials, [ref]);
  assert.deepEqual((await readEvalState(s.evalDirectory)).progress?.trials, [ref], "repeated crash recovery is idempotent");
});
