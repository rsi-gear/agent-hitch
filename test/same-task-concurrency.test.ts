import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResourceLedger, WorkItemDispatcher } from "../src/control-plane/index.js";
import { workItemAdmission } from "../src/control-plane/work-admission.js";
import type { BackendWorkItemV1 } from "../src/domain/index.js";
import { readExecutionLeases, runEval, validateEvalId, validateEvalRequest } from "../src/evals/index.js";
import type { RunEvalOptions } from "../src/evals/index.js";
import { hitchRootId } from "../src/foundation/index.js";
import { forceRemove, prepareHostHarborArtifactForTest, writeFakeHarbor, writeFakeNpm } from "../test-support/helpers.js";

const unit = { cpu_millis: 1_000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
type Activity = { type: string; logicalAttempt: number; time: number };
async function activities(file: string): Promise<Activity[]> {
  return (await readFile(file, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
function peak(events: Activity[]): number {
  let active = 0, maximum = 0;
  for (const event of events) {
    if (event.type === "start") maximum = Math.max(maximum, ++active);
    if (event.type === "end") active--;
  }
  return maximum;
}
async function fixture(t: { after(fn: () => Promise<void>): void }, options: { isolated: boolean; max: number; attempts: number; hold?: boolean }) {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-same-task-"));
  t.after(() => forceRemove(root));
  const dataset = path.join(root, "dataset"), activityLog = path.join(root, "activity.jsonl");
  await mkdir(path.join(dataset, "one"), { recursive: true });
  await writeFile(path.join(dataset, "one/task.toml"), 'name = "one"\n');
  const harbor = await writeFakeHarbor(root, { version: "0.21.0", activityLog, delayMs: 50 });
  // Gate on actual child starts, so startup skew cannot manufacture or hide overlap.
  if (options.isolated && options.max > 1) {
    const source = await readFile(harbor, "utf8");
    await writeFile(harbor, source.replace('  runCandidate();', `  if (${options.hold === true} || (logicalAttempt <= ${options.max} && fs.readFileSync(activityLog, "utf8").split("\\n").filter(line => line && JSON.parse(line).type === "start").length < ${options.max})) { setTimeout(waitForStarts, 10); return; }\n  runCandidate();`));
  }
  const npm = await writeFakeNpm(root), inspector = path.join(root, "inspection-python");
  const resources = { schema_version: "1", task: {}, verifier: { separate: false }, compose_services: [{ name: "main", replicas: 1 }], provider_sidecars: { main_egress: false, verifier_egress: false }, environment_images: [], environment_image_fallbacks: [], environment_builds: [] };
  // Explicit interpreter test double; real runtime isolation is covered by the Linux canary.
  await writeFile(inspector, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.some(arg=>arg.includes('hitch_attempt_isolation.py')) ? {protocol:'hitch-attempt-isolation@1',supported:${options.isolated},blockers:[]} : ${JSON.stringify(resources)}));\n`, { mode: 0o755 });
  const ledger = new ResourceLedger({ cpu_millis: 4_000, memory_bytes: 4 * 1024 ** 3, container_slots: 4, build_slots: 1 });
  const dispatcher = new WorkItemDispatcher({ resources: ledger });
  t.after(async () => dispatcher.close());
  const request = { dataset, harness_ref: "pi@version:1.2.3", attempts: options.attempts, max_concurrent: options.max, infrastructure_retries: 0 };
  const admission = workItemAdmission({ dispatcher, request: await validateEvalRequest(request), collisionDomainId: "fixture", isolatedSameTaskAttempts: true });
  const runOptions: RunEvalOptions = {
    root, request, harborExecutable: harbor, executionStrategy: "local-task-slots-v1",
    executionResources: unit, trialBundleGraceMs: 0,
    harborArtifactBuilder: prepareHostHarborArtifactForTest,
    env: { ...process.env, HITCH_NPM_PATH: npm, HITCH_HARBOR_PYTHON_PATH: inspector },
    workItemAdmission: admission,
    dockerResourceReaper: async () => ({ schema_version: "1", root_id: hitchRootId(root), scanned: 0, deleted: [], retained: [], issues: [] }),
  };
  return { root, activityLog, ledger, runOptions };
}

for (const entry of [{ isolated: true, max: 2, attempts: 3 }, { isolated: true, max: 3, attempts: 4 }, { isolated: true, max: 1, attempts: 2 }, { isolated: false, max: 2, attempts: 2 }]) {
  test(`same-task attempts respect isolation=${entry.isolated} and max=${entry.max}, and resume skips completed slots`, { timeout: 60_000 }, async t => {
    const f = await fixture(t, entry);
    const result = await runEval({ ...f.runOptions, signal: t.signal });
    assert.equal((result.trials as unknown[]).length, entry.attempts, JSON.stringify(result));
    const activity = await activities(f.activityLog);
    assert.equal(peak(activity), entry.isolated ? entry.max : 1);
    assert.equal(activity.filter(e => e.type === "end").length, entry.attempts);
    const directory = path.join(f.root, "evals", result.eval_id);
    const leases = await readExecutionLeases(directory);
    assert.equal(leases.length, entry.attempts);
    assert.equal(new Set(leases.map(lease => lease.work_id)).size, entry.attempts);
    assert.ok(leases.every(lease => lease.state === "released"));
    const jobs = await Promise.all(leases.map(async lease => JSON.parse(await readFile(path.join(directory, "harbor", "work-items", lease.work_id, "epoch-000001", "job.json"), "utf8"))));
    assert.equal(new Set(jobs.map(job => job.jobs_dir)).size, entry.attempts);
    for (const job of jobs) assert.equal(job.environment.kwargs.hitch_isolated_attempts === true, entry.isolated);
    assert.equal(new Set((result.trials as Array<{ run_id: string }>).map(trial => trial.run_id)).size, entry.attempts);
    assert.equal(f.ledger.snapshot().allocated.container_slots, 0);
    await rm(path.join(directory, "result.json"));
    const resumed = await runEval({ ...f.runOptions, evalId: result.eval_id, precreated: true, resumeExisting: true, signal: t.signal });
    assert.equal((resumed.trials as unknown[]).length, entry.attempts, JSON.stringify(resumed));
    assert.deepEqual(await activities(f.activityLog), activity);
    assert.equal((await readExecutionLeases(directory)).length, entry.attempts);
  });
}

test("cancelling two active same-task attempts releases capacity and never launches queued attempts", { timeout: 60_000 }, async t => {
  const f = await fixture(t, { isolated: true, max: 2, attempts: 4, hold: true });
  const controller = new AbortController();
  t.after(async () => controller.abort());
  const execution = runEval({ ...f.runOptions, signal: controller.signal });
  const deadline = Date.now() + 30_000;
  while ((await activities(f.activityLog)).filter(e => e.type === "start").length < 2) {
    if (Date.now() > deadline) { controller.abort(); await execution; assert.fail("parallel attempts did not start"); }
    await delay(10, undefined, { signal: t.signal });
  }
  controller.abort();
  const result = await execution;
  assert.equal(result.status, "cancelled");
  assert.equal((await activities(f.activityLog)).filter(e => e.type === "start").length, 2);
  const leases = await readExecutionLeases(path.join(f.root, "evals", result.eval_id));
  assert.equal(leases.length, 2);
  assert.ok(leases.every(lease => lease.state === "released"));
  assert.equal(f.ledger.snapshot().allocated.container_slots, 0);
});

function work(number: number): BackendWorkItemV1 {
  return { work_id: `work_${number.toString(16).padStart(32, "0")}`, task_ids: ["same"], reservation: unit } as BackendWorkItemV1;
}
const evalId = (number: number) => validateEvalId(`eval_${number.toString(16).padStart(32, "0")}`);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("cross-eval same-task admission requires both capability and proof, obeys global capacity, and cancels queues", async t => {
  const request = await validateEvalRequest({ dataset: "demo@1.0", harness_ref: "pi@version:1.2.3", max_concurrent: 2 });
  for (const supported of [false, true]) {
    const resources = new ResourceLedger({ ...unit, cpu_millis: 2_000, memory_bytes: 2 * 1024 ** 3, container_slots: 2 });
    const dispatcher = new WorkItemDispatcher({ resources });
    t.after(() => dispatcher.close());
    const admission = workItemAdmission({ dispatcher, request, collisionDomainId: "local", isolatedSameTaskAttempts: supported });
    const first = await admission.acquire({ evalId: evalId(1), workItem: work(1), maxParallelism: 2, isolatedSameTaskAttempts: true });
    let secondStarted = false;
    const secondPending = admission.acquire({ evalId: evalId(2), workItem: work(2), maxParallelism: 2, isolatedSameTaskAttempts: true }).then(permit => { secondStarted = true; return permit; });
    await tick();
    assert.equal(secondStarted, supported);
    if (!supported) first.release();
    const second = await secondPending;
    if (supported) {
      assert.notDeepEqual(first.collisionKeys, second.collisionKeys);
      const controller = new AbortController();
      const queued = admission.acquire({ evalId: evalId(3), workItem: work(3), maxParallelism: 2, isolatedSameTaskAttempts: true, signal: controller.signal });
      await tick(); assert.equal(dispatcher.snapshot().active, 2); assert.equal(dispatcher.snapshot().queued, 1);
      controller.abort(); await assert.rejects(queued, /cancelled/);
      first.release();
    }
    second.release();
    // Advertising protocol support alone does not authorize a task to bypass collision locks.
    const third = await admission.acquire({ evalId: evalId(3), workItem: work(3), maxParallelism: 2 });
    let fourthStarted = false;
    const fourthPending = admission.acquire({ evalId: evalId(4), workItem: work(4), maxParallelism: 2 }).then(permit => { fourthStarted = true; return permit; });
    await tick(); assert.equal(fourthStarted, false); third.release(); (await fourthPending).release();
    assert.equal(resources.snapshot().allocated.container_slots, 0);
    dispatcher.close();
  }
});
