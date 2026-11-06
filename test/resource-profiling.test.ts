import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { EvalRequest, EvalResourceProfilingV1, WorkResourceProfilingV1 } from "../src/domain/index.js";
import { buildEvalExecutionPlan, deriveTaskResourceRequirement, parseEvalExecutionPlan, runEval, validateEvalId } from "../src/evals/index.js";
import { taskHasUnknownResourceSize } from "../src/evals/resource-profiling-plan.js";
import { acquireProcessResourceProfiling, processWorkItemAdmission } from "../src/evals/process-resource-profiling.js";
import { planEvalResourceProfiling } from "../src/evals/eval-resource-profiling.js";
import { CollisionLockManager, EvalScheduler, ResourceLedger, WorkItemDispatcher } from "../src/control-plane/index.js";
import { atomicWriteJSON, delay, resourceProfilingPolicy } from "../src/foundation/index.js";
import { schedulerQueuedEval } from "../src/control-plane/scheduler-eval-entry.js";
import { forceRemove, prepareHostHarborArtifactForTest, writeFakeNpm } from "../test-support/helpers.js";
import { writeResourceInspector } from "../test-support/remote-harbor-model.js";

const unit = { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
const capacity = { cpu_millis: 8000, memory_bytes: 8 * 1024 ** 3, container_slots: 8, build_slots: 0 };
const request: EvalRequest = { schema_version: "1", backend: "harbor", dataset: "demo@1", harness_ref: "pi@version:1", model: "test/model", attempts: 1,
  max_concurrent: 4, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0, timeout_ms: 0, setup_timeout_ms: 0, agent_args: [], pass_env: [], benchmark_id: "demo", benchmark_revision: "1" };
const policy: EvalResourceProfilingV1 = { schema_version: "1", unknown_max_parallelism: 1, requested_parallelism: 4, scope: "worker", approvals: [] };
const profile: WorkResourceProfilingV1 = { schema_version: "1", unknown: true, unknown_max_parallelism: 1, unknown_slots: 1, reason: "missing-resource-size", approval_digests: [] };
function resources(taskId: string, explicit: boolean, sidecar = false) {
  return deriveTaskResourceRequirement({ taskId, defaultResources: unit, defaultSource: "operator-default", declaration: {
    schema_version: "1", task: explicit ? { cpu_millis: 1000, memory_bytes: 1024 ** 3 } : {}, verifier: { separate: false },
    compose_services: [{ name: "main", replicas: 1 }, ...(sidecar ? [{ name: "simulator", replicas: 1, cpu_millis: 1000 }] : [])],
    provider_sidecars: { main_egress: true, verifier_egress: false }, environment_images: [], environment_image_fallbacks: [], environment_builds: [],
  } });
}
function plan(explicit = false, profiling: EvalResourceProfilingV1 | null = policy, mode: "task-slots" | "attempt-shards" = "task-slots") {
  return buildEvalExecutionPlan({ evalId: validateEvalId(`eval_${"a".repeat(32)}`), request, tasks: ["one", "two"], maxParallelism: 4,
    candidate: { revisionIdentity: `sha256:${"b".repeat(64)}`, artifactId: `sha256:${"c".repeat(64)}` },
    taskResources: [resources("one", explicit), resources("two", explicit)], workItemMode: mode,
    ...(profiling ? { resourceProfiling: profiling } : {}), createdAt: "2026-10-21T00:00:00.000Z" });
}

test("unknown sizing detects missing CPU or memory while excluding fixed provider overhead", () => {
  assert.equal(taskHasUnknownResourceSize(resources("known", true)), false);
  assert.equal(taskHasUnknownResourceSize(resources("unknown", false)), true);
  assert.equal(taskHasUnknownResourceSize(resources("partial-sidecar", true, true)), true);
  assert.equal(resources("default", false).main_limits.memory_bytes, 1024 ** 3);
  assert.equal(resources("default", false).components[0]!.fields.memory_bytes.estimated, true);
});

test("unknown policy is validated and operator/environment choices never resize limits", () => {
  assert.deepEqual(resourceProfilingPolicy(undefined, {}), { unknown_max_parallelism: 1 });
  assert.equal(resourceProfilingPolicy(undefined, { HITCH_RESOURCE_PROFILING_UNKNOWN_MAX_PARALLELISM: "3" }).unknown_max_parallelism, 3);
  assert.equal(resourceProfilingPolicy({ unknown_max_parallelism: 2 }, { HITCH_RESOURCE_PROFILING_UNKNOWN_MAX_PARALLELISM: "3" }).unknown_max_parallelism, 2);
  for (const value of [0, -1, 1.1, "1.0", "", 10001, null]) assert.throws(() => resourceProfilingPolicy({ unknown_max_parallelism: value }, {}));
  assert.deepEqual(plan(false).task_resources, plan(false, null).task_resources);
});

test("new shard plans cap unknown work, preserve explicit parallelism and bind profiling identity", async () => {
  const unknown = plan(false, policy, "attempt-shards");
  const explicit = plan(true, policy, "attempt-shards");
  assert.equal(unknown.work_items[0]!.requested_parallelism, 1);
  assert.equal(explicit.work_items[0]!.requested_parallelism, 2);
  assert.equal(explicit.work_items[0]!.resource_profiling!.unknown, false);
  assert.equal(unknown.resource_profiling!.requested_parallelism, 4);
  assert.deepEqual(parseEvalExecutionPlan(unknown), unknown);
  const schema = JSON.parse(await readFile("docs/schemas/eval-execution-plan.schema.json", "utf8"));
  const ajv = new Ajv2020({ strict: false });
  ajv.addSchema(JSON.parse(await readFile("docs/schemas/training-external-binding.schema.json", "utf8")));
  ajv.addSchema(JSON.parse(await readFile("docs/schemas/external-endpoint-binding.schema.json", "utf8")));
  const validate = ajv.compile(schema);
  assert.equal(validate(unknown), true, JSON.stringify(validate.errors));
  const tampered = structuredClone(unknown); tampered.work_items[0]!.resource_profiling!.unknown = false;
  assert.throws(() => parseEvalExecutionPlan(tampered));
});

test("unknown shard execution and infrastructure retries use the frozen concurrency cap", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-unknown-shard-retry-"));
  t.after(() => forceRemove(root));
  const dataset = path.join(root, "dataset");
  for (const task of ["one", "two"]) {
    await mkdir(path.join(dataset, task), { recursive: true });
    await writeFile(path.join(dataset, task, "task.toml"), "");
  }
  const npm = await writeFakeNpm(root), inspector = await writeResourceInspector(root);
  const configurations = path.join(root, "harbor-configurations.jsonl");
  const harbor = path.join(root, "fake-shard-harbor");
  await writeFile(harbor, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("harbor 0.21.0\\n"); process.exit(0); }
const config = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"));
const log = ${JSON.stringify(configurations)};
const invocation = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\\n").length + 1 : 1;
fs.appendFileSync(log, JSON.stringify(config) + "\\n");
const output = path.join(config.jobs_dir, config.job_name);
const tasks = config.datasets[0].task_names || ["one", "two"];
for (const task of tasks) {
  const trial = task + "__infra-" + invocation, directory = path.join(output, trial);
  fs.mkdirSync(directory, {recursive:true});
  fs.writeFileSync(path.join(directory, "lock.json"), JSON.stringify({task:{name:task}}));
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({task_name:task, trial_name:trial,
    exception_info:{exception_type:"EnvironmentStartTimeoutError", exception_message:"Environment start timed out"},
    agent_execution:null, verifier:null}));
}
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({n_total_trials:tasks.length,
  stats:{n_completed_trials:0,n_errored_trials:tasks.length,n_cancelled_trials:0}}));
