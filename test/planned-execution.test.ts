import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResourceLedger, WorkItemDispatcher } from "../src/control-plane/index.js";
import { localEnvironmentImageBuild } from "../src/control-plane/eval-image-resolution.js";
import { parseEvalExecutionPlan, readEvalRetryState, readExecutionLeases, runEval as runEvalProduction } from "../src/evals/index.js";
import type { RunEvalOptions } from "../src/evals/index.js";
import { hitchRootId, readEvalEnvironmentImageReferences, readJSON } from "../src/foundation/index.js";
import { loadEnvironmentImageManifest } from "../src/images/index.js";
import type { EnvironmentImageBuilder } from "../src/images/index.js";
import { forceRemove, prepareHostHarborArtifactForTest, writeFakeHarbor, writeFakeNpm } from "../test-support/helpers.js";

const runEval = (options: RunEvalOptions) => runEvalProduction({ ...options, harborArtifactBuilder: prepareHostHarborArtifactForTest });

test("planned local execution overlaps different tasks and serializes attempts of the same task", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-planned-execution-"));
  t.after(() => forceRemove(root));
  const dataset = path.join(root, "dataset");
  for (const task of ["one", "two"]) {
    const directory = path.join(dataset, task);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "task.toml"), `name = ${JSON.stringify(task)}\n`);
  }
  const activityLog = path.join(root, "harbor-activity.jsonl");
  const harbor = await writeFakeHarbor(root, { delayMs: 150, activityLog });
  const npm = await writeFakeNpm(root);
  const resources = new ResourceLedger({ cpu_millis: 4_000, memory_bytes: 4 * 1024 * 1024 * 1024, container_slots: 2, build_slots: 1 });
  const dispatcher = new WorkItemDispatcher({ resources });
  t.after(() => dispatcher.close());
  const reapedLeases: string[] = [];
  const request = {
    dataset,
    harness_ref: "pi@version:1.2.3",
    attempts: 2,
    max_concurrent: 2,
    infrastructure_retries: 0,
  };
  const result = await runEval({
    root,
    harborExecutable: harbor,
    executionStrategy: "local-task-slots-v1",
    executionResources: { cpu_millis: 2_000, memory_bytes: 2 * 1024 * 1024 * 1024, container_slots: 1, build_slots: 0 },
    executionResourceSource: "submission-default",
    trialBundleGraceMs: 0,
    env: { ...process.env, HITCH_NPM_PATH: npm },
    dockerResourceReaper: async (input) => {
      reapedLeases.push(...(input.leaseIds ?? []));
      return { schema_version: "1", root_id: hitchRootId(root), scanned: 0, deleted: [], retained: [], issues: [] };
    },
    workItemAdmission: {
      acquire: async ({ evalId, workItem, maxParallelism, signal }) => {
        const permit = await dispatcher.acquire({
          evalId,
          workId: workItem.work_id,
          maxParallelism,
          reservation: workItem.reservation,
          collisionKeys: workItem.task_ids.map((taskId) => `test-task:${taskId}`),
          ...(signal ? { signal } : {}),
        });
        return { allocationId: permit.allocation.allocation_id, collisionKeys: permit.collision_keys, release: permit.release };
      },
    },
    request,
  });

  assert.equal((result.trials as unknown[]).length, 4);
  const evalDirectory = path.join(root, "evals", result.eval_id);
  const compatibilityPlan = await readJSON<Record<string, unknown>>(path.join(evalDirectory, "plan.json"));
  assert.equal(compatibilityPlan.attempt_execution, "harbor-task-slots-v1");
  const plan = parseEvalExecutionPlan(await readJSON<unknown>(path.join(evalDirectory, "execution-plan.json")));
  assert.equal(plan.membership, "known");
  assert.equal(plan.work_items.length, 4);
  assert.ok(plan.task_resources?.every((entry) => entry.components[0]?.fields.cpu_millis.source === "submission-default"));
  const leases = await readExecutionLeases(evalDirectory);
  assert.equal(leases.length, 4);
  assert.ok(leases.every((lease) => lease.state === "released" && lease.terminal_at && lease.parent_allocation_id));
  assert.deepEqual(new Set(leases.map((lease) => lease.work_id)), new Set(plan.work_items.map((item) => item.work_id)));
  assert.deepEqual(new Set(reapedLeases), new Set(leases.map((lease) => lease.lease_id)));
  for (const trial of result.trials as Array<{ run_id: string; task_id: string }>) {
    const execution = await readJSON<Record<string, unknown>>(path.join(root, "runs", trial.run_id, "execution.json"));
    assert.equal(execution.provider, "local-docker");
    assert.equal(execution.task_id, trial.task_id);
    assert.equal((execution.observed as Record<string, unknown>).status, "unavailable");
  }
  for (const item of plan.work_items) {
    const lease = leases.find((entry) => entry.work_id === item.work_id) as typeof leases[number];
    const config = await readJSON<Record<string, unknown>>(path.join(evalDirectory, "harbor", "work-items", item.work_id, "epoch-000001", "job.json"));
    const datasets = config.datasets as Array<Record<string, unknown>>;
    assert.equal(config.n_attempts, 1);
    assert.equal(config.n_concurrent_trials, 1);
    assert.deepEqual(config.environment, {
      type: "docker", delete: false,
      cpu_enforcement_policy: "limit", override_cpus: 2,
      memory_enforcement_policy: "limit", override_memory_mb: 2_048,
      import_path: "hitch_harbor_environment:HitchHarborDockerEnvironment",
      kwargs: { hitch_ownership_labels: {
        "io.hitch.root-id": hitchRootId(root),
        "io.hitch.provider": "local-docker",
        "io.hitch.eval-id": result.eval_id,
        "io.hitch.work-id": item.work_id,
        "io.hitch.lease-id": lease.lease_id,
        "io.hitch.lease-epoch": "1",
        "io.hitch.task-id": item.task_ids[0],
      } },
    });
    assert.deepEqual(datasets[0]?.task_names, item.task_ids);
  }
  const providerRecords = await Promise.all(leases.map((lease) => readJSON<Record<string, unknown>>(
    path.join(evalDirectory, "provider", "leases", `${lease.lease_id}.json`),
  )));
  assert.ok(providerRecords.every((record) => record.state === "released" && record.lease_epoch === 1));
  assert.ok(providerRecords.every((record) => String(record.backend_directory).includes(`/epoch-000001`)));
  const eventTypes = new Set((await readFile(path.join(evalDirectory, "events.jsonl"), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { type: string }).type));
  for (const type of [
    "eval.planning.started", "eval.plan.created", "eval.work.queued", "eval.work.leased", "eval.work.started",
    "eval.work.completed", "eval.finalizing", "lease.offered", "lease.accepted", "lease.released",
    "sandbox.cleanup.started", "sandbox.cleanup.completed", "result.bundle.sealed",
  ]) assert.ok(eventTypes.has(type), `missing lifecycle event ${type}`);

  const activity = (await readFile(activityLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Activity);
  for (const task of ["one", "two"]) {
    const firstEnd = event(activity, "end", task, 1).time;
    const secondStart = event(activity, "start", task, 2).time;
    assert.ok(secondStart >= firstEnd, `${task} attempt 2 started before attempt 1 completed`);
  }
  const firstStarts = [event(activity, "start", "one", 1).time, event(activity, "start", "two", 1).time];
  const firstEnds = [event(activity, "end", "one", 1).time, event(activity, "end", "two", 1).time];
  assert.ok(Math.max(...firstStarts) < Math.min(...firstEnds), "different tasks did not overlap");
  assert.deepEqual(resources.snapshot().allocated, { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 });

  const activityBeforeResume = activity.length;
  await rm(path.join(evalDirectory, "result.json"));
  const resumed = await runEval({
    root,
    evalId: result.eval_id,
    request,
    precreated: true,
    resumeExisting: true,
    harborExecutable: harbor,
    executionStrategy: "local-task-slots-v1",
    executionResources: { cpu_millis: 2_000, memory_bytes: 2 * 1024 * 1024 * 1024, container_slots: 1, build_slots: 0 },
    executionResourceSource: "submission-default",
    trialBundleGraceMs: 0,
    env: { ...process.env, HITCH_NPM_PATH: npm },
  });
  assert.equal(resumed.status, result.status, JSON.stringify(resumed.error));
  assert.equal((await readFile(activityLog, "utf8")).trim().split("\n").length, activityBeforeResume);
  assert.equal((await readExecutionLeases(evalDirectory)).length, 4);
});

