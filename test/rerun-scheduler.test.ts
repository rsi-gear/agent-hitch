import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CollisionLockManager, EvalRerunScheduler, RemoteWorkCoordinator, RemoteWorkerProtocol, RemoteWorkerRegistry, ResourceLedger } from "../src/control-plane/index.js";
import type { EvalControlV1, EvalExecutionPolicyV1, EvalId, EvalRequest, ResourceVectorV1 } from "../src/domain/index.js";
import type { EvalRerunResult, RerunEvalOptions } from "../src/evals/index.js";
import { buildEvalExecutionPlan, createExecutionLease, evalRerunSemantics, markExecutionLeaseLost, readExecutionLeases, stageRemoteRerunCompletion, validateEvalRequest } from "../src/evals/index.js";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import { atomicWriteJSON, readJSON, sha256JSON } from "../src/foundation/index.js";

const TRIAL: ResourceVectorV1 = { cpu_millis: 1_000, memory_bytes: 1024, container_slots: 1, build_slots: 0 };
const EVAL_ID = "eval_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as EvalId;

test("rerun scheduler persists a typed operation and waits for shared capacity", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-rerun-scheduler-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await persistTerminalEval(root, EVAL_ID);
  const ledger = new ResourceLedger(TRIAL);
  const blocker = ledger.tryAcquire("blocking_eval", "eval", TRIAL);
  assert.ok(blocker);
  const observed: RerunEvalOptions[] = [];
  const scheduler = new EvalRerunScheduler({
    root,
    resources: ledger,
    trialResources: TRIAL,
    executor: async (options) => {
      observed.push(options);
      return completedResult(options);
    },
  });
  await scheduler.initialize();
  t.after(() => scheduler.shutdown());

  const accepted = await scheduler.submit(EVAL_ID, {
    rerun_type: "candidate-restart",
    selector: { mode: "tasks", task_names: ["task-a"] },
  });
  assert.match(accepted.rerunId, /^rerun_[a-f0-9]{32}$/);
  assert.equal((await scheduler.status(EVAL_ID, accepted.rerunId))?.state.status, "queued");
  assert.equal(observed.length, 0);
  blocker.release();
  await waitFor(async () => (await scheduler.status(EVAL_ID, accepted.rerunId))?.state.status === "completed");
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.rerunId, accepted.rerunId);
  assert.equal(observed[0]?.rerunType, "candidate-restart");
  assert.equal(observed[0]?.maxConcurrentOverride, 1);
  assert.deepEqual(observed[0]?.selector, { mode: "tasks", taskNames: ["task-a"] });
  const operation = await scheduler.status(EVAL_ID, accepted.rerunId);
  assert.equal(operation?.submission.rerun_type, "candidate-restart");
  assert.deepEqual((operation?.submission.semantics as Record<string, unknown>).conversation_source, "original-instruction");
  assert.equal(operation?.result?.status, "completed");
  assert.equal((await readJSON<EvalControlV1>(path.join(root, "evals", EVAL_ID, "control.json"))).state, "succeeded");
  assert.deepEqual(ledger.snapshot().allocated, { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 });
});

test("collect-only runs without candidate resource or collision reservations", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-collect-scheduler-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await persistTerminalEval(root, EVAL_ID);
  const ledger = new ResourceLedger(TRIAL);
  const blocker = ledger.tryAcquire("running-candidate", "eval", TRIAL);
  assert.ok(blocker);
  let observed: RerunEvalOptions | undefined;
  const scheduler = new EvalRerunScheduler({
    root,
    resources: ledger,
    trialResources: TRIAL,
    executor: async (options) => { observed = options; return completedResult(options); },
  });
  await scheduler.initialize();
  t.after(() => scheduler.shutdown());
  const accepted = await scheduler.submit(EVAL_ID, { rerun_type: "collect-only", selector: { mode: "invalid" } });
  await waitFor(async () => (await scheduler.status(EVAL_ID, accepted.rerunId))?.state.status === "completed");
  assert.equal(observed?.rerunType, "collect-only");
  assert.equal(observed?.maxConcurrentOverride, 1);
  assert.deepEqual(observed?.executionResources, { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 });
  assert.deepEqual(ledger.snapshot().allocated, TRIAL);
  blocker.release();
});

