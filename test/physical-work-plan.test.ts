import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EvalRequest, RemotePhysicalExecutionV2, RemoteWorkOfferV1 } from "../src/domain/index.js";
import type { EvalRemoteWorkExecutionResult } from "../src/evals/index.js";
import { buildEvalExecutionPlan, createEvalProgress, createExecutionLease, evalRerunSemantics, markExecutionLeaseLost, parseEvalExecutionPlan, readExecutionLeases, validateEvalId, writeEvalProgress } from "../src/evals/index.js";
import { assertPhysicalWork, candidateRestartWorkItem, parsePhysicalExecution, verifierOnlyWorkItem } from "../src/evals/physical-work-plan.js";
import { physicalRetryWorkItemForTriggerIds } from "../src/evals/physical-retry-work.js";
import { assertRemoteRerunQuiescent, executeRemoteRerunGroup } from "../src/evals/remote-rerun-execution.js";
import { validateRemoteOfferContract } from "../src/control-plane/remote-offer-contract.js";
import { RemoteWorkInputStore, RemoteWorkerProtocol, RemoteWorkerRegistry, recoverRemoteWorkerEvalLeases } from "../src/control-plane/index.js";
import { atomicWriteJSON, readJSON, sha256JSON } from "../src/foundation/index.js";
import { remoteRerunNeedsExecution, restoreRemoteRerunSelection } from "../src/evals/rerun-resume.js";
import { forceRemove } from "../test-support/helpers.js";

const evalId = validateEvalId(`eval_${"a".repeat(32)}`), rerunId = `rerun_${"b".repeat(32)}`;
const request: EvalRequest = { schema_version: "1", backend: "harbor", dataset: "demo@1.0", harness_ref: "pi@version:1.2.3",
  model: "", attempts: 1, max_concurrent: 1, infrastructure_retries: 1, infrastructure_retry_backoff_ms: 0,
  timeout_ms: 900_000, setup_timeout_ms: 1_800_000, agent_args: [], pass_env: [], benchmark_id: "demo", benchmark_revision: "1.0" };
function fixture() {
  const plan = buildEvalExecutionPlan({ evalId, request, tasks: ["task-a"], workItemMode: "task-slots", maxParallelism: 1,
    candidate: { revisionIdentity: `sha256:${"c".repeat(64)}`, artifactId: `sha256:${"d".repeat(64)}` }, provider: "remote-docker",
    trialResources: { cpu_millis: 1_000, memory_bytes: 1_024, container_slots: 1, build_slots: 0 }, createdAt: "2026-01-01T00:00:00.000Z" });
  const source = plan.work_items[0]!;
  const physical: RemotePhysicalExecutionV2 = { schema_version: "2", kind: "candidate-restart", source_work_id: source.work_id, rerun_id: rerunId };
  return { plan, source, physical, work: candidateRestartWorkItem(source, rerunId) };
}

test("physical executions preserve the immutable v1 plan and reject changed source contracts", () => {
  const { plan, source, physical, work } = fixture(), digest = sha256JSON(plan);
  assertPhysicalWork(plan, source);
  assertPhysicalWork(plan, work, physical);
  assert.equal(sha256JSON(parseEvalExecutionPlan(plan)), digest);
  assert.throws(() => parseEvalExecutionPlan({ ...plan, work_items: [work] }), /identity does not match/);
  assert.throws(() => assertPhysicalWork(plan, work), /frozen logical source/);
  const changed = [ { ...work, provider: "local-docker" }, { ...work, artifact_id: `sha256:${"e".repeat(64)}` as const },
    { ...work, slots: ["slot_other"] }, { ...work, task_ids: ["task-b"] }, { ...work, reservation: { ...work.reservation, gpu_count: 1 } } ];
  for (const item of changed) assert.throws(() => assertPhysicalWork(plan, item, physical), /frozen execution contract/);
  assert.throws(() => assertPhysicalWork(plan, work, { ...physical, rerun_id: `rerun_${"e".repeat(32)}` }), /frozen execution contract/);
  assert.throws(() => assertPhysicalWork({ ...plan, training_binding: {} as never }, work, physical), /permitted frozen logical source/);
  const retryProof: RemotePhysicalExecutionV2 = { schema_version: "2", kind: "physical-infrastructure-retry", source_work_id: source.work_id, retry_index: 1, trigger_trial_ids: ["trial-a", "trial-b"] };
  const retry = physicalRetryWorkItemForTriggerIds(source, 1, retryProof.trigger_trial_ids);
  assertPhysicalWork(plan, retry, retryProof);
  assert.throws(() => assertPhysicalWork(plan, retry, { ...retryProof, retry_index: 2 }), /frozen execution contract/);
  for (const ids of [[], ["trial-b", "trial-a"], ["trial-a", "trial-a"]]) assert.throws(() => parsePhysicalExecution({ ...retryProof, trigger_trial_ids: ids }), /retry trigger/);
  assert.equal(sha256JSON(plan), digest);
});