test("planned infrastructure retries reacquire admission and use a new owned lease", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-planned-physical-retry-"));
  t.after(() => forceRemove(root));
  const dataset = path.join(root, "dataset");
  await mkdir(path.join(dataset, "one"), { recursive: true });
  await writeFile(path.join(dataset, "one", "task.toml"), "name = \"one\"\n");
  const harbor = await writeInfrastructureFailureHarbor(root);
  const npm = await writeFakeNpm(root);
  const reservation = { cpu_millis: 1_000, memory_bytes: 1024 * 1024 * 1024, container_slots: 1, build_slots: 0 };
  const resources = new ResourceLedger({ ...reservation, build_slots: 1 });
  const dispatcher = new WorkItemDispatcher({ resources });
  t.after(() => dispatcher.close());
  const allocations: string[] = [];
  const reaped: string[] = [];
  const result = await runEval({
    root,
    harborExecutable: harbor,
    executionStrategy: "local-task-slots-v1",
    executionResources: reservation,
    executionResourceSource: "submission-default",
    trialBundleGraceMs: 0,
    env: { ...process.env, HITCH_NPM_PATH: npm },
    dockerResourceReaper: async (input) => {
      reaped.push(...(input.leaseIds ?? []));
      return { schema_version: "1", root_id: hitchRootId(root), scanned: 0, deleted: [], retained: [], issues: [] };
    },
    workItemAdmission: {
      acquire: async ({ evalId, workItem, maxParallelism, signal }) => {
        const permit = await dispatcher.acquire({
          evalId, workId: workItem.work_id, maxParallelism, reservation: workItem.reservation,
          collisionKeys: workItem.task_ids.map((taskId) => `test-task:${taskId}`),
          ...(signal ? { signal } : {}),
        });
        allocations.push(permit.allocation.allocation_id);
        return { allocationId: permit.allocation.allocation_id, collisionKeys: permit.collision_keys, release: permit.release };
      },
    },
    request: {
      dataset,
      harness_ref: "pi@version:1.2.3",
      attempts: 1,
      max_concurrent: 1,
      infrastructure_retries: 1,
      infrastructure_retry_backoff_ms: 0,
    },
  });

  assert.equal(result.status, "failed");
  const scheduler = result.scheduler_summary as Record<string, number | string>;
  assert.equal(scheduler.policy, "critical-path-lpt-v1");
  assert.ok((scheduler.makespan_ms as number) > 0);
  assert.ok((scheduler.physical_work_ms as number) >= (scheduler.initial_work_ms as number));
  assert.ok((scheduler.max_active as number) >= 1);
  assert.ok((scheduler.slot_utilization as number) > 0 && (scheduler.slot_utilization as number) <= 1);
  assert.ok((scheduler.effective_parallelism as number) > 0);
  const retries = result.infrastructure_retry_runs as Array<Record<string, unknown>>;
  assert.equal(retries.length, 1);
  assert.equal(retries[0]?.execution_kind, "physical-infrastructure-retry");
  assert.equal(typeof retries[0]?.lease_id, "string");
  assert.equal(typeof retries[0]?.work_id, "string");
  assert.equal(allocations.length, 2, "initial execution and physical retry must each be admitted");
  assert.equal(new Set(allocations).size, 2);
  const evalDirectory = path.join(root, "evals", result.eval_id as string);
  const plan = parseEvalExecutionPlan(await readJSON<unknown>(path.join(evalDirectory, "execution-plan.json")));
  const sourceWorkId = plan.work_items[0]?.work_id as string;
  const leases = await readExecutionLeases(evalDirectory);
  assert.equal(leases.length, 2);
  assert.equal(new Set(leases.map((lease) => lease.lease_id)).size, 2);
  assert.equal(new Set(leases.map((lease) => lease.work_id)).size, 2);
  assert.ok(leases.every((lease) => lease.state === "released" && lease.parent_allocation_id));
  assert.deepEqual(new Set(reaped), new Set(leases.map((lease) => lease.lease_id)));
  const retryLease = leases.find((lease) => lease.lease_id === retries[0]?.lease_id);
  assert.ok(retryLease);
  assert.equal(retryLease.work_id, retries[0]?.work_id);
  assert.notEqual(retryLease.work_id, sourceWorkId);
  const retryConfig = await readJSON<Record<string, unknown>>(path.join(
    evalDirectory,
    "harbor", "work-items", sourceWorkId, "infrastructure-retries", "retry-0001", "harbor", "job.json",
  ));
  const labels = ((retryConfig.environment as Record<string, unknown>).kwargs as Record<string, Record<string, string>>).hitch_ownership_labels;
  assert.ok(labels);
  assert.equal(labels["io.hitch.lease-id"], retryLease.lease_id);
  assert.equal(labels["io.hitch.work-id"], retryLease.work_id);
  const retryState = await readEvalRetryState(evalDirectory, result.eval_id as string);
  assert.equal(retryState?.decisions.length, 1);
  assert.equal(retryState?.decisions[0]?.retry_work_id, retryLease.work_id);
  assert.equal(retryState?.decisions[0]?.state, "exhausted");
  assert.deepEqual(resources.snapshot().allocated, { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 });
});