test("candidate rerun inherits the source execution policy", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-rerun-source-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceTrial = { cpu_millis: 2_000, memory_bytes: 2_048, container_slots: 1, build_slots: 0 };
  const execution: EvalExecutionPolicyV1 = {
    provider: "local-docker",
    max_parallelism: 2,
    resources: { default_trial: sourceTrial },
    build: { mode: "backend" },
    model_capture: { mode: "native", required: false },
  };
  await persistTerminalEval(root, EVAL_ID, execution);
  let observed: RerunEvalOptions | undefined;
  const scheduler = new EvalRerunScheduler({
    root,
    resources: new ResourceLedger({ cpu_millis: 4_000, memory_bytes: 4_096, container_slots: 2, build_slots: 0 }),
    trialResources: TRIAL,
    executor: async (options) => { observed = options; return completedResult(options); },
  });
  await scheduler.initialize();
  t.after(() => scheduler.shutdown());
  const accepted = await scheduler.submit(EVAL_ID, { rerun_type: "candidate-restart", selector: { mode: "invalid" } });
  await waitFor(async () => (await scheduler.status(EVAL_ID, accepted.rerunId))?.state.status === "completed");
  assert.equal(observed?.maxConcurrentOverride, 2);
  assert.deepEqual(observed?.executionResources, sourceTrial);
  assert.equal(observed?.executionResourceSource, "submission-default");
  assert.equal(observed?.executionStrategy, "local-task-slots-v1");
  assert.equal(observed?.environmentBuildMode, "backend");
  assert.deepEqual(observed?.modelCapturePlan, { requested_mode: "native", effective_mode: "native", required: false });
});

test("candidate rerun preserves model capture policy from the source submission", async (t) => {
  const cases = [
    {
      id: `eval_${"b".repeat(32)}` as EvalId,
      harnessRef: "pi@version:1.2.3",
      policy: { mode: "off" as const, required: false },
      expected: { requested_mode: "off", effective_mode: "off", required: false },
    },
    {
      id: `eval_${"c".repeat(32)}` as EvalId,
      harnessRef: "codex@version:1.2.3",
      policy: { mode: "proxy" as const, required: true },
      expected: { requested_mode: "proxy", effective_mode: "proxy", required: true, topology: "host-side" },
    },
  ];

  for (const fixture of cases) {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-rerun-capture-policy-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const execution: EvalExecutionPolicyV1 = {
      provider: "local-docker",
      max_parallelism: 1,
      resources: { default_trial: TRIAL },
      build: { mode: "backend" },
      model_capture: fixture.policy,
    };
    await persistTerminalEval(root, fixture.id, execution, fixture.harnessRef);
    let observed: RerunEvalOptions | undefined;
    const scheduler = new EvalRerunScheduler({
      root,
      resources: new ResourceLedger(TRIAL),
      trialResources: TRIAL,
      executor: async (options) => { observed = options; return completedResult(options); },
    });
    await scheduler.initialize();
    await scheduler.submit(fixture.id, { rerun_type: "candidate-restart", selector: { mode: "invalid" } });
    await waitFor(async () => observed !== undefined);
    assert.deepEqual(observed?.modelCapturePlan, fixture.expected);
    await scheduler.shutdown();
  }
});

