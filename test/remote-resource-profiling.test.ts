import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { BackendWorkItemV1, EvalRequest, RemoteWorkOfferV1, WorkResourceProfilingV1 } from "../src/domain/index.js";
import { parseDaemonResourcePolicy } from "../src/cli/commands/daemon.js";
import { startDetachedDaemon } from "../src/daemon/launcher.js";
import { parseRemoteWorkItem } from "../src/control-plane/remote-work-item.js";
import { validateRemoteOfferContract } from "../src/control-plane/remote-offer-contract.js";
import { RemoteWorkInputStore } from "../src/control-plane/remote-work-inputs.js";
import { RemoteWorkerRunner } from "../src/control-plane/remote-worker-runner.js";
import type { RemoteWorkerHttpClient } from "../src/control-plane/remote-worker-client.js";
import { buildEvalExecutionPlan, validateEvalId } from "../src/evals/index.js";

const profile: WorkResourceProfilingV1 = { schema_version: "1", unknown: true, unknown_max_parallelism: 2,
  unknown_slots: 1, reason: "missing-resource-size", approval_digests: [] };
const resources = { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
function work(suffix: string): BackendWorkItemV1 { return { schema_version: "1", work_id: `work_${suffix.repeat(32)}`, eval_id: `eval_${suffix.repeat(32)}`,
  backend: "harbor", logical_attempt: 1, task_ids: ["task"], slots: [`slot_${suffix.repeat(32)}`], opaque_membership: false,
  requested_parallelism: 1, provider: "remote-docker", reservation: resources, resource_profiling: { ...profile } }; }
function offer(suffix: string): RemoteWorkOfferV1 {
  const item = work(suffix), at = new Date().toISOString();
  return { schema_version: "1", offer_id: `offer_${suffix.repeat(32)}`, nonce: suffix.repeat(64), generation: 1, worker_id: "worker_test", work: item,
    lease: { schema_version: "1", lease_id: `lease_${suffix.repeat(32)}`, work_id: item.work_id, eval_id: item.eval_id, worker_id: "worker_test",
      provider: "remote-docker", collision_domain_id: "docker:test", reservation: resources, epoch: 1, state: "offered", issued_at: at, expires_at: at },
    issued_at: at, expires_at: at, state: "offered", inputs: ["work-spec", "harness-artifact", "controller-runtime", "task-input"].map(kind => ({
      kind: kind as "work-spec", format: kind === "work-spec" ? "json" : "hitch-tree-v1", digest: `sha256:${"a".repeat(64)}`, size: 2 })) };
}
const features = { docker: true, buildkit: false, model_proxy: false, isolated_same_task_attempts: false };

test("unknown policy CLI overrides environment and detached launch preserves the resolved value", async t => {
  const args = ["--unknown-max-parallelism", "3"];
  const policy = await parseDaemonResourcePolicy(args, 8, { env: { HITCH_RESOURCE_PROFILING_UNKNOWN_MAX_PARALLELISM: "2" }, detect: async () => ({}) });
  assert.equal(policy.resource_profiling!.unknown_max_parallelism, 3); assert.deepEqual(args, []);
  const environment = await parseDaemonResourcePolicy([], 8, { env: { HITCH_RESOURCE_PROFILING_UNKNOWN_MAX_PARALLELISM: "2" }, detect: async () => ({}) });
  assert.equal(environment.resource_profiling!.unknown_max_parallelism, 2);
  const fallback = await parseDaemonResourcePolicy([], 8, { env: {}, detect: async () => ({}) });
  assert.equal(fallback.resource_profiling!.unknown_max_parallelism, 1);
  for (const value of ["0", "-1", "1.5", "10001", "two"]) await assert.rejects(parseDaemonResourcePolicy(["--unknown-max-parallelism", value], 8, { env: {}, detect: async () => ({}) }));
  const root = await mkdtemp(path.join(tmpdir(), "hitch-profiling-launcher-")); t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "capture.mjs"), captured = path.join(root, "args.json");
  await writeFile(executable, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2)));`);
  await startDetachedDaemon({ root, executable, port: 0, maxConcurrent: 8, resourcePolicy: policy });
  const launched = await waitFor(async () => { try { return JSON.parse(await readFile(captured, "utf8")) as string[]; } catch { return undefined; } });
  assert.equal(launched[launched.indexOf("--unknown-max-parallelism") + 1], "3");
});

test("remote work profiling is parsed strictly and requires worker support plus a frozen spec", async t => {
  assert.deepEqual(parseRemoteWorkItem(work("a")).resource_profiling, profile);
  for (const changed of [{ ...profile, unknown_slots: 0 }, { ...profile, unknown: false }, { ...profile, approval_digests: ["mutable"] }, { ...profile, surprise: true }]) {
    assert.throws(() => parseRemoteWorkItem({ ...work("a"), resource_profiling: changed }), /profiling/);
  }
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-profiling-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RemoteWorkInputStore(root); await store.initialize();
  await assert.rejects(validateRemoteOfferContract(offer("a"), features, store), /resource_profiling/);
  await assert.rejects(validateRemoteOfferContract({ ...offer("a"), inputs: [] }, { ...features, resource_profiling: "1" }, store), /sealed/);
  const request: EvalRequest = { schema_version: "1", backend: "harbor", dataset: "/tasks", harness_ref: "pi@version:1", model: "test/model", attempts: 1,
    max_concurrent: 2, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0, timeout_ms: 0, setup_timeout_ms: 0, agent_args: [], pass_env: [], benchmark_id: "test", benchmark_revision: "fixture" };
  const plan = buildEvalExecutionPlan({ evalId: validateEvalId(`eval_${"a".repeat(32)}`), request,
    candidate: { artifactId: `sha256:${"b".repeat(64)}`, revisionIdentity: `sha256:${"c".repeat(64)}` }, tasks: ["task"], maxParallelism: 2,
    provider: "remote-docker", workItemMode: "task-slots", resourceProfiling: { schema_version: "1", unknown_max_parallelism: 2, requested_parallelism: 2, scope: "worker", approvals: [] } });
  const frozen = plan.work_items[0]!;
  const ref = await store.put("work-spec", "json", Buffer.from(JSON.stringify({ schema_version: "1", plan, work: frozen })));
  const valid = { ...offer("a"), work: frozen, inputs: [ref] };
  await validateRemoteOfferContract(valid, { ...features, resource_profiling: "1" }, store);
  await assert.rejects(validateRemoteOfferContract({ ...valid, work: { ...frozen, resource_profiling: { ...profile, unknown_max_parallelism: 1 } } }, { ...features, resource_profiling: "1" }, store), /frozen/);
});

test("worker unknown budget spans different evals and remains held until cleanup release", async () => {
  const offers = [offer("a"), offer("b")];
  const started: string[] = [], completions = new Map<string, () => void>(), errors: unknown[] = [];
  const fake = {
    generation: 1, fencedSignal: new AbortController().signal, listOffers: async () => offers,
    heartbeat: async () => {}, downloadInput: async () => Buffer.from('{"schema_version":"1"}'),
    credentials: async () => ({ credentials: {} }),
    accept: async (value: RemoteWorkOfferV1) => { value.state = "accepted"; return value; },
    complete: async (value: RemoteWorkOfferV1) => { value.state = "completed"; return value; },
    release: async (value: RemoteWorkOfferV1) => { value.state = "released"; return value; },
    reject: async (value: RemoteWorkOfferV1, code: string) => { value.state = "rejected"; value.rejection_code = code; return value; },
  } as unknown as RemoteWorkerHttpClient;
  const runner = new RemoteWorkerRunner({ client: fake, capacity: { ...resources, cpu_millis: 4000, memory_bytes: 4 * 1024 ** 3, container_slots: 4 },
    resourceProfilingPolicy: { unknown_max_parallelism: 1 }, onError: error => errors.push(error),
    execute: async ({ offer }) => { started.push(offer.offer_id); await new Promise<void>(resolve => completions.set(offer.offer_id, resolve)); return { status: "succeeded" }; } });
  await runner.tick(); await waitFor(async () => started.length === 1 ? true : undefined);
  assert.deepEqual(started, [offers[0]!.offer_id]);
  completions.get(offers[0]!.offer_id)!(); await waitFor(async () => offers[0]!.state === "completed" ? true : undefined);
  await runner.tick(); assert.equal(started.length, 1, "terminal result is not cleanup release");
  offers[0]!.state = "release-requested"; await runner.tick(); await waitFor(async () => started.length === 2 ? true : undefined);
  completions.get(offers[1]!.offer_id)!(); await waitFor(async () => offers[1]!.state === "completed" ? true : undefined);
  offers[1]!.state = "release-requested"; await runner.tick(); assert.deepEqual(errors, []);
  const oversized = offer("c"); oversized.work.resource_profiling!.unknown_slots = 2; offers.push(oversized);
  await runner.tick(); assert.equal(oversized.state, "rejected"); assert.equal(oversized.rejection_code, "resource_profiling_capacity_exceeded");
});

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 100; i++) { const value = await read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("timed out waiting for profiling test state");
}

for (const generation of [1, 2]) test(`worker generation ${generation} fences new work while a pre-existing execution is being recovered`, async t => {
  const previous = offer("a"), fresh = offer("b");
  previous.state = "accepted"; previous.accepted_at = previous.issued_at;
  // Deliberately list new work first, so response ordering cannot bypass recovery.
  fresh.generation = generation;
  const offers = [fresh, previous], started: string[] = [], errors: unknown[] = [];
  let cleanupStarted = false, cleaned = false;
  let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; }); t.after(() => resume());
  const fake = {
    workerId: "worker_test", generation, fencedSignal: new AbortController().signal,
    listOffers: async () => offers.filter(value => value.state !== "released" && !(generation === 2 && cleaned && value === previous)),
    heartbeat: async () => {}, downloadInput: async () => Buffer.from('{"schema_version":"1"}'), credentials: async () => ({ credentials: {} }),
    accept: async (value: RemoteWorkOfferV1) => { value.state = "accepted"; return value; },
    complete: async (value: RemoteWorkOfferV1) => { value.state = "completed"; return value; },
    release: async (value: RemoteWorkOfferV1) => { value.state = "released"; return value; },
    uploadArtifact: async () => ({ kind: "diagnostic", digest: `sha256:${"a".repeat(64)}`, size: 1 }),
    cleanupChallenge: async () => { cleanupStarted = true; await gate; cleaned = true; return { receipt: {} }; },
  } as unknown as RemoteWorkerHttpClient;
  const runner = new RemoteWorkerRunner({ client: fake, capacity: { ...resources, cpu_millis: 4000, memory_bytes: 4 * 1024 ** 3, container_slots: 4 },
    resourceProfilingPolicy: { unknown_max_parallelism: 1 }, onError: error => errors.push(error),
    releaseUnknown: async () => { cleanupStarted = true; await gate; cleaned = true; },
    releasePreviousGeneration: async () => { throw new Error("already acknowledged cleanup must not run again"); },
    execute: async ({ offer }) => { started.push(offer.offer_id); return { status: "succeeded" }; } });
  const first = runner.tick(); await waitFor(async () => cleanupStarted ? true : undefined);
  assert.deepEqual(started, [], "unknown allowance must not be reset while old containers can still be live");
  resume(); await first; await waitFor(async () => cleaned ? true : undefined);
  if (generation === 1) { previous.state = "release-requested"; await runner.tick(); }
  await runner.tick(); await waitFor(async () => fresh.state === "completed" ? true : undefined);
  assert.deepEqual(started, [fresh.offer_id]);
  fresh.state = "release-requested"; await runner.tick(); assert.deepEqual(errors, []);
});
