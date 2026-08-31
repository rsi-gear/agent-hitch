import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EvalScheduler, ResourceLedger, applyEvalPhase, applyEvalWorkItem, scaleResources, settleEvalWorkItems } from "../src/control-plane/index.js";
import type { BackendWorkItemV1, EvalControlV1, EvalRequest, ResourceVectorV1, Sha256 } from "../src/domain/index.js";
import type { EvalResult, RunEvalOptions } from "../src/evals/index.js";
import { createExecutionLease, readExecutionLeases, runEval, validateEvalRequest } from "../src/evals/index.js";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import { atomicWriteJSON, delay, readJSON, sha256JSON } from "../src/foundation/index.js";
import { forceRemove, writeFakeHarbor, writeFakeNpm } from "../test-support/helpers.js";
import { EnvironmentImageService } from "../src/images/index.js";

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

test("eval control phases and lease/work sets advance monotonically", () => {
  const now = new Date().toISOString();
  const workA = `work_${"a".repeat(32)}`;
  const workB = `work_${"b".repeat(32)}`;
  const leaseA = `lease_${"c".repeat(32)}`;
  const control: EvalControlV1 = {
    schema_version: "1", eval_id: `eval_${"d".repeat(32)}`, generation: 0, state: "queued",
    requested_parallelism: 2, admitted_parallelism: 0, active_leases: [], queued_work_items: [], terminal_work_items: [],
    created_at: now, updated_at: now,
  };
  const running = applyEvalPhase(control, "running", [workB, workA], []);
  assert.deepEqual(running.queued_work_items, [workA, workB]);
  const active = applyEvalWorkItem(running, workA, leaseA, "running");
  assert.deepEqual(active.active_leases, [leaseA]);
  assert.deepEqual(active.queued_work_items, [workB]);
  const terminal = applyEvalWorkItem(active, workA, leaseA, "terminal");
  assert.deepEqual(terminal.active_leases, []);
  assert.deepEqual(terminal.terminal_work_items, [workA]);
  assert.deepEqual(settleEvalWorkItems(terminal).terminal_work_items, [workA, workB]);
  assert.equal(applyEvalPhase(running, "preparing").state, "running");
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
  await waitFor(() => scheduler.status(first).then((status) => status?.control.state === "planning"));
  const firstStatus = await scheduler.status(first);
  assert.equal(firstStatus?.control.requested_parallelism, 8);
  assert.equal(firstStatus?.control.admitted_parallelism, 2);
  assert.equal(firstStatus?.execution?.build.mode, "prebuild-preferred");
  assert.equal((await scheduler.status(second))?.control.state, "queued");
  assert.equal((await readJSON<EvalRequest>(path.join(root, "evals", first, "request.json"))).max_concurrent, 8);

  assert.equal(await scheduler.cancel(first), "accepted");
  await waitFor(() => scheduler.status(first).then((status) => status?.result !== null));
  await waitFor(() => scheduler.status(second).then((status) => status?.control.state === "planning"));
  await waitFor(() => Promise.resolve(observed.length >= 2));
  assert.deepEqual(observed.slice(0, 2), [2, 2]);
  await waitFor(() => scheduler.status(second).then((status) => status?.result !== null));
  assert.equal((await scheduler.status(first))?.result?.status, "cancelled");
  assert.equal((await scheduler.status(second))?.result?.status, "succeeded");
});