test("verifier-only admission reserves the original work limits and runs serially", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-regrade-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await persistTerminalEval(root, EVAL_ID);
  const request = await validateEvalRequest({ dataset: "demo@1.0", harness_ref: "pi@version:1.2.3", max_concurrent: 4 });
  const heavy = { ...TRIAL, cpu_millis: 4000, memory_bytes: 4096, container_slots: 2 };
  const plan = buildEvalExecutionPlan({ evalId: EVAL_ID, request, candidate: { revisionIdentity: `sha256:${"a".repeat(64)}`, artifactId: `sha256:${"b".repeat(64)}` }, tasks: ["task-a"], maxParallelism: 1, trialResources: heavy, workItemMode: "task-slots" });
  await atomicWriteJSON(path.join(root, "evals", EVAL_ID, "execution-plan.json"), plan);
  const small = new EvalRerunScheduler({ root, resources: new ResourceLedger(TRIAL), trialResources: TRIAL });
  await small.initialize();
  await assert.rejects(small.submit(EVAL_ID, { rerun_type: "verifier-only", selector: { mode: "invalid" } }), /exceeds the daemon resource capacity/);
  await small.shutdown();
  const ledger = new ResourceLedger(heavy), blocker = ledger.tryAcquire("another", "eval", TRIAL)!;
  const observed: RerunEvalOptions[] = [];
  const scheduler = new EvalRerunScheduler({ root, resources: ledger, trialResources: TRIAL, executor: async options => { observed.push(options); return completedResult(options); } });
  await scheduler.initialize(); t.after(() => scheduler.shutdown());
  const verifierRuntime = `sha256:${"b".repeat(64)}`;
  const accepted = await scheduler.submit(EVAL_ID, { rerun_type: "verifier-only", verifier_runtime_id: verifierRuntime, selector: { mode: "invalid" } });
  assert.equal((await scheduler.status(EVAL_ID, accepted.rerunId))?.state.status, "queued");
  await assert.rejects(scheduler.submit(EVAL_ID, { rerun_id: accepted.rerunId, rerun_type: "verifier-only", verifier_runtime_id: `sha256:${"c".repeat(64)}`, selector: { mode: "invalid" } }), { code: "idempotency_conflict" });
  assert.equal(observed.length, 0);
  blocker.release();
  await waitFor(async () => (await scheduler.status(EVAL_ID, accepted.rerunId))?.state.status === "completed");
  assert.deepEqual(observed[0]?.executionResources, heavy);
  assert.equal(observed[0]?.maxConcurrentOverride, 1);
  assert.equal(observed[0]?.verifierRuntimeId, verifierRuntime);
});

test("daemon rerun API preserves requested semantics and rejects unavailable resume", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-daemon-rerun-"));
  const server = new DaemonServer({
    root,
    port: 0,
    maxConcurrent: 1,
    logger: () => {},
    evalRerunExecutor: async (options) => completedResult(options),
  });
  await server.start();
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  await persistTerminalEval(root, EVAL_ID);
  const client = await daemonClient(root);
  await assert.rejects(
    client.request(`/v1/evals/${EVAL_ID}/reruns`, {
      method: "POST",
      body: JSON.stringify({ rerun_type: "candidate-resume", selector: { mode: "invalid" } }),
    }),
    (error: unknown) => (error as { status?: number; code?: string }).status === 400
      && (error as { code?: string }).code === "eval_candidate_resume_unavailable",
  );
  const accepted = await client.request(`/v1/evals/${EVAL_ID}/reruns`, {
    method: "POST",
    body: JSON.stringify({ rerun_type: "candidate-restart", selector: { mode: "invalid" } }),
  });
  assert.equal(accepted.status, "queued");
  assert.equal(accepted.rerun_type, "candidate-restart");
  const rerunId = accepted.rerun_id as string;
  await waitFor(async () => {
    const status = await client.request(`/v1/evals/${EVAL_ID}/reruns/${rerunId}`);
    return (status.state as { status?: string }).status === "completed";
  });
  const events = await client.requestWithMetadata(`/v1/evals/${EVAL_ID}/reruns/${rerunId}/events?offset=0`);
  assert.match(String(events.payload), /"type":"eval.rerun.completed"/);
});