test("terminal provider failures open the retry-only circuit without physical retry", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-planned-provider-circuit-"));
  t.after(() => forceRemove(root));
  const dataset = path.join(root, "dataset");
  await mkdir(path.join(dataset, "one"), { recursive: true });
  await writeFile(path.join(dataset, "one", "task.toml"), "name = \"one\"\n");
  const harbor = await writeProviderQuotaFailureHarbor(root);
  const npm = await writeFakeNpm(root);
  const events: Array<Record<string, unknown>> = [];
  const result = await runEval({
    root, harborExecutable: harbor, executionStrategy: "local-task-slots-v1", trialBundleGraceMs: 0,
    env: { ...process.env, HITCH_NPM_PATH: npm },
    onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    request: {
      dataset, harness_ref: "pi@version:1.2.3", model: "openai/test", attempts: 1,
      max_concurrent: 1, infrastructure_retries: 2, infrastructure_retry_backoff_ms: 0,
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(await readFile(path.join(root, "provider-quota.count"), "utf8"), "1");
  const circuit = events.find((event) => event.type === "eval.provider-circuit.opened");
  assert.deepEqual(circuit && {
    scope: circuit.scope, mode: circuit.mode, provider: circuit.provider, model: circuit.model,
    stable_code: circuit.stable_code, automatic_probe: circuit.automatic_probe,
  }, {
    scope: "trial-retry", mode: "retry-only", provider: "local-docker", model: "openai/test",
    stable_code: "provider_quota_exhausted", automatic_probe: false,
  });
});

test("planned infrastructure retry starts before unrelated initial work finishes", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-planned-immediate-retry-"));
  t.after(() => forceRemove(root));
  const dataset = path.join(root, "dataset");
  for (const task of ["one", "two"]) {
    await mkdir(path.join(dataset, task), { recursive: true });
    await writeFile(path.join(dataset, task, "task.toml"), `name = ${JSON.stringify(task)}\n`);
  }
  const activityLog = path.join(root, "activity.jsonl");
  const harbor = await writeImmediateRetryHarbor(root, activityLog);
  const npm = await writeFakeNpm(root);
  const result = await runEval({
    root,
    harborExecutable: harbor,
    executionStrategy: "local-task-slots-v1",
    executionResources: { cpu_millis: 1_000, memory_bytes: 1024 * 1024 * 1024, container_slots: 1, build_slots: 0 },
    trialBundleGraceMs: 0,
    env: { ...process.env, HITCH_NPM_PATH: npm },
    request: {
      dataset,
      harness_ref: "pi@version:1.2.3",
      attempts: 1,
      max_concurrent: 2,
      infrastructure_retries: 1,
      infrastructure_retry_backoff_ms: 0,
    },
  });

  assert.equal(result.status, "failed");
  const activity = (await readFile(activityLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
    type: "start" | "end"; task: string; call: number; time: number;
  });
  const retryStart = activity.findIndex((entry) => entry.type === "start" && entry.task === "one" && entry.call === 2);
  const unrelatedEnd = activity.findIndex((entry) => entry.type === "end" && entry.task === "two" && entry.call === 1);
  assert.ok(retryStart >= 0, "missing retry start");
  assert.ok(unrelatedEnd >= 0, "missing unrelated task completion");
  assert.ok(retryStart < unrelatedEnd, "retry waited for the unrelated initial trial barrier");
});

test("a persisted planned retry resumes without repeating the initial candidate", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-planned-retry-resume-"));
  t.after(() => forceRemove(root));
  const dataset = path.join(root, "dataset");
  await mkdir(path.join(dataset, "one"), { recursive: true });
  await writeFile(path.join(dataset, "one", "task.toml"), "name = \"one\"\n");
  const harbor = await writeInfrastructureFailureHarbor(root);
  const npm = await writeFakeNpm(root);
  const controller = new AbortController();
  const request = {
    dataset, harness_ref: "pi@version:1.2.3", attempts: 1, max_concurrent: 1,
    infrastructure_retries: 1, infrastructure_retry_backoff_ms: 200,
  };
  const interrupted = await runEval({
    root, harborExecutable: harbor, executionStrategy: "local-task-slots-v1", trialBundleGraceMs: 0,
    env: { ...process.env, HITCH_NPM_PATH: npm }, request, signal: controller.signal,
    onEvent: (event) => { if (event.type === "eval.retry.decision") controller.abort(); },
  });
  assert.equal(interrupted.status, "cancelled");
  assert.equal(await readFile(path.join(root, "infrastructure-failure.count"), "utf8"), "1");
  const evalDirectory = path.join(root, "evals", interrupted.eval_id as string);
  const planned = await readEvalRetryState(evalDirectory, interrupted.eval_id as string);
  assert.equal(planned?.decisions[0]?.state, "planned");

  await rm(path.join(evalDirectory, "result.json"));
  const resumed = await runEval({
    root, evalId: interrupted.eval_id as never, request, precreated: true, resumeExisting: true,
    harborExecutable: harbor, executionStrategy: "local-task-slots-v1", trialBundleGraceMs: 0,
    env: { ...process.env, HITCH_NPM_PATH: npm },
  });
  assert.equal(resumed.status, "failed");
  assert.equal(await readFile(path.join(root, "infrastructure-failure.count"), "utf8"), "2");
  const terminal = await readEvalRetryState(evalDirectory, interrupted.eval_id as string);
  assert.equal(terminal?.decisions[0]?.state, "exhausted");
});