test("eval submission execution policy is pinned and drives admission", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-execution-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = new ResourceLedger({ cpu_millis: 4_000, memory_bytes: 8 * GIB, container_slots: 4, build_slots: 1 });
  let observed: RunEvalOptions | undefined;
  const scheduler = new EvalScheduler({
    root,
    resources: ledger,
    trialResources: TRIAL,
    executor: async (options) => {
      observed = options;
      return fakeEvalExecutor(1)(options);
    },
  });
  await scheduler.initialize();
  t.after(() => scheduler.shutdown());
  const custom = { cpu_millis: 1_000, memory_bytes: GIB, container_slots: 1, build_slots: 0 };
  const execution = {
    provider: "local-docker",
    max_parallelism: 3,
    resources: { default_trial: custom },
    build: { mode: "backend" },
    model_capture: { mode: "native", required: false },
  };
  const evalId = await scheduler.submit({ schema_version: "1", request: request(4), execution, idempotency_key: "policy-one" });
  await waitFor(() => scheduler.status(evalId).then((status) => status?.result !== null));
  assert.equal(observed?.maxConcurrentOverride, 3);
  assert.deepEqual(observed?.executionResources, custom);
  assert.equal(observed?.executionResourceSource, "submission-default");
  assert.equal(observed?.executionWorker?.provider, "local-docker");
  const submission = await readJSON<Record<string, unknown>>(path.join(root, "evals", evalId, "submission.json"));
  assert.deepEqual(submission.execution, execution);
  assert.equal(submission.submission_digest, sha256JSON({ request: await readJSON(path.join(root, "evals", evalId, "request.json")), execution }));
  assert.equal((await scheduler.status(evalId))?.control.requested_parallelism, 3);
  assert.deepEqual((await scheduler.status(evalId))?.execution, execution);
  const same = await scheduler.submit({ request: request(4), execution, idempotency_key: "policy-one" });
  assert.equal(same, evalId);
  await assert.rejects(
    scheduler.submit({ request: request(4), execution: { ...execution, max_parallelism: 2 }, idempotency_key: "policy-one" }),
    (error: unknown) => (error as { code?: string }).code === "idempotency_conflict",
  );
  await assert.rejects(
    scheduler.submit({ request: request(1), execution: { ...execution, provider: "remote", max_parallelism: 1 } }),
    (error: unknown) => (error as { code?: string }).code === "execution_provider_unavailable",
  );
});

test("queued eval recovery preserves its pinned execution policy", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-policy-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evalId = "eval_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const directory = path.join(root, "evals", evalId);
  await mkdir(directory, { recursive: true });
  const normalized = await validateEvalRequest(request(4));
  const execution = {
    provider: "local-docker",
    max_parallelism: 1,
    resources: { default_trial: { cpu_millis: 1_000, memory_bytes: GIB, container_slots: 1, build_slots: 0 } },
    build: { mode: "backend" as const },
    model_capture: { mode: "native" as const, required: false },
  };
  const now = new Date().toISOString();
  await atomicWriteJSON(path.join(directory, "request.json"), normalized);
  await atomicWriteJSON(path.join(directory, "submission.json"), {
    schema_version: "1", eval_id: evalId, request: normalized, execution,
    submission_digest: sha256JSON({ request: normalized, execution }), submitted_at: now,
  });
  await atomicWriteJSON(path.join(directory, "control.json"), {
    schema_version: "1", eval_id: evalId, generation: 0, state: "queued",
    requested_parallelism: 1, admitted_parallelism: 0, active_leases: [], queued_work_items: [], terminal_work_items: [],
    created_at: now, updated_at: now,
  });
  let observed: RunEvalOptions | undefined;
  const scheduler = new EvalScheduler({
    root,
    resources: new ResourceLedger({ cpu_millis: 4_000, memory_bytes: 8 * GIB, container_slots: 4, build_slots: 1 }),
    trialResources: TRIAL,
    executor: async (options) => { observed = options; return fakeEvalExecutor(1)(options); },
  });
  await scheduler.initialize();
  t.after(() => scheduler.shutdown());
  await waitFor(() => scheduler.status(evalId).then((status) => status?.result !== null));
  assert.equal(observed?.maxConcurrentOverride, 1);
  assert.deepEqual(observed?.executionResources, execution.resources.default_trial);
  assert.deepEqual((await scheduler.status(evalId))?.execution, execution);
});