test("rerun scheduler resumes queued operations but never replays ambiguous running work", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-rerun-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await persistTerminalEval(root, EVAL_ID);
  const queuedId = "rerun_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const runningId = "rerun_cccccccccccccccccccccccccccccccc";
  await persistRerunOperation(root, queuedId, "queued");
  await persistRerunOperation(root, runningId, "running");
  const executed: string[] = [];
  const scheduler = new EvalRerunScheduler({
    root,
    resources: new ResourceLedger(TRIAL),
    trialResources: TRIAL,
    executor: async (options) => {
      executed.push(options.rerunId as string);
      return completedResult(options);
    },
  });
  await scheduler.initialize();
  t.after(() => scheduler.shutdown());
  await waitFor(async () => (await scheduler.status(EVAL_ID, queuedId))?.state.status === "completed");
  assert.deepEqual(executed, [queuedId]);
  const interrupted = await scheduler.status(EVAL_ID, runningId);
  assert.equal(interrupted?.state.status, "failed");
  assert.equal((interrupted?.state.error as { code?: string }).code, "execution_state_ambiguous");
});

async function persistTerminalEval(
  root: string,
  evalId: EvalId,
  execution?: EvalExecutionPolicyV1,
  harnessRef = "pi@version:1.2.3",
): Promise<EvalRequest> {
  const directory = path.join(root, "evals", evalId);
  await mkdir(directory, { recursive: true });
  const request = await validateEvalRequest({ dataset: "demo@1.0", harness_ref: harnessRef, max_concurrent: 4 });
  const now = new Date().toISOString();
  await atomicWriteJSON(path.join(directory, "request.json"), request);
  await atomicWriteJSON(path.join(directory, "submission.json"), {
    schema_version: "1",
    eval_id: evalId,
    request,
    ...(execution ? { execution } : {}),
    submission_digest: execution ? sha256JSON({ request, execution }) : sha256JSON(request),
    submitted_at: now,
  });
  await atomicWriteJSON(path.join(directory, "control.json"), {
    schema_version: "1",
    eval_id: evalId,
    generation: 1,
    state: "failed",
    requested_parallelism: request.max_concurrent,
    admitted_parallelism: 0,
    active_leases: [],
    queued_work_items: [],
    terminal_work_items: [],
    error: { code: "eval_has_invalid_tasks", message: "one task is invalid" },
    created_at: now,
    updated_at: now,
  } satisfies EvalControlV1);
  await atomicWriteJSON(path.join(directory, "result.json"), {
    schema_version: "1",
    eval_id: evalId,
    status: "failed",
    exit_code: 1,
    error: { code: "eval_has_invalid_tasks", message: "one task is invalid" },
    started_at: now,
    completed_at: now,
  });
  return request;
}

function completedResult(options: RerunEvalOptions): EvalRerunResult {
  const now = new Date().toISOString();
  return {
    schema_version: "1",
    kind: "eval-rerun",
    rerun_id: options.rerunId as string,
    rerun_type: options.rerunType as NonNullable<RerunEvalOptions["rerunType"]>,
    semantics: evalRerunSemantics(options.rerunType as NonNullable<RerunEvalOptions["rerunType"]>),
    eval_id: options.evalId,
    status: "completed",
    selected_tasks: [],
    repaired_tasks: [],
    remaining_invalid_tasks: [],
    selected_trials: [],
    repaired_trials: [],
    remaining_invalid_trials: [],
    eval_status: "succeeded",
    started_at: now,
    completed_at: now,
  };
}

async function persistRerunOperation(root: string, rerunId: string, status: "queued" | "running", rerunType: "candidate-restart" | "verifier-only" = "candidate-restart"): Promise<void> {
  const directory = path.join(root, "evals", EVAL_ID, "reruns", rerunId);
  await mkdir(directory, { recursive: true });
  const now = new Date().toISOString();
  const semantics = evalRerunSemantics(rerunType);
  await atomicWriteJSON(path.join(directory, "submission.json"), {
    schema_version: "1",
    rerun_id: rerunId,
    eval_id: EVAL_ID,
    rerun_type: rerunType,
    semantics,
    selector: { mode: "invalid" },
    submitted_at: now,
  });
  await atomicWriteJSON(path.join(directory, "state.json"), {
    schema_version: "1",
    rerun_id: rerunId,
    eval_id: EVAL_ID,
    rerun_type: rerunType,
    semantics,
    status,
    tasks: [],
    repaired_tasks: [],
    submitted_at: now,
    ...(status === "running" ? { started_at: now } : {}),
    updated_at: now,
  });
}