test("planned task Dockerfiles are built once and injected as immutable prebuilt images", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-planned-prebuilt-image-"));
  t.after(() => forceRemove(root));
  const dataset = path.join(root, "dataset");
  const environment = path.join(dataset, "one", "environment");
  await mkdir(environment, { recursive: true });
  await writeFile(path.join(dataset, "one", "task.toml"), "name = \"one\"\n");
  await writeFile(path.join(environment, "Dockerfile"), "FROM scratch\n");
  const harbor = await writeFakeHarbor(root);
  const npm = await writeFakeNpm(root);
  const inspector = await writeBuildInspector(root);
  const manifestDigest = `sha256:${"7".repeat(64)}` as const;
  const configDigest = `sha256:${"8".repeat(64)}` as const;
  const docker = await writeObservedImageDocker(root, configDigest);
  let builds = 0;
  let buildSlots = 0;
  const built = new Map<string, typeof manifestDigest>();
  const builder: EnvironmentImageBuilder = {
    id: "planned-prebuild-test",
    probe: async (reference, digest) => built.get(reference.split("@", 1)[0] as string) === digest,
    build: async (input) => {
      builds += 1;
      built.set(input.outputReference, manifestDigest);
      return { reference: input.outputReference, manifest_digest: manifestDigest, config_digest: configDigest, platform: input.platform };
    },
  };
  const imageBuilder = localEnvironmentImageBuild(root, async () => {
    buildSlots += 1;
    return { release: () => { buildSlots -= 1; } };
  }, builder);
  const result = await runEval({
    root,
    harborExecutable: harbor,
    executionStrategy: "local-task-slots-v1",
    executionResources: { cpu_millis: 1_000, memory_bytes: 1024 * 1024 * 1024, container_slots: 1, build_slots: 0 },
    environmentBuildMode: "prebuild-preferred",
    environmentImageBuilder: imageBuilder,
    environmentImageManifestLoader: (imageId) => loadEnvironmentImageManifest(root, imageId),
    trialBundleGraceMs: 0,
    dockerResourceReaper: async () => ({ schema_version: "1", root_id: hitchRootId(root), scanned: 0, deleted: [], retained: [], issues: [] }),
    env: { ...process.env, HITCH_NPM_PATH: npm, HITCH_HARBOR_PYTHON_PATH: inspector, HITCH_DOCKER_PATH: docker },
    request: { dataset, harness_ref: "pi@version:1.2.3", attempts: 1, max_concurrent: 1, infrastructure_retries: 0 },
  });
  assert.equal(builds, 1);
  assert.equal(buildSlots, 0);
  const evalDirectory = path.join(root, "evals", result.eval_id as string);
  const plan = parseEvalExecutionPlan(await readJSON<unknown>(path.join(evalDirectory, "execution-plan.json")));
  const image = plan.work_items[0]?.image_refs?.[0];
  assert.equal(image?.resolution, "prebuilt");
  assert.equal(image?.manifest_digest, manifestDigest);
  const provisional = await readEvalEnvironmentImageReferences(evalDirectory, result.eval_id as string);
  assert.deepEqual(provisional && { state: provisional.state, image_ids: provisional.image_ids }, {
    state: "planned", image_ids: [image?.image_id],
  });
  const config = await readJSON<Record<string, unknown>>(path.join(evalDirectory, "harbor", "work-items", plan.work_items[0]!.work_id, "epoch-000001", "job.json"));
  const kwargs = (config.environment as Record<string, Record<string, unknown>>).kwargs;
  assert.ok(kwargs);
  assert.equal(kwargs.hitch_prebuilt_task_image, configDigest);
  assert.equal(kwargs.hitch_resolved_images, undefined);
});