test("local evals dispatch work items fairly across evals without exceeding the shared vector ledger", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-work-dispatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataset = path.join(root, "dataset");
  for (const taskId of ["a", "b", "c", "d"]) {
    await mkdir(path.join(dataset, taskId), { recursive: true });
    await writeFile(path.join(dataset, taskId, "task.toml"), "", "utf8");
  }
  const ledger = new ResourceLedger({ cpu_millis: 4_000, memory_bytes: 8 * GIB, container_slots: 2, build_slots: 1 });
  const order: string[] = [];
  let releaseLarge!: () => void;
  let largeReady!: () => void;
  const largeGate = new Promise<void>((resolve) => { releaseLarge = resolve; });
  const ready = new Promise<void>((resolve) => { largeReady = resolve; });
  const executor = async (options: RunEvalOptions): Promise<EvalResult> => {
    const admission = options.workItemAdmission;
    if (!admission || !options.evalId) throw new Error("fine-grained work admission was not provided");
    const acquire = async (taskId: string) => {
      const permit = await admission.acquire({
        evalId: options.evalId as never,
        workItem: workItem(options.evalId as string, taskId),
        maxParallelism: options.request.model === "large" ? 2 : 1,
      });
      order.push(`${options.request.model}-${taskId}`);
      assert.ok(ledger.snapshot().allocated.container_slots <= 2);
      return permit;
    };
    if (options.request.model === "large") {
      const first = await acquire("a");
      const second = await acquire("b");
      const thirdPromise = acquire("c");
      largeReady();
      await largeGate;
      first.release();
      const third = await thirdPromise;
      second.release();
      third.release();
    } else {
      const permit = await acquire("d");
      permit.release();
    }
    const now = new Date().toISOString();
    return { schema_version: "1", eval_id: options.evalId as never, status: "succeeded", exit_code: 0, started_at: now, completed_at: now };
  };
  const scheduler = new EvalScheduler({ root, resources: ledger, trialResources: TRIAL, executor });
  await scheduler.initialize();
  t.after(() => scheduler.shutdown());

  const large = await scheduler.submit({ ...request(2), dataset, model: "large" });
  await ready;
  const small = await scheduler.submit({ ...request(1), dataset, model: "small" });
  await waitFor(() => scheduler.status(small).then((status) => status?.control.state === "planning"));
  releaseLarge();
  await waitFor(() => scheduler.status(large).then((status) => status?.result !== null));
  await waitFor(() => scheduler.status(small).then((status) => status?.result !== null));
  assert.deepEqual(order, ["large-a", "large-b", "small-d", "large-c"]);
  assert.deepEqual(ledger.snapshot().allocated, { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 });
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
    active_leases: [],
    queued_work_items: [],
    terminal_work_items: [],
    allocation_id: "allocation_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    created_at: now,
    updated_at: now,
  } satisfies EvalControlV1);
  const interruptedLease = await createExecutionLease({
    evalDirectory: directory,
    evalId,
    workId: "work_cccccccccccccccccccccccccccccccc",
    worker: {
      workerId: "worker_test",
      provider: "local-docker",
      collisionDomainId: "docker:test",
      parentAllocationId: "allocation_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    reservation: TRIAL,
    ttlMs: 60_000,
  });
  await interruptedLease.markRunning();

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
  assert.equal((await readExecutionLeases(directory))[0]?.state, "lost");
});

