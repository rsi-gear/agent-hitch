import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EvalScheduler, ResourceLedger, scaleResources } from "../src/control-plane/index.js";
import type { EvalControlV1, EvalRequest, ResourceVectorV1 } from "../src/domain/index.js";
import type { EvalResult, RunEvalOptions } from "../src/evals/index.js";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import { atomicWriteJSON, delay, readJSON, sha256JSON } from "../src/foundation/index.js";

const GIB = 1024 * 1024 * 1024;
const TRIAL: ResourceVectorV1 = { cpu_millis: 2_000, memory_bytes: 4 * GIB, container_slots: 1, build_slots: 0 };

function request(maxConcurrent = 4): Record<string, unknown> {
  return {
    dataset: "demo@1.0",
    harness_ref: "pi@version:1.2.3",
    max_concurrent: maxConcurrent,
  };
}

function fakeEvalExecutor(delayMs = 60, observed: number[] = []): (options: RunEvalOptions) => Promise<EvalResult> {
  return async (options) => {
    observed.push(options.maxConcurrentOverride || 0);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    const cancelled = options.signal?.aborted === true;
    const now = new Date().toISOString();
    return {
      schema_version: "1",
      eval_id: options.evalId as never,
      status: cancelled ? "cancelled" : "succeeded",
      exit_code: cancelled ? 9 : 0,
      ...(cancelled ? { error: { code: "cancelled", message: "eval was cancelled" } } : {}),
      started_at: now,
      completed_at: now,
    };
  };
}

test("resource ledger reserves vectors atomically and releases idempotently", () => {
  const ledger = new ResourceLedger({ cpu_millis: 8_000, memory_bytes: 16 * GIB, container_slots: 4, build_slots: 1 });
  assert.equal(ledger.maximumUnits(TRIAL, 8), 4);
  const first = ledger.tryAcquire("eval_a", "eval", scaleResources(TRIAL, 2));
  assert.ok(first);
  assert.equal(ledger.maximumUnits(TRIAL, 8), 2);
  const second = ledger.tryAcquire("eval_b", "eval", scaleResources(TRIAL, 2));
  assert.ok(second);
  assert.equal(ledger.tryAcquire("eval_c", "eval", TRIAL), null);
  assert.deepEqual(ledger.snapshot().allocated, { cpu_millis: 8_000, memory_bytes: 16 * GIB, container_slots: 4, build_slots: 0 });
  first.release();
  first.release();
  assert.equal(ledger.maximumUnits(TRIAL, 8), 2);
  second.release();
  assert.deepEqual(ledger.snapshot().allocated, { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 });
});

test("eval scheduler caps Harbor concurrency, persists requested policy, and releases capacity on cancel", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const observed: number[] = [];
  const ledger = new ResourceLedger({ cpu_millis: 4_000, memory_bytes: 8 * GIB, container_slots: 2, build_slots: 1 });
  const scheduler = new EvalScheduler({ root, resources: ledger, trialResources: TRIAL, executor: fakeEvalExecutor(200, observed) });
  await scheduler.initialize();
  t.after(() => scheduler.shutdown());

  const first = await scheduler.submit(request(8));
  const second = await scheduler.submit(request(8));
  await waitFor(() => scheduler.status(first).then((status) => status?.control.state === "running"));
  const firstStatus = await scheduler.status(first);
  assert.equal(firstStatus?.control.requested_parallelism, 8);
  assert.equal(firstStatus?.control.admitted_parallelism, 2);
  assert.equal((await scheduler.status(second))?.control.state, "queued");
  assert.equal((await readJSON<EvalRequest>(path.join(root, "evals", first, "request.json"))).max_concurrent, 8);

  assert.equal(await scheduler.cancel(first), "accepted");
  await waitFor(() => scheduler.status(first).then((status) => status?.result !== null));
  await waitFor(() => scheduler.status(second).then((status) => status?.control.state === "running"));
  assert.deepEqual(observed.slice(0, 2), [2, 2]);
  await waitFor(() => scheduler.status(second).then((status) => status?.result !== null));
  assert.equal((await scheduler.status(first))?.result?.status, "cancelled");
  assert.equal((await scheduler.status(second))?.result?.status, "succeeded");
});