test("identical task Dockerfiles share one content-addressed build across task IDs", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-planned-shared-build-"));
  t.after(() => forceRemove(root));
  const contexts = [path.join(root, "task-one"), path.join(root, "task-two")];
  for (const context of contexts) {
    await mkdir(context, { recursive: true });
    await writeFile(path.join(context, "Dockerfile"), "FROM scratch\nCOPY payload /payload\n");
    await writeFile(path.join(context, "payload"), "shared\n");
  }
  const manifestDigest = `sha256:${"7".repeat(64)}` as const;
  const configDigest = `sha256:${"8".repeat(64)}` as const;
  const built = new Map<string, typeof manifestDigest>();
  let builds = 0;
  const builder: EnvironmentImageBuilder = {
    id: "planned-shared-build-test",
    probe: async (reference, digest) => built.get(reference) === digest,
    build: async (input) => {
      builds += 1;
      built.set(input.outputReference, manifestDigest);
      return { reference: input.outputReference, manifest_digest: manifestDigest, config_digest: configDigest, platform: input.platform };
    },
  };
  const imageBuilder = localEnvironmentImageBuild(root, async () => ({ release: () => {} }), builder);
  const first = await imageBuilder({
    benchmarkId: "shared-build", benchmarkRevision: "1", taskId: "one",
    contextDirectory: contexts[0] as string, dockerfile: "Dockerfile", platform: "linux/amd64",
  });
  const second = await imageBuilder({
    benchmarkId: "shared-build", benchmarkRevision: "1", taskId: "two",
    contextDirectory: contexts[1] as string, dockerfile: "Dockerfile", platform: "linux/amd64",
  });
  assert.equal(builds, 1);
  assert.equal(first.cache_hit, false);
  assert.equal(second.cache_hit, true);
  assert.equal(second.image_id, first.image_id);
  assert.equal((await loadEnvironmentImageManifest(root, first.image_id)).source.task_id, undefined);
});