test("sealed physical offers reject legacy workers and work substitution before dispatch", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-physical-offer-")); t.after(() => forceRemove(root));
  const { plan, work, physical } = fixture(), store = new RemoteWorkInputStore(root); await store.initialize();
  const ref = await store.put("work-spec", "json", Buffer.from(JSON.stringify({ schema_version: "2", plan, work, physical_execution: physical })));
  const offer = { inputs: [ref], work } as RemoteWorkOfferV1;
  const features = { docker: true, buildkit: false, model_proxy: false, isolated_same_task_attempts: false };
  await assert.rejects(validateRemoteOfferContract(offer, features, store), /physical_work v2/);
  await validateRemoteOfferContract(offer, { ...features, physical_work: "2" }, store);
  await assert.rejects(validateRemoteOfferContract({ ...offer, work: { ...work, provider: "local-docker" } }, { ...features, physical_work: "2" }, store), /frozen execution contract/);
});

test("verifier-only physical work binds its assessment and preserves the original reservation", () => {
  const { plan, source, work: candidateWork } = fixture(), digest = sha256JSON(plan), assessment = `assessment_${"a".repeat(32)}`;
  const proof = { schema_version: "2" as const, kind: "verifier-only" as const, source_work_id: source.work_id, rerun_id: rerunId, assessment_id: assessment };
  const work = verifierOnlyWorkItem(source, rerunId, assessment);
  assertPhysicalWork(plan, work, parsePhysicalExecution(proof));
  assert.notEqual(work.work_id, source.work_id); assert.notEqual(work.work_id, candidateWork.work_id);
  assert.deepEqual(work.reservation, source.reservation); assert.equal(sha256JSON(plan), digest);
  assert.throws(() => assertPhysicalWork(plan, work, { ...proof, assessment_id: `assessment_${"b".repeat(32)}` }));
  assert.throws(() => assertPhysicalWork(plan, { ...work, provider: "local-docker" }, proof));
  assert.throws(() => assertPhysicalWork({ ...plan, training_binding: {} as never }, work, proof));
  assert.throws(() => verifierOnlyWorkItem({ ...source, slots: [...source.slots, "another-slot"] }, rerunId, assessment));
  for (const change of [{ assessment_id: "../assessment" }, { assessment_id: undefined }, { retry_index: 1 }, { rerun_id: "other" }]) {
    assert.throws(() => parsePhysicalExecution({ ...proof, ...change }));
  }
});