async function waitFor(predicate: () => Promise<boolean>, attempts = 200): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for rerun state");
}

test("rerun cancellation stops the independent executor and waits for resource cleanup", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-rerun-cancel-"));
  let started = false;
  let aborted = false;
  let stopped = false;
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const server = new DaemonServer({ root, port: 0, maxConcurrent: 1, logger: () => {},
    evalRerunExecutor: async options => {
      started = true;
      await new Promise<void>(resolve => {
        options.signal!.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
      });
      await cleanup;
      stopped = true;
      throw new Error("executor stopped");
    },
  });
  await server.start();
  t.after(async () => { releaseCleanup(); await server.close(); await rm(root, { recursive: true, force: true }); });
  await persistTerminalEval(root, EVAL_ID);
  const client = await daemonClient(root);
  const rerunId = `rerun_${"d".repeat(32)}`;
  await client.request(`/v1/evals/${EVAL_ID}/reruns`, { method: "POST", body: JSON.stringify({ rerun_id: rerunId, selector: { mode: "invalid" } }) });
  await waitFor(async () => started);
  // This is the exact regression: cancelling the terminal source does nothing.
  await client.request(`/v1/evals/${EVAL_ID}/cancel`, { method: "POST" });
  assert.equal(aborted, false);
  let acknowledged = false;
  const cancellation = client.request(`/v1/evals/${EVAL_ID}/reruns/${rerunId}/cancel`, { method: "POST" }).then(value => { acknowledged = true; return value; });
  await waitFor(async () => aborted);
  assert.equal(acknowledged, false);
  releaseCleanup();
  const response = await cancellation;
  assert.equal(response.rerun_id, rerunId);
  assert.equal(stopped, true);
  const health = await client.request("/health");
  assert.equal((health.eval_rerun_scheduler as { running: number }).running, 0);
  assert.equal((await readJSON<EvalControlV1>(path.join(root, "evals", EVAL_ID, "control.json"))).state, "failed");
});

test("queued and not-yet-submitted rerun identities stay cancelled after restart", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-rerun-fence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await persistTerminalEval(root, EVAL_ID);
  const ledger = new ResourceLedger(TRIAL);
  const blocker = ledger.tryAcquire("blocker", "eval", TRIAL)!;
  let executions = 0;
  const options = { root, resources: ledger, trialResources: TRIAL, executor: async (options: RerunEvalOptions) => { executions++; return completedResult(options); } };
  const scheduler = new EvalRerunScheduler(options);
  await scheduler.initialize();
  const queuedId = `rerun_${"e".repeat(32)}`;
  const lateId = `rerun_${"f".repeat(32)}`;
  const input = { rerun_id: queuedId, selector: { mode: "invalid" } };
  await scheduler.submit(EVAL_ID, input);
  assert.equal(await scheduler.cancel(EVAL_ID, queuedId), "cancelled");
  assert.equal(await scheduler.cancel(EVAL_ID, lateId), "cancelled");
  await scheduler.shutdown();
  blocker.release();
  const recovered = new EvalRerunScheduler(options);
  await recovered.initialize();
  t.after(() => recovered.shutdown());
  for (const rerun_id of [queuedId, lateId]) {
    await assert.rejects(recovered.submit(EVAL_ID, { ...input, rerun_id }), { code: "eval_rerun_cancelled" });
    assert.equal(await recovered.cancel(EVAL_ID, rerun_id), "cancelled");
  }
  assert.equal(executions, 0);
  assert.equal((await recovered.status(EVAL_ID, queuedId))?.state.status, "cancelled");
});