interface Activity {
  type: "start" | "end";
  time: number;
  logicalAttempt: number;
  tasks: string[];
}

function event(activity: Activity[], type: Activity["type"], task: string, attempt: number): Activity {
  const found = activity.find((entry) => entry.type === type && entry.logicalAttempt === attempt && entry.tasks.includes(task));
  assert.ok(found, `missing ${type} for ${task}#${attempt}`);
  return found;
}

async function writeInfrastructureFailureHarbor(directory: string): Promise<string> {
  const executable = path.join(directory, "fake-harbor-infrastructure-failure");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("harbor 0.21.0\\n"); process.exit(0); }
const configIndex = args.indexOf("--config");
if (args[0] !== "run" || configIndex < 0 || !args.includes("--yes")) process.exit(2);
const config = JSON.parse(fs.readFileSync(args[configIndex + 1], "utf8"));
const counter = ${JSON.stringify(path.join(directory, "infrastructure-failure.count"))};
let call = 1;
try { call = Number(fs.readFileSync(counter, "utf8")) + 1; } catch {}
fs.writeFileSync(counter, String(call));
const output = path.join(config.jobs_dir, config.job_name);
const trial = "one__infra-" + call;
const trialDirectory = path.join(output, trial);
fs.mkdirSync(trialDirectory, {recursive:true});
fs.writeFileSync(path.join(trialDirectory, "lock.json"), JSON.stringify({task:{name:"one"}}));
fs.writeFileSync(path.join(trialDirectory, "result.json"), JSON.stringify({
  task_name:"one", trial_name:trial, exception_info:{exception_type:"InfrastructureError"}, verifier_result:{rewards:{reward:0}}
}));
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({
  n_total_trials:1, stats:{n_completed_trials:0,n_errored_trials:1,n_cancelled_trials:0}
}));
`;
  await writeFile(executable, source, { mode: 0o755 });
  return executable;
}

async function writeProviderQuotaFailureHarbor(directory: string): Promise<string> {
  const executable = path.join(directory, "fake-harbor-provider-quota");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("harbor 0.21.0\\n"); process.exit(0); }
const configIndex = args.indexOf("--config");
if (args[0] !== "run" || configIndex < 0 || !args.includes("--yes")) process.exit(2);
const config = JSON.parse(fs.readFileSync(args[configIndex + 1], "utf8"));
const counter = ${JSON.stringify(path.join(directory, "provider-quota.count"))};
let call = 1;
try { call = Number(fs.readFileSync(counter, "utf8")) + 1; } catch {}
fs.writeFileSync(counter, String(call));
const output = path.join(config.jobs_dir, config.job_name);
const trial = "one__quota-" + call;
const trialDirectory = path.join(output, trial);
fs.mkdirSync(path.join(trialDirectory, "agent"), {recursive:true});
fs.writeFileSync(path.join(trialDirectory, "lock.json"), JSON.stringify({task:{name:"one"}}));
fs.writeFileSync(path.join(trialDirectory, "agent", "hitch-bridge-error.json"), JSON.stringify({
  schema_version:"1", code:"hitch_process_failed", message:"account quota exhausted"
}));
fs.writeFileSync(path.join(trialDirectory, "result.json"), JSON.stringify({
  task_name:"one", trial_name:trial, exception_info:{exception_type:"HitchBridgeError"}, verifier_result:{rewards:{reward:0}}
}));
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({
  n_total_trials:1, stats:{n_completed_trials:0,n_errored_trials:1,n_cancelled_trials:0}
}));
`;
  await writeFile(executable, source, { mode: 0o755 });
  return executable;
}