test("eval scheduler reattaches a live local Harbor process and does not rerun the candidate", async (t) => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-live-recovery-"));
  t.after(() => forceRemove(root));
  const dataset = path.join(root, "dataset");
  await mkdir(path.join(dataset, "one"), { recursive: true });
  await writeFile(path.join(dataset, "one", "task.toml"), "name = \"one\"\n");
  const activityLog = path.join(root, "activity.jsonl");
  const harbor = await writeFakeHarbor(root, { delayMs: 1_000, activityLog });
  const npm = await writeFakeNpm(root);
  const child = spawn(process.execPath, [
    path.join(import.meta.dirname, "..", "test-support", "recovery-scheduler-child.js"),
    root,
    harbor,
    npm,
    dataset,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const evalId = await childEvalId(child);
  const evalDirectory = path.join(root, "evals", evalId);
  await waitFor(async () => {
    try { return (await readdir(path.join(evalDirectory, "provider", "leases"))).length === 1; } catch { return false; }
  }, 10_000);
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("close", () => resolve()));

  const scheduler = new EvalScheduler({
    root,
    resources: new ResourceLedger({ cpu_millis: 1_000, memory_bytes: GIB, container_slots: 1, build_slots: 1 }),
    trialResources: { cpu_millis: 1_000, memory_bytes: GIB, container_slots: 1, build_slots: 0 },
    executor: (options) => runEval({
      ...options,
      harborExecutable: harbor,
      env: { ...process.env, HITCH_NPM_PATH: npm },
      trialBundleGraceMs: 0,
    }),
  });
  await scheduler.initialize();
  t.after(() => scheduler.shutdown());
  await waitFor(() => scheduler.status(evalId).then((status) => status?.result !== null), 10_000);
  const status = await scheduler.status(evalId);
  assert.ok(status?.result);
  assert.notEqual((status.result.error as { code?: string } | undefined)?.code, "execution_state_ambiguous", JSON.stringify(status.result));
  await waitFor(async () => readFile(activityLog, "utf8").then(() => true).catch(() => false), 1_000);
  const activity = (await readFile(activityLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
  assert.equal(activity.filter((entry) => entry.type === "start").length, 1);
  const leases = await readExecutionLeases(evalDirectory);
  assert.equal(leases.length, 1);
  assert.equal(leases[0]?.state, "released");
  assert.equal(leases[0]?.epoch, 2);
  assert.deepEqual(status.control.active_leases, []);
  assert.deepEqual(status.control.queued_work_items, []);
  assert.equal(status.control.terminal_work_items.length, 1);
  const events = await readFile(path.join(evalDirectory, "events.jsonl"), "utf8");
  assert.match(events, /"type":"eval\.lease\.reissued"/);
  assert.match(events, /"type":"eval\.work-item\.recovered"/);
});

test("daemon exposes queued eval status and terminal result", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-daemon-eval-"));
  const imageContext = path.join(root, "image-context");
  await mkdir(imageContext, { recursive: true });
  await writeFile(path.join(imageContext, "Dockerfile"), "FROM scratch\n");
  const images = new EnvironmentImageService({
    root,
    builder: {
      id: "daemon-build-test",
      probe: async () => true,
      build: async (input) => ({
        reference: input.outputReference,
        manifest_digest: sha256JSON({ cache: input.cacheKey, kind: "manifest" }),
        config_digest: sha256JSON({ cache: input.cacheKey, kind: "config" }),
        platform: input.platform,
      }),
    },
  });
  const built = await images.build({ benchmarkId: "demo", benchmarkRevision: "1", contextDirectory: imageContext, platform: "linux/amd64" });
  const buildId = `build_${built.manifest.build.cache_key.slice("sha256:".length, "sha256:".length + 32)}`;
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
  const workers = await client.request("/v1/workers");
  const worker = (workers.workers as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  assert.equal(worker.provider, "local-docker");
  assert.equal((worker.capacity as { total: { container_slots: number } }).total.container_slots, 1);
  const build = await client.request(`/v1/builds/${buildId}`);
  assert.equal((build.record as { state: string }).state, "succeeded");
  assert.equal((build.manifest as { image_id: Sha256 }).image_id, built.manifest.image_id);
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
  const bodyKey = await client.request("/v1/evals", {
    method: "POST",
    body: JSON.stringify({ request: request(1), idempotency_key: "body-key" }),
  });
  const repeatedBodyKey = await client.request("/v1/evals", {
    method: "POST",
    body: JSON.stringify({ request: request(1), idempotency_key: "body-key" }),
    headers: { "idempotency-key": "body-key" },
  });
  assert.equal(repeatedBodyKey.eval_id, bodyKey.eval_id);
  await assert.rejects(
    client.request("/v1/evals", {
      method: "POST",
      body: JSON.stringify({ request: request(1), idempotency_key: "body-key" }),
      headers: { "idempotency-key": "different-key" },
    }),
    (error: unknown) => (error as { status?: number; code?: string }).status === 400
      && (error as { code?: string }).code === "invalid_input",
  );
});

async function waitFor(predicate: () => Promise<boolean>, attempts = 200): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error("timed out waiting for control-plane state");
}

function childEvalId(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const line = stdout.split("\n")[0];
      if (!line) return;
      try {
        const value = JSON.parse(line) as { eval_id?: unknown };
        if (typeof value.eval_id === "string") resolve(value.eval_id);
      } catch { /* wait for a complete line */ }
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_192); });
    child.once("close", (code, signal) => reject(new Error(`recovery fixture exited before submission: ${code ?? signal}: ${stderr}`)));
  });
}

async function waitForStatus(client: Awaited<ReturnType<typeof daemonClient>>, evalId: string): Promise<{ control: Record<string, unknown>; result: Record<string, unknown> }> {
  for (let index = 0; index < 200; index += 1) {
    const status = await client.request(`/v1/evals/${evalId}`);
    if (status.result) return status as { control: Record<string, unknown>; result: Record<string, unknown> };
    await delay(10);
  }
  throw new Error("timed out waiting for daemon eval result");
}

function workItem(evalId: string, taskId: string): BackendWorkItemV1 {
  return {
    schema_version: "1",
    work_id: `work_${sha256JSON({ eval_id: evalId, task_id: taskId }).slice("sha256:".length, "sha256:".length + 32)}`,
    eval_id: evalId,
    backend: "harbor",
    logical_attempt: 1,
    task_ids: [taskId],
    slots: [],
    opaque_membership: false,
    requested_parallelism: 1,
    reservation: TRIAL,
    provider: "local-docker",
  };
}