`, { mode: 0o755 });
  const result = await runEval({ root, harborExecutable: harbor, harborArtifactBuilder: prepareHostHarborArtifactForTest,
    executionStrategy: "legacy-attempt-shards", trialBundleGraceMs: 0, resourceProfilingPolicy: { unknown_max_parallelism: 1 },
    env: { ...process.env, HITCH_NPM_PATH: npm, HITCH_HARBOR_PYTHON_PATH: inspector },
    request: { dataset, harness_ref: "pi@version:1.2.3", max_concurrent: 4,
      infrastructure_retries: 1, infrastructure_retry_backoff_ms: 0 } });
  assert.equal(result.status, "failed");
  const evalDirectory = path.join(root, "evals", String(result.eval_id));
  const executionPlan = parseEvalExecutionPlan(JSON.parse(await readFile(path.join(evalDirectory, "execution-plan.json"), "utf8")));
  assert.equal(executionPlan.work_items.length, 1, "fixture must exercise the shard backend path");
  const work = executionPlan.work_items[0]!;
  assert.equal(work.requested_parallelism, 1);
  assert.equal(work.resource_profiling?.unknown_slots, 1);
  assert.deepEqual(work.task_ids, ["one", "two"]);
  const invocations = (await readFile(configurations, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(invocations.length, 2, "both the initial shard and its physical retry must execute");
  assert.deepEqual(invocations.map(config => config.n_concurrent_trials), [1, 1],
    "Harbor must never receive more concurrency than the frozen unknown reservation");
  assert.deepEqual(invocations[1].datasets[0].task_names, ["one", "two"], "both failures must enter the capped retry");
});

test("legacy plans keep their bytes and resume never imports the current policy", async () => {
  const old = buildEvalExecutionPlan({ evalId: validateEvalId(`eval_${"a".repeat(32)}`), request, tasks: null, maxParallelism: 4,
    candidate: { revisionIdentity: `sha256:${"b".repeat(64)}`, artifactId: `sha256:${"c".repeat(64)}` } });
  assert.equal(old.work_items[0]!.requested_parallelism, 4);
  assert.equal(JSON.stringify(parseEvalExecutionPlan(old)), JSON.stringify(old));
  const resumed = await planEvalResourceProfiling({ root: "/nonexistent", evalDirectory: "/nonexistent", request, preparedAssignments: [],
    controllerRuntime: { runtime_id: `sha256:${"c".repeat(64)}` }, environmentImages: [], provider: "local-docker",
    resumePlan: old, policy: { unknown_max_parallelism: 2 }, scope: "process", requestedParallelism: 4 });
  assert.equal(resumed, undefined);
});

test("worker-wide unknown slots and ordinary resource admission must both fit", async () => {
  const ledger = new ResourceLedger(capacity), collisions = new CollisionLockManager();
  let collisionReleases = 0;
  const unsubscribe = collisions.subscribe(() => { collisionReleases++; });
  const dispatcher = new WorkItemDispatcher({ resources: ledger, collisions });
  const work = (id: string, unknown = true) => ({ evalId: `eval_${id.repeat(32)}`, workId: `work_${id.repeat(32)}`, maxParallelism: 4, reservation: unit,
    collisionKeys: [id], ...(unknown ? { resourceProfiling: profile } : {}) });
  const first = await dispatcher.acquire(work("a"));
  let secondStarted = false;
  const second = dispatcher.acquire(work("b")).then(permit => { secondStarted = true; return permit; });
  const explicit = await dispatcher.acquire(work("c", false));
  await delay(5); assert.equal(secondStarted, false);
  assert.equal(collisionReleases, 0, "capacity waiters must not trigger shared scheduler collision notifications");
  assert.equal(ledger.snapshot().resource_profiling.active_unknown_slots, 1);
  assert.equal(ledger.snapshot().allocated.container_slots, 2);
  explicit.release(); await delay(5); assert.equal(secondStarted, false);
  first.release(); const next = await second; next.release();
  assert.equal(ledger.snapshot().resource_profiling.active_unknown_slots, 0);
  dispatcher.close(); unsubscribe();
  const constrained = new ResourceLedger(unit, { unknown_max_parallelism: 4 });
  const lease = constrained.tryAcquire("one", "eval", unit, { ...profile, unknown_max_parallelism: 4 });
  assert.ok(lease); assert.equal(constrained.tryAcquire("two", "eval", unit, { ...profile, unknown_max_parallelism: 4 }), null); lease.release();
});

test("unknown budget honors tighter active frozen limits and rejects impossible requests", () => {
  const ledger = new ResourceLedger(capacity, { unknown_max_parallelism: 3 });
  assert.equal(ledger.canAcquire(unit, profile), true);
  const first = ledger.tryAcquire("a", "eval", unit, profile)!;
  assert.equal(ledger.canAcquire(unit, { ...profile, unknown_max_parallelism: 3 }), false);
  assert.equal(ledger.canAcquire(unit), true, "known work remains eligible while the unknown cap is full");
  assert.equal(ledger.tryAcquire("b", "eval", unit, { ...profile, unknown_max_parallelism: 3 }), null);
  first.release();
  const high = { ...profile, unknown_max_parallelism: 3 };
  assert.equal(ledger.canAcquire(unit, high), true);
  const second = ledger.tryAcquire("b", "eval", unit, high)!;
  const third = ledger.tryAcquire("c", "eval", unit, high)!;
  assert.equal(ledger.canAcquire(unit, profile), false, "a tighter incoming frozen cap also applies");
  assert.equal(ledger.tryAcquire("d", "eval", unit, profile), null);
  assert.equal(ledger.canEverFit(unit, { ...profile, unknown_max_parallelism: 4, unknown_slots: 4 }), false);
  second.release(); third.release();
});

test("opaque evals waiting for unknown capacity keep the event loop responsive and start after cancellation", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-unknown-eval-admission-"));
  const ledger = new ResourceLedger(capacity), started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scheduler = new EvalScheduler({ root, resources: ledger, trialResources: unit, executor: async options => {
    started.push(options.evalId!);
    if (!options.signal?.aborted) await Promise.race([gate,
      new Promise<void>(resolve => options.signal?.addEventListener("abort", () => resolve(), { once: true }))]);
    return { schema_version: "1", eval_id: options.evalId!, status: options.signal?.aborted ? "cancelled" : "succeeded", exit_code: options.signal?.aborted ? 9 : 0,
      started_at: new Date().toISOString(), completed_at: new Date().toISOString() };
  } });
  t.after(async () => { release(); await scheduler.shutdown(); await forceRemove(root); });
  await scheduler.initialize();
  const input = { harness_ref: "pi@version:1.2.3", max_concurrent: 1 };
  const first = await scheduler.submit({ ...input, dataset: "first@1.0" });
  for (let i = 0; i < 100 && started.length < 1; i++) await delay(5);
  assert.deepEqual(started, [first]);
  const second = await scheduler.submit({ ...input, dataset: "second@1.0" });
  await delay(10); // Collision rollback must not create a microtask loop that starves timers or cancellation.
  assert.deepEqual(started, [first]);
  assert.equal((await scheduler.status(second))?.control.state, "queued");
  assert.equal(ledger.snapshot().resource_profiling.active_unknown_slots, 1);
  assert.equal(await scheduler.cancel(first), "accepted");
  for (let i = 0; i < 100 && started.length < 2; i++) await delay(5);
  assert.deepEqual(started, [first, second]);
  assert.equal(ledger.snapshot().resource_profiling.active_unknown_slots, 1);
  release();
  for (let i = 0; i < 100 && !(await scheduler.status(second))?.result; i++) await delay(5);
  assert.equal((await scheduler.status(second))?.result?.status, "succeeded");
});

test("direct evals and independent reruns share a process cap; cancelled waiters do not leak", async () => {
  const first = processWorkItemAdmission(4);
  const second = processWorkItemAdmission(4);
  const work = plan().work_items[0]!;
  const args = { evalId: validateEvalId(work.eval_id), workItem: work, maxParallelism: 4 };
  const permit = await first.acquire(args);
  assert.match(permit.allocationId, /^allocation_[a-f0-9]{32}$/);
  const abort = new AbortController();
  const cancelled = second.acquire({ ...args, signal: abort.signal });
  abort.abort(); await assert.rejects(cancelled, /cancelled/);
  let admitted = false;
  const waiting = acquireProcessResourceProfiling(profile).then(release => { admitted = true; return release; });
  await delay(5); assert.equal(admitted, false);
  permit.release(); (await waiting)();
  (await second.acquire(args)).release();
});

test("scheduler resume uses frozen membership and rejects an impossible frozen unknown shard", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-profiling-resume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const frozen = plan();
  const input = { evalId: validateEvalId(frozen.eval_id), request: { ...request, dataset: path.join(directory, "deleted-dataset") },
    execution: { provider: "local-docker", max_parallelism: 4, resources: { default_trial: unit }, build: { mode: "backend" as const },
      model_capture: { mode: "native" as const, required: false } }, directory, collisionDomainId: "local", resumeExisting: true };
  await atomicWriteJSON(path.join(directory, "execution-plan.json"), frozen);
  assert.equal((await schedulerQueuedEval(input)).fineGrained, true);
  const opaque = (max: number) => buildEvalExecutionPlan({ evalId: input.evalId, request, tasks: null, maxParallelism: max,
    resourceProfiling: { ...policy, unknown_max_parallelism: 3 },
    candidate: { revisionIdentity: `sha256:${"b".repeat(64)}`, artifactId: `sha256:${"c".repeat(64)}` } });
  await atomicWriteJSON(path.join(directory, "execution-plan.json"), opaque(1));
  const resumed = await schedulerQueuedEval({ ...input, unknownMaxParallelism: 1 });
  assert.equal(resumed.coarseParallelism, 1);
  assert.equal(resumed.coarseProfiling!.unknown_max_parallelism, 3);
  await atomicWriteJSON(path.join(directory, "execution-plan.json"), opaque(2));
  await assert.rejects(schedulerQueuedEval({ ...input, unknownMaxParallelism: 1 }), /frozen unknown work exceeds/);
});