async function writeImmediateRetryHarbor(directory: string, activityLog: string): Promise<string> {
  const executable = path.join(directory, "fake-harbor-immediate-retry");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("harbor 0.21.0\\n"); process.exit(0); }
const configIndex = args.indexOf("--config");
if (args[0] !== "run" || configIndex < 0 || !args.includes("--yes")) process.exit(2);
const config = JSON.parse(fs.readFileSync(args[configIndex + 1], "utf8"));
const task = config.datasets[0].task_names[0];
const counter = path.join(${JSON.stringify(directory)}, task + ".count");
let call = 1;
try { call = Number(fs.readFileSync(counter, "utf8")) + 1; } catch {}
fs.writeFileSync(counter, String(call));
const activity = (type) => fs.appendFileSync(${JSON.stringify(activityLog)}, JSON.stringify({type, task, call, time:Date.now()}) + "\\n");
const output = path.join(config.jobs_dir, config.job_name);
const retryStarted = path.join(${JSON.stringify(directory)}, "retry-started");
activity("start");
if (task === "one" && call === 2) fs.writeFileSync(retryStarted, "ready");
const finish = () => {
  const trialName = task + "__call-" + call;
  const trialDirectory = path.join(output, trialName);
  fs.mkdirSync(trialDirectory, {recursive:true});
  fs.writeFileSync(path.join(trialDirectory, "lock.json"), JSON.stringify({task:{name:task}}));
  const failed = task === "one";
  fs.writeFileSync(path.join(trialDirectory, "result.json"), JSON.stringify({
    task_name:task, trial_name:trialName,
    ...(failed ? {exception_info:{exception_type:"InfrastructureError"}} : {}),
    verifier_result:{rewards:{reward:failed ? 0 : 1}}
  }));
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({
    n_total_trials:1,
    stats:{n_completed_trials:failed ? 0 : 1,n_errored_trials:failed ? 1 : 0,n_cancelled_trials:0}
  }));
  activity("end");
};
if (task === "two") {
  // Keep unrelated work active until the retry actually starts. A fixed
  // sleep measures runner load instead of the scheduler's dependency order.
  const deadline = Date.now() + 15_000;
  const waitForRetry = () => {
    if (fs.existsSync(retryStarted) || Date.now() >= deadline) finish();
    else setTimeout(waitForRetry, 10);
  };
  waitForRetry();
} else finish();
`;
  await writeFile(executable, source, { mode: 0o755 });
  return executable;
}

async function writeBuildInspector(directory: string): Promise<string> {
  const executable = path.join(directory, "fake-harbor-python-inspector");
  const declaration = {
    schema_version: "1", task: {}, verifier: { separate: false }, compose_services: [{ name: "main", replicas: 1 }],
    provider_sidecars: { main_egress: false, verifier_egress: false }, environment_images: [], environment_image_fallbacks: [],
    environment_builds: [{ source: "task", service: "main", context: "environment", dockerfile: "Dockerfile" }],
  };
  await writeFile(executable, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(declaration))});\n`, { mode: 0o755 });
  return executable;
}

async function writeObservedImageDocker(directory: string, configDigest: string): Promise<string> {
  const executable = path.join(directory, "fake-observed-image-docker");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
function jobs(dir) {
  let result = [];
  try { for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result = result.concat(jobs(file));
    else if (entry.name === "job.json") result.push(file);
  } } catch {}
  return result;
}
function labels() {
  const file = jobs(${JSON.stringify(path.join(directory, "evals"))}).sort().pop();
  if (!file) return null;
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  return config.environment?.kwargs?.hitch_ownership_labels || null;
}
if (args[0] === "container" && args[1] === "ls") { if (labels()) process.stdout.write("abcdefabcdef\\n"); process.exit(0); }
if (args[0] === "container" && args[1] === "inspect") {
  process.stdout.write(JSON.stringify([{Id:"abcdefabcdef",Name:"/main",Image:${JSON.stringify(configDigest)},Config:{Labels:labels(),Image:${JSON.stringify(configDigest)}},State:{Running:false,OOMKilled:false,ExitCode:0,Error:""}}]));
  process.exit(0);
}
process.exit(2);
`;
  await writeFile(executable, source, { mode: 0o755 });
  return executable;
}
