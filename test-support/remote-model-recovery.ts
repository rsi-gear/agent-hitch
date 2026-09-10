import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { RemoteWorkerProtocol, RemoteWorkerRegistry, recoverRemoteWorkerEvalLeases } from "../src/control-plane/index.js";
import { createEvalProgress, mergeEvalProgressTrial, readEvalProgress, readExecutionLeases, stageRemoteRerunCompletion, validateEvalId, writeEvalProgress } from "../src/evals/index.js";
import type { EvalTrialRefV1 } from "../src/domain/index.js";
import { atomicWriteJSON, statePaths } from "../src/foundation/index.js";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";

/** Reconstruct the durable crash boundary after bundle upload but before controller publication/release. */
export async function verifyRemoteModelRecovery(root: string, evalIdValue: string, runId: string, repair?: { rerunId: string; prior: EvalTrialRefV1 }): Promise<void> {
  const evalId = validateEvalId(evalIdValue), directory = path.join(root, "evals", evalId);
  const original = await readEvalProgress(directory); assert.ok(original);
  const originalLeases = await readExecutionLeases(directory);
  const execution = JSON.parse(await readFile(path.join(root, "runs", runId, "execution.json"), "utf8")) as { lease_id: string };
  const released = originalLeases.find(lease => lease.lease_id === execution.lease_id); assert.ok(released);
  const { terminal_at: _terminal, release_confirmation: _confirmation, ...identity } = released;
  const lease = { ...identity, state: "running" as const };
  const registry = new RemoteWorkerRegistry({ root }); await registry.initialize();
  const protocol = new RemoteWorkerProtocol({ root, registry }); await protocol.initialize();
  const ackPath = path.join(statePaths(root).workerProtocol, "model-routes", lease.lease_id, "bound.json");
  const ack = await readFile(ackPath);
  const journalPath = repair ? path.join(directory, "reruns", repair.rerunId, "remote-work", `${lease.work_id}.json`) : undefined;
  const journal = journalPath ? JSON.parse(await readFile(journalPath, "utf8")) as { identity: unknown } : undefined;
  const reset = async () => {
    await atomicWriteJSON(path.join(directory, "leases", `${lease.lease_id}.json`), lease);
    const progress = createEvalProgress({ evalId, benchmarkId: original.benchmark_id, benchmarkRevision: original.benchmark_revision,
      plannedTasks: original.planned_tasks, plannedTrials: original.planned_trials, startedAt: original.started_at });
    await writeEvalProgress(directory, repair ? mergeEvalProgressTrial(progress, repair.prior) : progress);
    if (journalPath) await atomicWriteJSON(journalPath, { identity: journal!.identity, lease_id: lease.lease_id, state: "running" });
  };
  const recover = async () => recoverRemoteWorkerEvalLeases({ root, evalId, evalDirectory: directory,
    leases: (await readExecutionLeases(directory)).filter(item => item.lease_id === lease.lease_id), registry, protocol, pollIntervalMs: 5, releaseTimeoutMs: 100 });
  await reset(); await rm(ackPath);
  assert.equal((await recover()).status, "ambiguous", "an unacknowledged binding must never publish a recovered trial");
  assert.deepEqual((await readEvalProgress(directory))!.trials, repair ? [repair.prior] : []);
  await writeFile(ackPath, ack, { mode: 0o600 });
  const recovered = await recover(); assert.equal(recovered.status, "resumable", JSON.stringify(recovered));
  assert.deepEqual(recovered.recovered_lease_ids, [lease.lease_id]);
  assert.equal((await readEvalProgress(directory))!.trials[0]!.run_id, runId);
  const confirmed = (await readExecutionLeases(directory)).find(entry => entry.lease_id === lease.lease_id)!;
  assert.equal(confirmed.state, "released"); assert.equal(confirmed.epoch, lease.epoch + 1);
  assert.deepEqual(confirmed.resource_epochs, [lease.epoch]); assert.equal(confirmed.release_confirmation!.execution_epoch, lease.epoch);
  if (journalPath) {
    const completed = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(completed.state, "completed"); assert.equal(completed.result.leaseId, lease.lease_id);
    assert.equal(completed.result.refs[0].run_id, runId);
  }
  // Replay does not create another physical execution or publication generation.
  const before = await readEvalProgress(directory); await recover(); assert.deepEqual(await readEvalProgress(directory), before);
  assert.equal((await readExecutionLeases(directory)).length, originalLeases.length);
}