test("eval scheduler fails an ambiguous interrupted execution without replaying it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evalId = "eval_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const directory = path.join(root, "evals", evalId);
  await mkdir(directory, { recursive: true });
  const normalized: EvalRequest = {
    schema_version: "1",
    backend: "harbor",
    dataset: "demo@1.0",
    harness_ref: "pi@version:1.2.3",
    model: "",
    attempts: 1,
    max_concurrent: 2,
    infrastructure_retries: 1,
    infrastructure_retry_backoff_ms: 1_000,
    timeout_ms: 900_000,
    setup_timeout_ms: 1_800_000,
    agent_args: [],
    pass_env: [],
    benchmark_id: "demo",
    benchmark_revision: "1.0",
  };
  const now = new Date().toISOString();
  await atomicWriteJSON(path.join(directory, "request.json"), normalized);
  await atomicWriteJSON(path.join(directory, "submission.json"), {
    schema_version: "1",
    eval_id: evalId,
    request: normalized,
    submission_digest: sha256JSON(normalized),
    submitted_at: now,
  });
  await atomicWriteJSON(path.join(directory, "control.json"), {
    schema_version: "1",
    eval_id: evalId,
    generation: 1,
    state: "running",
    requested_parallelism: 2,
    admitted_parallelism: 2,
    allocation_id: "allocation_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    created_at: now,
    updated_at: now,
  } satisfies EvalControlV1);

  let executions = 0;
  const scheduler = new EvalScheduler({
    root,
    resources: new ResourceLedger({ cpu_millis: 4_000, memory_bytes: 8 * GIB, container_slots: 2, build_slots: 1 }),
    trialResources: TRIAL,
    executor: async (options) => {
      executions += 1;
      return fakeEvalExecutor()(options);
    },
  });
  await scheduler.initialize();
  t.after(() => scheduler.shutdown());
  const status = await scheduler.status(evalId);
  assert.equal(executions, 0);
  assert.equal(status?.control.state, "failed");
  assert.equal((status?.result?.error as { code: string }).code, "execution_state_ambiguous");
});

test("daemon exposes queued eval status and terminal result", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-daemon-eval-"));
  const server = new DaemonServer({
    root,
    port: 0,
    maxConcurrent: 1,
    logger: () => {},
    evalExecutor: fakeEvalExecutor(20),
  });
  await server.start();
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const client = await daemonClient(root);
  const accepted = await client.request("/v1/evals", { method: "POST", body: JSON.stringify(request(4)) });
  assert.match(accepted.eval_id as string, /^eval_[a-f0-9]{32}$/);
  const status = await waitForStatus(client, accepted.eval_id as string);
  assert.equal(status.result.status, "succeeded");
  assert.equal((status.control as { requested_parallelism: number }).requested_parallelism, 4);
  assert.equal((status.control as { admitted_parallelism: number }).admitted_parallelism, 1);
  const events = await client.requestWithMetadata(`/v1/evals/${accepted.eval_id as string}/events?offset=0`);
  assert.match(String(events.payload), /"type":"eval.queued"/);
});

test("daemon eval submission is idempotent and rejects key reuse for different requests", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-daemon-eval-idempotency-"));
  const server = new DaemonServer({ root, port: 0, maxConcurrent: 1, logger: () => {}, evalExecutor: fakeEvalExecutor(20) });
  await server.start();
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const client = await daemonClient(root);
  const options = { method: "POST", body: JSON.stringify(request(1)), headers: { "idempotency-key": "eval-request-1" } };
  const first = await client.request("/v1/evals", options);
  const second = await client.request("/v1/evals", options);
  assert.equal(second.eval_id, first.eval_id);
  await assert.rejects(
    client.request("/v1/evals", {
      method: "POST",
      body: JSON.stringify({ ...request(1), dataset: "other@1.0" }),
      headers: { "idempotency-key": "eval-request-1" },
    }),
    (error: unknown) => (error as { status?: number; code?: string }).status === 409
      && (error as { code?: string }).code === "idempotency_conflict",
  );
});

async function waitFor(predicate: () => Promise<boolean>, attempts = 200): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error("timed out waiting for control-plane state");
}

async function waitForStatus(client: Awaited<ReturnType<typeof daemonClient>>, evalId: string): Promise<{ control: Record<string, unknown>; result: Record<string, unknown> }> {
  for (let index = 0; index < 200; index += 1) {
    const status = await client.request(`/v1/evals/${evalId}`);
    if (status.result) return status as { control: Record<string, unknown>; result: Record<string, unknown> };
    await delay(10);
  }
  throw new Error("timed out waiting for daemon eval result");
}