test("remote rerun journals replay acknowledged completion and refuse ambiguous redispatch", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-rerun-journal-")); t.after(() => forceRemove(root));
  const { plan, work } = fixture(); let calls = 0; const published: unknown[] = [];
  const ref = { trial_id: "trial-new", run_id: `run_${"e".repeat(32)}`, task_id: "task-a", attempt: 1, observation_status: "valid" as const, reward: 1 };
  const result: EvalRemoteWorkExecutionResult = { leaseId: `lease_${"f".repeat(32)}`, refs: [ref], run: { backend: {
    name: "harbor", executable: "remote-worker", version: "0.21.0", identity: "remote", config_path: "job.json", result_path: "result.json",
    stdout_path: "stdout.log", stderr_path: "stderr.log", process_exit_code: 0, signal: null, job_directory: "job",
  }, rawResult: { trials: [] }, summary: {} } };
  const input: Parameters<typeof executeRemoteRerunGroup>[0] = { root, evalId, evalDirectory: root, rerunId, rerunDirectory: path.join(root, "rerun"), request, plan,
    slots: [{ task_id: "task-a", attempt: 1 }], artifact: { artifact_id: plan.work_items[0]!.artifact_id } as never, resolvedRevision: {} as never,
    runtimeDirectory: root, runtimeId: `sha256:${"c".repeat(64)}`, publish: async ref => { published.push(ref); },
    executor: async input => { calls++; assertPhysicalWork(input.plan, input.workItem, input.physicalExecution);
      await input.onLeaseState(result.leaseId, "running"); input.emit({ type: "lease.accepted", lease_id: result.leaseId });
      await input.publish(ref); await input.onLeaseState(result.leaseId, "terminal"); return result; } };
  await executeRemoteRerunGroup(input); await executeRemoteRerunGroup(input);
  assert.equal(calls, 1); assert.deepEqual(published, [ref, ref]);
  const events = await readFile(path.join(input.rerunDirectory, "remote-work", work.work_id, "events.jsonl"), "utf8");
  assert.match(events, /lease.accepted/); assert.match(events, new RegExp(rerunId));
  const failed = { ...input, rerunDirectory: path.join(root, "lost-reply"), executor: async () => { calls++; throw new Error("reply lost"); } };
  await assert.rejects(executeRemoteRerunGroup(failed), /reply lost/);
  await assert.rejects(executeRemoteRerunGroup(failed), (error: unknown) => (error as { code?: string }).code === "execution_state_ambiguous");
  assert.equal(calls, 2);
});

test("remote rerun cannot bypass an unresolved lease using another rerun ID", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-rerun-fence-")); t.after(() => forceRemove(root));
  const { work } = fixture();
  const lease = await createExecutionLease({ evalDirectory: root, evalId, workId: work.work_id, reservation: work.reservation,
    worker: { workerId: "worker_remote", provider: work.provider, collisionDomainId: "remote-docker" }, ttlMs: 60_000 });
  await assert.rejects(assertRemoteRerunQuiescent(root, work.provider), /confirmed release/);
  await lease.release(); await assertRemoteRerunQuiescent(root, work.provider);
  const lost = await createExecutionLease({ evalDirectory: root, evalId, workId: work.work_id, reservation: work.reservation,
    worker: { workerId: "worker_remote", provider: work.provider, collisionDomainId: "remote-docker" }, ttlMs: 60_000 });
  await markExecutionLeaseLost({ evalDirectory: root, leaseId: lost.leaseId, expectedEpoch: lost.current().epoch });
  await assert.rejects(assertRemoteRerunQuiescent(root, work.provider), (error: unknown) => (error as { code?: string }).code === "execution_state_ambiguous");
});

test("remote recovery restores the frozen selection after progress changes and rejects changed slots", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-rerun-selection-")); t.after(() => forceRemove(root));
  const trials = [{ task_id: "task-a", attempt: 1 }], startedAt = "2026-01-01T00:00:00.000Z";
  const saved = { schema_version: "1", eval_id: evalId, rerun_id: rerunId, rerun_type: "candidate-restart",
    semantics: evalRerunSemantics("candidate-restart"), mode: "tasks", tasks: ["task-a"], trials, base_generation: 1, created_at: startedAt };
  const progress = { ...createEvalProgress({ evalId, benchmarkId: "demo", benchmarkRevision: "1.0", plannedTasks: 2, plannedTrials: 2, startedAt }), generation: 4 };
  const input = { directory: root, evalId, rerunId, selector: { mode: "tasks" as const, taskNames: ["task-a"] }, tasks: ["task-a", "task-b"], attempts: 1, progress };
  const file = path.join(root, "request.json"); await atomicWriteJSON(file, saved);
  assert.deepEqual(await restoreRemoteRerunSelection(input), { trials, startedAt });
  for (const changed of [ { trials: [...trials, ...trials] }, { trials: [{ task_id: "task-a", attempt: 2 }] },
    { tasks: ["task-b"], trials: [{ task_id: "task-b", attempt: 1 }] }, { base_generation: 5 }, { mode: "invalid" }, { eval_id: `eval_${"f".repeat(32)}` } ]) {
    await atomicWriteJSON(file, { ...saved, ...changed });
    await assert.rejects(restoreRemoteRerunSelection(input), { code: "execution_state_ambiguous" });
  }
});