test("concurrent rerun submission replays one durable identity and rejects changed selectors", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-rerun-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await persistTerminalEval(root, EVAL_ID);
  let executions = 0;
  const scheduler = new EvalRerunScheduler({ root, resources: new ResourceLedger(TRIAL), trialResources: TRIAL,
    executor: async options => { executions++; return completedResult(options); },
  });
  await scheduler.initialize();
  t.after(() => scheduler.shutdown());
  const input = { rerun_id: `rerun_${"1".repeat(32)}`, selector: { mode: "invalid" } };
  const results = await Promise.all([scheduler.submit(EVAL_ID, input), scheduler.submit(EVAL_ID, input)]);
  assert.deepEqual(results[0], results[1]);
  await waitFor(async () => (await scheduler.status(EVAL_ID, input.rerun_id))?.state.status === "completed");
  await scheduler.submit(EVAL_ID, input);
  assert.equal(executions, 1);
  await assert.rejects(scheduler.submit(EVAL_ID, { ...input, selector: { mode: "tasks", task_names: ["other"] } }), { code: "idempotency_conflict" });
});

test("cancellation refuses to claim ambiguous execution stopped after daemon restart", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-rerun-ambiguous-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await persistTerminalEval(root, EVAL_ID);
  const rerunId = `rerun_${"2".repeat(32)}`;
  await persistRerunOperation(root, rerunId, "running");
  const scheduler = new EvalRerunScheduler({ root, resources: new ResourceLedger(TRIAL), trialResources: TRIAL });
  await scheduler.initialize();
  t.after(() => scheduler.shutdown());
  await assert.rejects(scheduler.cancel(EVAL_ID, rerunId), { code: "execution_state_ambiguous" });
});

test("an offline remote rerun does not prevent daemon recovery or fall back locally", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-rerun-offline-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await persistTerminalEval(root, EVAL_ID, { provider: "remote-docker", max_parallelism: 1,
    resources: { default_trial: TRIAL }, build: { mode: "backend" }, model_capture: { mode: "native", required: false } });
  const runningId = `rerun_${"3".repeat(32)}`, queuedId = `rerun_${"4".repeat(32)}`;
  await persistRerunOperation(root, runningId, "running"); await persistRerunOperation(root, queuedId, "queued");
  let executed = 0;
  const scheduler = new EvalRerunScheduler({ root, resources: new ResourceLedger(TRIAL), trialResources: TRIAL,
    executor: async options => { executed++; return completedResult(options); } });
  await scheduler.initialize(); t.after(() => scheduler.shutdown());
  const running = await scheduler.status(EVAL_ID, runningId), queued = await scheduler.status(EVAL_ID, queuedId);
  assert.equal(running?.state.status, "failed"); assert.equal((running?.state.error as { code: string }).code, "execution_state_ambiguous");
  assert.equal(queued?.state.status, "failed"); assert.equal((queued?.state.error as { code: string }).code, "remote_rerun_unavailable");
  assert.equal(executed, 0);
});

