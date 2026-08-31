import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResourceLedger, WorkItemDispatcher } from "../src/control-plane/index.js";
import { localEnvironmentImageBuild } from "../src/control-plane/eval-image-resolution.js";
import { parseEvalExecutionPlan, readExecutionLeases, runEval } from "../src/evals/index.js";
import { hitchRootId, readJSON } from "../src/foundation/index.js";
import { loadEnvironmentImageManifest } from "../src/images/index.js";
import type { EnvironmentImageBuilder } from "../src/images/index.js";
import { forceRemove, writeFakeHarbor, writeFakeNpm } from "../test-support/helpers.js";

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
  const retries = result.infrastructure_retry_runs as Array<Record<string, unknown>>;
  assert.equal(retries.length, 1);
  assert.equal(retries[0]?.execution_kind, "physical-infrastructure-retry");
  assert.equal(typeof retries[0]?.lease_id, "string");
  assert.equal(typeof retries[0]?.work_id, "string");
  assert.equal(allocations.length, 2, "initial execution and physical retry must each be admitted");
  assert.equal(new Set(allocations).size, 2);
  const evalDirectory = path.join(root, "evals", result.eval_id as string);
  const leases = await readExecutionLeases(evalDirectory);
  assert.equal(leases.length, 2);
  assert.equal(new Set(leases.map((lease) => lease.lease_id)).size, 2);
  assert.equal(new Set(leases.map((lease) => lease.work_id)).size, 1);
  assert.ok(leases.every((lease) => lease.state === "released" && lease.parent_allocation_id));
  assert.deepEqual(new Set(reaped), new Set(leases.map((lease) => lease.lease_id)));
  const retryLease = leases.find((lease) => lease.lease_id === retries[0]?.lease_id);
  assert.ok(retryLease);
  const retryConfig = await readJSON<Record<string, unknown>>(path.join(
    evalDirectory,
    "harbor", "work-items", retryLease.work_id, "infrastructure-retries", "retry-0001", "harbor", "job.json",
  ));
  const labels = ((retryConfig.environment as Record<string, unknown>).kwargs as Record<string, Record<string, string>>).hitch_ownership_labels;
  assert.ok(labels);
  assert.equal(labels["io.hitch.lease-id"], retryLease.lease_id);
  assert.equal(labels["io.hitch.work-id"], retryLease.work_id);
  assert.deepEqual(resources.snapshot().allocated, { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 });
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
  const config = await readJSON<Record<string, unknown>>(path.join(evalDirectory, "harbor", "work-items", plan.work_items[0]!.work_id, "epoch-000001", "job.json"));
  const kwargs = (config.environment as Record<string, Record<string, unknown>>).kwargs;
  assert.ok(kwargs);
  assert.equal(kwargs.hitch_prebuilt_task_image, configDigest);
  assert.equal(kwargs.hitch_resolved_images, undefined);
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