test("a withdrawn candidate offer records non-execution before redispatch and cannot later be accepted", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-rerun-withdraw-")); t.after(() => forceRemove(root));
  const { plan, work, source, physical } = fixture(), evalDirectory = path.join(root, "evals", evalId);
  const directory = path.join(evalDirectory, "reruns", rerunId), registry = new RemoteWorkerRegistry({ root });
  const protocol = new RemoteWorkerProtocol({ root, registry }); await registry.initialize(); await protocol.initialize();
  const zero = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
  await registry.register({ schema_version: "1", worker_id: "worker_remote", provider: work.provider, collision_domain_id: "remote-docker",
    platforms: ["linux/amd64"], backends: [{ id: "harbor", version: "0.21.0" }], task_membership: ["known"],
    features: { docker: true, buildkit: true, model_proxy: false, isolated_same_task_attempts: false, physical_work: "2" },
    capacity: { total: work.reservation, allocatable: work.reservation, reserved_for_system: zero } });
  await atomicWriteJSON(path.join(evalDirectory, "plan.json"), { schema_version: "1" });
  await atomicWriteJSON(path.join(evalDirectory, "execution-plan.json"), plan);
  await atomicWriteJSON(path.join(evalDirectory, "request.json"), request);
  await atomicWriteJSON(path.join(evalDirectory, "resolution.json"), { identity: `sha256:${"a".repeat(64)}` });
  await writeEvalProgress(evalDirectory, createEvalProgress({ evalId, benchmarkId: "demo", benchmarkRevision: "1.0", plannedTasks: 1, plannedTrials: 1, startedAt: new Date().toISOString() }));
  const leaseInput = { evalDirectory, evalId, workId: work.work_id, reservation: work.reservation,
    worker: { workerId: "worker_remote", provider: work.provider, collisionDomainId: "remote-docker" }, ttlMs: 60_000, initialState: "offered" as const };
  const lease = await createExecutionLease(leaseInput), store = new RemoteWorkInputStore(root);
  const ref = await store.put("work-spec", "json", Buffer.from(JSON.stringify({ schema_version: "2", plan, work,
    physical_execution: physical, request: { ...request, dataset: "task-input" } })));
  const offer = await protocol.createOffer("worker_remote", lease.current(), work, [ref]);
  const identity = { schema_version: "1", rerun_id: rerunId, source_work_id: source.work_id, work_id: work.work_id,
    plan_digest: sha256JSON(plan), request_digest: sha256JSON(request) };
  const journalPath = path.join(directory, "remote-work", `${work.work_id}.json`);
  await atomicWriteJSON(journalPath, { identity, state: "dispatching" });
  const recover = async () => recoverRemoteWorkerEvalLeases({ root, evalId, evalDirectory, leases: await readExecutionLeases(evalDirectory),
    registry, protocol, pollIntervalMs: 5, releaseTimeoutMs: 10 });
  const recovered = await recover(); assert.equal(recovered.status, "resumable", JSON.stringify(recovered));
  assert.equal((await readJSON<{ state: string }>(journalPath)).state, "not-started");
  assert.equal((await readExecutionLeases(evalDirectory))[0]!.state, "released");
  assert.equal((await recover()).status, "resumable");
  await assert.rejects(protocol.acceptOffer(offer.worker_id, { schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce,
    generation: offer.generation, accepted: true, sent_at: new Date().toISOString() }));
  const slots = [{ task_id: "task-a", attempt: 1 }];
  assert.equal(await remoteRerunNeedsExecution({ evalDirectory, directory, rerunId, plan, request, slots }), true);
  let dispatched = 0;
  await executeRemoteRerunGroup({ root, evalId, evalDirectory, rerunDirectory: directory, rerunId, request, plan, slots,
    artifact: { artifact_id: source.artifact_id } as never, resolvedRevision: {} as never, runtimeDirectory: root,
    runtimeId: `sha256:${"c".repeat(64)}`, publish: async () => {}, executor: async () => {
      dispatched++; const next = await createExecutionLease(leaseInput); await next.release();
      return { leaseId: next.leaseId, refs: [], run: { backend: { process_exit_code: 0 }, rawResult: {}, summary: {} } as never };
    } });
  assert.equal(dispatched, 1); assert.equal((await readExecutionLeases(evalDirectory)).length, 2);
  assert.equal((await recover()).status, "resumable", "old withdrawn offers cannot invalidate a later execution of the same physical work");
  assert.equal(await remoteRerunNeedsExecution({ evalDirectory, directory, rerunId, plan, request, slots }), false);
});