test("new candidate repair reconciles a late cleanup receipt without reviving the fenced execution", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-rerun-late-cleanup-")); t.after(() => rm(root, { recursive: true, force: true }));
  const execution = { provider: "remote-docker", max_parallelism: 1, resources: { default_trial: TRIAL },
    build: { mode: "backend" as const }, model_capture: { mode: "native" as const, required: false } };
  const request = await persistTerminalEval(root, EVAL_ID, execution), evalDirectory = path.join(root, "evals", EVAL_ID);
  const registry = new RemoteWorkerRegistry({ root }), protocol = new RemoteWorkerProtocol({ root, registry });
  await registry.initialize(); await protocol.initialize();
  await registry.register({ schema_version: "1", worker_id: "worker_late", provider: execution.provider, collision_domain_id: "docker:late",
    platforms: ["linux/amd64"], backends: [{ id: "harbor", version: "0.21.0" }], task_membership: ["known"],
    features: { docker: true, buildkit: true, model_proxy: false, isolated_same_task_attempts: false, physical_work: "2" },
    capacity: { total: TRIAL, allocatable: TRIAL, reserved_for_system: { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 } } });
  const work = buildEvalExecutionPlan({ evalId: EVAL_ID, request, tasks: ["one"], provider: execution.provider, workItemMode: "task-slots",
    candidate: { revisionIdentity: `sha256:${"a".repeat(64)}`, artifactId: `sha256:${"b".repeat(64)}` },
    maxParallelism: 1, trialResources: TRIAL, createdAt: new Date().toISOString() }).work_items[0]!;
  const lease = await createExecutionLease({ evalDirectory, evalId: EVAL_ID, workId: work.work_id, reservation: work.reservation,
    worker: { workerId: "worker_late", provider: execution.provider, collisionDomainId: "docker:late" }, ttlMs: 60_000, initialState: "offered" });
  const offer = await protocol.createOffer("worker_late", lease.current(), work);
  await protocol.acceptOffer(offer.worker_id, { schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce,
    generation: 1, accepted: true, sent_at: new Date().toISOString() });
  await protocol.completeOffer(offer.worker_id, { schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce,
    generation: 1, lease_id: lease.leaseId, epoch: 1, status: "failed", artifacts: [], sent_at: new Date().toISOString() });
  await markExecutionLeaseLost({ evalDirectory, leaseId: lease.leaseId, expectedEpoch: 1 });
  const collisions = new CollisionLockManager(), remoteWork = new RemoteWorkCoordinator({ root, registry, protocol, collisions });
  let executions = 0, cancelNext = false;
  let pendingLease: Awaited<ReturnType<typeof createExecutionLease>> | undefined;
  const scheduler = new EvalRerunScheduler({ root, resources: new ResourceLedger(TRIAL), trialResources: TRIAL, collisions, remoteWork,
    executor: async options => {
      executions++; assert.equal(options.executionWorker!.provider, execution.provider);
      if (cancelNext) {
        pendingLease = await createExecutionLease({ evalDirectory, evalId: EVAL_ID, workId: work.work_id, reservation: work.reservation,
          worker: { workerId: "worker_late", provider: execution.provider, collisionDomainId: "docker:late" }, ttlMs: 60_000 });
        await new Promise<void>((_, reject) => options.signal!.addEventListener("abort", () => reject(new Error("worker disconnected during cancellation")), { once: true }));
      }
      return completedResult(options);
    } });
  await scheduler.initialize(); t.after(() => scheduler.shutdown());
  await assert.rejects(scheduler.submit(EVAL_ID, { selector: { mode: "invalid" } }), { code: "execution_state_ambiguous" });
  assert.equal(executions, 0);
  await protocol.releaseOffer(offer.worker_id, { schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce,
    generation: 1, lease_id: lease.leaseId, epoch: 1, sent_at: new Date().toISOString() });
  const submitted = await scheduler.submit(EVAL_ID, { selector: { mode: "invalid" } });
  await waitFor(async () => (await scheduler.status(EVAL_ID, submitted.rerunId))!.state.status === "completed");
  assert.equal(executions, 1);
  const confirmed = (await readExecutionLeases(evalDirectory))[0]!;
  assert.equal(confirmed.state, "released"); assert.equal(confirmed.epoch, 2);
  assert.deepEqual(confirmed.resource_epochs, [1]); assert.equal(confirmed.release_confirmation!.execution_epoch, 1);
  cancelNext = true;
  const interrupted = await scheduler.submit(EVAL_ID, { selector: { mode: "invalid" } });
  await waitFor(async () => pendingLease !== undefined);
  await assert.rejects(scheduler.cancel(EVAL_ID, interrupted.rerunId), { code: "execution_state_ambiguous" });
  const unresolved = await scheduler.status(EVAL_ID, interrupted.rerunId);
  assert.equal(unresolved!.state.status, "failed"); assert.equal((unresolved!.state.error as { code: string }).code, "execution_state_ambiguous");
  await assert.rejects(scheduler.cancel(EVAL_ID, interrupted.rerunId), { code: "execution_state_ambiguous" });
  assert.equal((await readExecutionLeases(evalDirectory)).find(item => item.lease_id === pendingLease!.leaseId)!.state, "accepted");
  await pendingLease!.release();
});

