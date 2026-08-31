import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EvalRerunScheduler, ResourceLedger } from "../src/control-plane/index.js";
import type { EvalControlV1, EvalExecutionPolicyV1, EvalId, EvalRequest, ResourceVectorV1 } from "../src/domain/index.js";
import type { EvalRerunResult, RerunEvalOptions } from "../src/evals/index.js";
import { evalRerunSemantics, validateEvalRequest } from "../src/evals/index.js";
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

async function persistTerminalEval(root: string, evalId: EvalId, execution?: EvalExecutionPolicyV1): Promise<EvalRequest> {
  const directory = path.join(root, "evals", evalId);
  await mkdir(directory, { recursive: true });
  const request = await validateEvalRequest({ dataset: "demo@1.0", harness_ref: "pi@version:1.2.3", max_concurrent: 4 });
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

async function persistRerunOperation(root: string, rerunId: string, status: "queued" | "running"): Promise<void> {
  const directory = path.join(root, "evals", EVAL_ID, "reruns", rerunId);
  await mkdir(directory, { recursive: true });
  const now = new Date().toISOString();
  const semantics = evalRerunSemantics("candidate-restart");
  await atomicWriteJSON(path.join(directory, "submission.json"), {
    schema_version: "1",
    rerun_id: rerunId,
    eval_id: EVAL_ID,
    rerun_type: "candidate-restart",
    semantics,
    selector: { mode: "invalid" },
    submitted_at: now,
  });
  await atomicWriteJSON(path.join(directory, "state.json"), {
    schema_version: "1",
    rerun_id: rerunId,
    eval_id: EVAL_ID,
    rerun_type: "candidate-restart",
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