/** Restart a real daemon over the crash fixture; no worker or model call may be needed. */
export async function verifyRemoteRerunDaemonRecovery(input: {
  server: DaemonServer; options: ConstructorParameters<typeof DaemonServer>[0];
  root: string; evalId: string; rerunId: string; prior: EvalTrialRefV1;
}): Promise<void> {
  await input.server.close();
  const directory = path.join(input.root, "evals", input.evalId), rerun = path.join(directory, "reruns", input.rerunId);
  const progress = await readEvalProgress(directory); assert.ok(progress);
  const expectedRef = progress.trials[0]!, leases = await readExecutionLeases(directory);
  const execution = JSON.parse(await readFile(path.join(input.root, "runs", expectedRef.run_id!, "execution.json"), "utf8"));
  const lease = leases.find(item => item.lease_id === execution.lease_id)!;
  const journalPath = path.join(rerun, "remote-work", `${lease.work_id}.json`);
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const state = JSON.parse(await readFile(path.join(rerun, "state.json"), "utf8"));
  const frozenRequest = await readFile(path.join(rerun, "request.json"), "utf8");
  const { terminal_at: _terminalAt, release_confirmation: _confirmation, ...active } = lease;
  await atomicWriteJSON(path.join(directory, "leases", `${lease.lease_id}.json`), { ...active,
    epoch: lease.release_confirmation?.execution_epoch ?? lease.epoch, state: "running" });
  await atomicWriteJSON(journalPath, { identity: journal.identity, lease_id: lease.lease_id, state: "running" });
  const resetProgress = mergeEvalProgressTrial(createEvalProgress({ evalId: validateEvalId(input.evalId),
    benchmarkId: progress.benchmark_id, benchmarkRevision: progress.benchmark_revision,
    plannedTasks: progress.planned_tasks, plannedTrials: progress.planned_trials, startedAt: progress.started_at }), input.prior);
  await writeEvalProgress(directory, { ...resetProgress, generation: progress.generation });
  await atomicWriteJSON(path.join(rerun, "state.json"), { ...state, status: "running" });
  await rm(path.join(rerun, "result.json"));
  const restarted = new DaemonServer(input.options);
  try {
    await restarted.start();
    const client = await daemonClient(input.root), deadline = Date.now() + 10_000;
    let status: Record<string, unknown>;
    do {
      status = await client.request(`/v1/evals/${input.evalId}/reruns/${input.rerunId}`);
      if ((status.state as { status: string }).status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.equal((status.state as { status: string }).status, "completed", JSON.stringify(status));
    const result = status.result as { selected_trials: unknown[]; repaired_trials: unknown[]; eval_status: string };
    assert.deepEqual(result.selected_trials, [{ task_id: input.prior.task_id, attempt: input.prior.attempt }]);
    assert.deepEqual(result.repaired_trials, result.selected_trials); assert.equal(result.eval_status, "succeeded");
    assert.deepEqual((await readEvalProgress(directory))!.trials, [expectedRef]);
    assert.equal(await readFile(path.join(rerun, "request.json"), "utf8"), frozenRequest);
    assert.equal((await readExecutionLeases(directory)).length, leases.length);
  } finally { await restarted.close(); }
  // The executor has finished, but the scheduler has not published its result/control acknowledgement.
  const completedResult = JSON.parse(await readFile(path.join(rerun, "result.json"), "utf8"));
  await stageRemoteRerunCompletion(directory, rerun, completedResult);
  await rm(path.join(rerun, "result.json"));
  const controlPath = path.join(directory, "control.json"), control = JSON.parse(await readFile(controlPath, "utf8"));
  await atomicWriteJSON(controlPath, { ...control, state: "failed", generation: control.generation + 1 });
  const handoff = new DaemonServer(input.options);
  try {
    await handoff.start(); const client = await daemonClient(input.root);
    const recovered = await client.request(`/v1/evals/${input.evalId}/reruns/${input.rerunId}`);
    assert.deepEqual(recovered.result, completedResult, "completion handoff must retain the exact result and timestamps");
    assert.equal((recovered.state as { status: string }).status, "completed");
    assert.equal(JSON.parse(await readFile(controlPath, "utf8")).state, "succeeded");
    assert.deepEqual((await readEvalProgress(directory))!.trials, [expectedRef]);
    assert.equal((await readExecutionLeases(directory)).length, leases.length);
  } finally { await handoff.close(); }
}