for (const rerunType of ["candidate-restart", "verifier-only"] as const)
for (const boundary of ["running", "completed", "newer-source", "corrupt-result", "late-cancel"] as const) test(`remote ${rerunType} completion handoff recovers ${boundary} without executing a candidate`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-rerun-handoff-")); t.after(() => rm(root, { recursive: true, force: true }));
  await persistTerminalEval(root, EVAL_ID, { provider: "remote-docker", max_parallelism: 1, resources: { default_trial: TRIAL },
    build: { mode: "backend" }, model_capture: { mode: "native", required: false } });
  const rerunId = `rerun_${"d".repeat(32)}`, evalDirectory = path.join(root, "evals", EVAL_ID), directory = path.join(evalDirectory, "reruns", rerunId);
  await persistRerunOperation(root, rerunId, "running", rerunType);
  const result = completedResult({ root, evalId: EVAL_ID, rerunId, rerunType, selector: { mode: "invalid" } });
  await atomicWriteJSON(path.join(directory, "request.json"), { schema_version: "1", eval_id: EVAL_ID, rerun_id: rerunId,
    rerun_type: rerunType, semantics: result.semantics, tasks: result.selected_tasks, trials: result.selected_trials });
  const sourceResult = { schema_version: "1", eval_id: EVAL_ID, status: "succeeded", generation: 2 };
  await atomicWriteJSON(path.join(evalDirectory, "result.json"), sourceResult);
  await stageRemoteRerunCompletion(evalDirectory, directory, result);
  if (boundary !== "running") {
    const state = await readJSON<Record<string, unknown>>(path.join(directory, "state.json"));
    await atomicWriteJSON(path.join(directory, "state.json"), { ...state, status: "completed", completed_at: result.completed_at });
  }
  if (boundary === "newer-source") await atomicWriteJSON(path.join(evalDirectory, "result.json"), { ...sourceResult, status: "failed", generation: 3 });
  if (boundary === "late-cancel") await atomicWriteJSON(path.join(directory, "cancellation.json"), { schema_version: "1", eval_id: EVAL_ID, rerun_id: rerunId });
  if (boundary === "corrupt-result") {
    const record = await readJSON<{ result: EvalRerunResult }>(path.join(directory, "completion-pending.json"));
    await atomicWriteJSON(path.join(directory, "completion-pending.json"), { ...record, result: { ...record.result, repaired_tasks: ["invented"] } });
  }
  let executions = 0;
  const options = { root, resources: new ResourceLedger(TRIAL), trialResources: TRIAL,
    executor: async () => { executions++; return result; } };
  const scheduler = new EvalRerunScheduler(options); await scheduler.initialize();
  const status = await scheduler.status(EVAL_ID, rerunId); assert.equal(executions, 0);
  if (boundary === "corrupt-result") {
    assert.equal(status!.state.status, "failed"); assert.equal((status!.state.error as { code: string }).code, "execution_state_ambiguous");
  } else {
    assert.equal(status!.state.status, "completed"); assert.deepEqual(status!.result, result);
    assert.equal(await readJSON(path.join(directory, "completion-pending.json"), null), null);
    assert.equal((await readJSON<EvalControlV1>(path.join(evalDirectory, "control.json"))).state, boundary === "newer-source" ? "failed" : "succeeded");
  }
  await scheduler.shutdown();
  const control = await readJSON(path.join(evalDirectory, "control.json"));
  const again = new EvalRerunScheduler({ ...options, resources: new ResourceLedger(TRIAL) });
  await again.initialize(); await again.shutdown();
  assert.deepEqual(await readJSON(path.join(evalDirectory, "control.json")), control); assert.equal(executions, 0);
});
