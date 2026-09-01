import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EvalScheduler, RemoteWorkerProtocol, RemoteWorkerRegistry, ResourceLedger, encodeRemoteResultEnvelope, parseRemoteTreeEnvelope } from "../src/control-plane/index.js";
import type { RemoteWorkOfferV1, ResourceVectorV1 } from "../src/domain/index.js";
import { readExecutionLeases, runEval as runEvalProduction } from "../src/evals/index.js";
import type { RunEvalOptions } from "../src/evals/index.js";
import { atomicWriteJSON, delay, readJSON, sha256Bytes, sha256JSON } from "../src/foundation/index.js";
import { benchmarkTaskDigest, benchmarkVerifierIdentity } from "../src/runs/index.js";
import { TrajectoryProjector, TrajectoryWriter, canonicalTrajectoryFileRef, trajectoryRefV2 } from "../src/trajectories/index.js";
import { forceRemove, prepareHostHarborArtifactForTest, writeFakeHarbor, writeFakeNpm } from "../test-support/helpers.js";

const GIB = 1024 ** 3;
const DEFAULT_TRIAL: ResourceVectorV1 = { cpu_millis: 2_000, memory_bytes: 4 * GIB, container_slots: 1, build_slots: 0 };
const WORK_CAPACITY: ResourceVectorV1 = { cpu_millis: 2_250, memory_bytes: 4 * GIB + 128 * 1024 ** 2, container_slots: 2, build_slots: 0 };
const ZERO: ResourceVectorV1 = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
const runEval = (options: RunEvalOptions) => runEvalProduction({ ...options, harborArtifactBuilder: prepareHostHarborArtifactForTest });

test("one eval dispatches different tasks to two remote workers and atomically imports their bundles", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-eval-"));
  t.after(() => forceRemove(root));
  const dataset = path.join(root, "dataset");
  for (const task of ["alpha", "beta"]) {
    await mkdir(path.join(dataset, task), { recursive: true });
    await writeFile(path.join(dataset, task, "task.toml"), "");
  }
  const npm = await writeFakeNpm(root);
  const harbor = await writeFakeHarbor(root);
  const inspector = await writeResourceInspector(root);
  const registry = new RemoteWorkerRegistry({ root });
  const protocol = new RemoteWorkerProtocol({ root, registry });
  await Promise.all([registry.initialize(), protocol.initialize()]);
  for (const workerId of ["worker_remote_a", "worker_remote_b"]) await registry.register(registration(workerId));
  const scheduler = new EvalScheduler({
    root,
    resources: new ResourceLedger({ cpu_millis: 1_000, memory_bytes: GIB, container_slots: 1, build_slots: 1 }),
    trialResources: DEFAULT_TRIAL,
    remoteWorkers: registry,
    remoteWorkerProtocol: protocol,
    dockerResourceReaper: async () => ({ schema_version: "1", root_id: "test", scanned: 0, deleted: [], retained: [], issues: [] }),
    executor: (options) => runEval({ ...options, harborExecutable: harbor, env: { ...process.env, HITCH_NPM_PATH: npm, HITCH_HARBOR_PYTHON_PATH: inspector } }),
  });
  await scheduler.initialize();
  t.after(() => scheduler.shutdown());
  const workers = [
    remoteWorkerOnce(root, registry, protocol, "worker_remote_a"),
    remoteWorkerOnce(root, registry, protocol, "worker_remote_b"),
  ];
  const evalId = await scheduler.submit({
    request: { dataset, harness_ref: "pi@version:1.2.3", max_concurrent: 2 },
    execution: {
      provider: "remote-docker", max_parallelism: 2,
      resources: { default_trial: DEFAULT_TRIAL }, build: { mode: "backend" },
      model_capture: { mode: "native", required: false },
    },
  });
  const handled = await Promise.all(workers);
  await waitFor(() => scheduler.status(evalId).then((status) => status?.result !== null), 10_000);
  const status = await scheduler.status(evalId);
  assert.equal(status?.result?.status, "succeeded", JSON.stringify(status?.result));
  assert.deepEqual(new Set(handled.map((entry) => entry.workerId)), new Set(["worker_remote_a", "worker_remote_b"]));
  assert.deepEqual(new Set(handled.map((entry) => entry.taskId)), new Set(["alpha", "beta"]));
  assert.equal((status?.result?.trials as unknown[]).length, 2);
  assert.equal(status?.effective_parallelism.admitted, 0);
  const leases = await readExecutionLeases(path.join(root, "evals", evalId));
  const acceptedLeases = leases.filter((lease) => lease.accepted_at !== undefined);
  assert.equal(acceptedLeases.length, 2);
  assert.ok(leases.every((lease) => lease.state === "released"));
  assert.deepEqual(new Set(acceptedLeases.map((lease) => lease.worker_id)), new Set(["worker_remote_a", "worker_remote_b"]));
  for (const trial of status?.result?.trials as Array<{ run_id: string }>) {
    const execution = await readJSON<{ provider: string; worker_id: string; lease_id: string }>(path.join(root, "runs", trial.run_id, "execution.json"));
    assert.equal(execution.provider, "remote-docker");
    assert.ok(new Set(["worker_remote_a", "worker_remote_b"]).has(execution.worker_id));
    assert.match(execution.lease_id, /^lease_[a-f0-9]{32}$/);
    assert.ok(await readFile(path.join(root, "runs", trial.run_id, "bundle.index.json"), "utf8"));
  }

  const originalTrials = status?.result?.trials as Array<{ run_id: string }>;
  await scheduler.shutdown();
  await simulateCrashAfterRemoteCompletion(root, evalId, acceptedLeases, originalTrials);
  const recoveredScheduler = new EvalScheduler({
    root,
    resources: new ResourceLedger({ cpu_millis: 1_000, memory_bytes: GIB, container_slots: 1, build_slots: 1 }),
    trialResources: DEFAULT_TRIAL,
    remoteWorkers: registry,
    remoteWorkerProtocol: protocol,
    dockerResourceReaper: async () => ({ schema_version: "1", root_id: "test", scanned: 0, deleted: [], retained: [], issues: [] }),
    executor: (options) => runEval({ ...options, harborExecutable: harbor, env: { ...process.env, HITCH_NPM_PATH: npm, HITCH_HARBOR_PYTHON_PATH: inspector } }),
  });
  await recoveredScheduler.initialize();
  t.after(() => recoveredScheduler.shutdown());
  await waitFor(() => recoveredScheduler.status(evalId).then((entry) => entry?.result !== null), 10_000);
  const recovered = await recoveredScheduler.status(evalId);
  assert.equal(recovered?.result?.status, "succeeded", JSON.stringify(recovered?.result));
  assert.deepEqual(new Set((recovered?.result?.trials as Array<{ run_id: string }>).map((trial) => trial.run_id)), new Set(originalTrials.map((trial) => trial.run_id)));
  assert.equal((await readExecutionLeases(path.join(root, "evals", evalId))).filter((lease) => lease.accepted_at !== undefined).length, 2);
});

test("remote eval fails fast when registered workers cannot run the prepared artifact platform", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-platform-mismatch-"));
  t.after(() => forceRemove(root));
  const dataset = path.join(root, "dataset");
  await mkdir(path.join(dataset, "alpha"), { recursive: true });
  await writeFile(path.join(dataset, "alpha", "task.toml"), "");
  const npm = await writeFakeNpm(root);
  const harbor = await writeFakeHarbor(root);
  const inspector = await writeResourceInspector(root);
  const registry = new RemoteWorkerRegistry({ root });
  const protocol = new RemoteWorkerProtocol({ root, registry });
  await Promise.all([registry.initialize(), protocol.initialize()]);
  await registry.register({ ...registration("worker_remote_wrong_platform"), platforms: ["unsupported/test-platform"] });
  const scheduler = new EvalScheduler({
    root,
    resources: new ResourceLedger({ cpu_millis: 1_000, memory_bytes: GIB, container_slots: 1, build_slots: 1 }),
    trialResources: DEFAULT_TRIAL, remoteWorkers: registry, remoteWorkerProtocol: protocol,
    dockerResourceReaper: async () => ({ schema_version: "1", root_id: "test", scanned: 0, deleted: [], retained: [], issues: [] }),
    executor: (options) => runEval({ ...options, harborExecutable: harbor, env: { ...process.env, HITCH_NPM_PATH: npm, HITCH_HARBOR_PYTHON_PATH: inspector } }),
  });
  await scheduler.initialize();
  t.after(() => scheduler.shutdown());
  const evalId = await scheduler.submit({
    request: { dataset, harness_ref: "pi@version:1.2.3", max_concurrent: 1 },
    execution: {
      provider: "remote-docker", max_parallelism: 1,
      resources: { default_trial: DEFAULT_TRIAL }, build: { mode: "backend" },
      model_capture: { mode: "native", required: false },
    },
  });
  await waitFor(() => scheduler.status(evalId).then((status) => status?.result !== null), 10_000);
  const status = await scheduler.status(evalId);
  assert.equal(status?.result?.status, "failed");
  assert.equal((status?.result?.error as { code?: string })?.code, "execution_provider_unavailable");
  assert.equal(status?.leases.length, 0, "an incompatible worker must not receive a lease");
});

async function simulateCrashAfterRemoteCompletion(
  root: string,
  evalId: string,
  leases: Awaited<ReturnType<typeof readExecutionLeases>>,
  trials: Array<{ run_id: string }>,
): Promise<void> {
  const directory = path.join(root, "evals", evalId);
  for (const trial of trials) await rm(path.join(root, "runs", trial.run_id), { recursive: true, force: true });
  await rm(path.join(directory, "result.json"), { force: true });
  const progress = await readJSON<Record<string, unknown>>(path.join(directory, "progress.json"));
  await atomicWriteJSON(path.join(directory, "progress.json"), {
    ...progress, status: "running", generation: Number(progress.generation) + 1,
    trials: [], summary: { settled_trials: 0, valid_trials: 0, invalid_trials: 0 }, updated_at: new Date().toISOString(),
  });
  const control = await readJSON<Record<string, unknown>>(path.join(directory, "control.json"));
  await atomicWriteJSON(path.join(directory, "control.json"), {
    ...control, state: "running", generation: Number(control.generation) + 1,
    admitted_parallelism: 0, active_leases: leases.map((lease) => lease.lease_id).sort(),
    queued_work_items: [], terminal_work_items: [], updated_at: new Date().toISOString(),
  });
  for (const lease of leases) {
    const { terminal_at: _terminalAt, ...active } = lease;
    await atomicWriteJSON(path.join(directory, "leases", `${lease.lease_id}.json`), {
      ...active, state: "running", heartbeat_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
  }
}

function registration(workerId: string) {
  return {
    schema_version: "1", worker_id: workerId, provider: "remote-docker", collision_domain_id: `docker:${workerId}`,
    platforms: [`${process.platform}-${process.arch}`], backends: [{ id: "harbor", version: "0.21.0" }],
    features: { docker: true, buildkit: true, model_proxy: true, isolated_same_task_attempts: false },
    task_membership: ["known"], capacity: { total: WORK_CAPACITY, reserved_for_system: ZERO, allocatable: WORK_CAPACITY },
  };
}

async function remoteWorkerOnce(root: string, registry: RemoteWorkerRegistry, protocol: RemoteWorkerProtocol, workerId: string): Promise<{ workerId: string; taskId: string }> {
  const registered = await registry.get(workerId);
  const generation = registered?.generation as number;
  const heartbeat = setInterval(() => {
    registry.heartbeat(workerId, {
      schema_version: "1", generation, health: "healthy", allocated: ZERO,
      active_leases: [], sent_at: new Date().toISOString(),
    }).catch(() => undefined);
  }, 1_000);
  heartbeat.unref();
  const offer = await waitForOffer(protocol, workerId);
  assert.deepEqual(new Set(offer.inputs?.map((entry) => entry.kind)), new Set(["work-spec", "harness-artifact", "controller-runtime", "task-input"]));
  const taskInput = offer.inputs?.find((entry) => entry.kind === "task-input");
  const workSpec = offer.inputs?.find((entry) => entry.kind === "work-spec");
  assert.ok(taskInput && workSpec);
  const taskBlob = await protocol.resolveInput(workerId, offer.lease.lease_id, offer.generation, taskInput.digest);
  assert.ok(parseRemoteTreeEnvelope(JSON.parse(await readFile(taskBlob.path, "utf8"))).files.some((file) => file.path === "task.toml"));
  const specBlob = await protocol.resolveInput(workerId, offer.lease.lease_id, offer.generation, workSpec.digest);
  const stagedSpec = JSON.parse(await readFile(specBlob.path, "utf8")) as { request: { dataset: string }; work: { work_id: string }; harness_artifact: Record<string, unknown> };
  assert.equal(stagedSpec.request.dataset, "task-input");
  assert.equal(stagedSpec.work.work_id, offer.work.work_id);
  assert.equal(stagedSpec.harness_artifact.storage, undefined);
  await protocol.acceptOffer(workerId, {
    schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce, generation: offer.generation,
    accepted: true, sent_at: new Date().toISOString(),
  });
  const produced = await writeRemoteBundle(root, offer);
  const body = await encodeRemoteResultEnvelope({
    evalId: offer.work.eval_id, workId: offer.work.work_id, leaseId: offer.lease.lease_id,
    leaseEpoch: offer.lease.epoch, trial: produced.trial, bundleDirectory: produced.directory,
  });
  const digest = sha256Bytes(body);
  await protocol.uploadArtifact({
    workerId, leaseId: offer.lease.lease_id, generation: offer.generation, epoch: offer.lease.epoch,
    digest, expectedSize: body.length, body: (async function* () { yield body; })(),
  });
  await protocol.completeOffer(workerId, {
    schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce, generation: offer.generation,
    lease_id: offer.lease.lease_id, epoch: offer.lease.epoch, status: "succeeded",
    artifacts: [{ kind: "result-bundle", digest, size: body.length }], sent_at: new Date().toISOString(),
  });
  const releasing = await waitFor(async () => {
    const current = await protocol.getOffer(workerId, offer.offer_id);
    const result = await readJSON<Record<string, unknown> | null>(path.join(root, "evals", offer.work.eval_id, "result.json"), null);
    if (result?.status === "failed") throw new Error(`remote eval failed before release: ${JSON.stringify(result)}`);
    return current?.state === "release-requested" || current?.state === "released" ? current : null;
  }, 10_000);
  if (releasing.state !== "released") await protocol.releaseOffer(workerId, {
    schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce, generation: offer.generation,
    lease_id: offer.lease.lease_id, epoch: offer.lease.epoch, sent_at: new Date().toISOString(),
  });
  await registry.heartbeat(workerId, {
    schema_version: "1", generation: offer.generation, health: "healthy", allocated: ZERO, active_leases: [], sent_at: new Date().toISOString(),
  });
  clearInterval(heartbeat);
  return { workerId, taskId: offer.work.task_ids[0] as string };
}

async function waitForOffer(protocol: RemoteWorkerProtocol, workerId: string): Promise<RemoteWorkOfferV1> {
  return waitFor(async () => (await protocol.listOffers(workerId, 1)).find((offer) => offer.state === "offered") ?? null, 180_000);
}

async function writeRemoteBundle(root: string, offer: RemoteWorkOfferV1): Promise<{ directory: string; trial: Record<string, unknown> }> {
  const taskId = offer.work.task_ids[0] as string;
  const trialId = `trial-${taskId}`;
  const runId = `run_${sha256JSON({ lease: offer.lease.lease_id }).slice("sha256:".length, "sha256:".length + 32)}`;
  const directory = path.join(root, "remote-worker-output", offer.worker_id, runId);
  await mkdir(directory, { recursive: true });
  const evalDirectory = path.join(root, "evals", offer.work.eval_id);
  const request = await readJSON<Record<string, unknown>>(path.join(evalDirectory, "request.json"));
  const resolution = await readJSON<Record<string, unknown>>(path.join(evalDirectory, "resolution.json"));
  const plan = await readJSON<Record<string, unknown>>(path.join(evalDirectory, "plan.json"));
  const runtime = plan.controller_runtime as { runtime_id: string };
  const prepared = plan.prepared_artifact as { artifact_id: string };
  const now = new Date().toISOString();
  await atomicWriteJSON(path.join(directory, "request.json"), { schema_version: "1", prompt: "remote", cwd: "/workspace" });
  await atomicWriteJSON(path.join(directory, "resolution.json"), resolution);
  await atomicWriteJSON(path.join(directory, "result.json"), { schema_version: "1", run_id: runId, status: "succeeded", exit_code: 0, completed_at: now });
  await writeFile(path.join(directory, "events.jsonl"), `${JSON.stringify({ schema_version: "1", sequence: 1, timestamp: now, run_id: runId, type: "run.completed" })}\n`);
  await atomicWriteJSON(path.join(directory, "execution.json"), {
    schema_version: "1", provider: offer.lease.provider, worker_id: offer.worker_id,
    collision_domain_id: offer.lease.collision_domain_id, eval_id: offer.work.eval_id, work_id: offer.work.work_id,
    lease_id: offer.lease.lease_id, lease_epoch: offer.lease.epoch, task_id: taskId, reservation: offer.work.reservation,
    enforced: { main_limits: offer.work.reservation, sidecar_limits: {} },
    observed: {
      status: "unavailable", started_at: now, collected_at: now, sample_count: 0, containers: [],
      unavailable_fields: ["cpu_time_ns", "peak_memory_bytes", "exit_status", "image_identity"], issues: ["remote-test-observer-unavailable"],
    },
  });
  await writeTrajectory(directory, runId);
  await atomicWriteJSON(path.join(directory, "manifest.json"), {
    schema_version: "1", run_id: runId, status: "succeeded",
    context: {
      kind: "benchmark_task", benchmark_id: request.benchmark_id, benchmark_revision: request.benchmark_revision,
      task_id: taskId, task_digest: benchmarkTaskDigest(String(request.benchmark_id), String(request.benchmark_revision), taskId),
      verifier_identity: benchmarkVerifierIdentity(String(request.benchmark_id), String(request.benchmark_revision)),
    },
    parent: { kind: "eval", eval_id: offer.work.eval_id, trial_id: trialId, attempt: offer.work.logical_attempt },
    harness: {
      harness_id: resolution.harness_id, requested_ref: request.harness_ref,
      revision_identity: resolution.identity, artifact_id: prepared.artifact_id,
    },
    model: { requested_id: request.model, effective_id: request.model, identity_resolved: false },
    protocol: { timeout_ms: request.timeout_ms, workspace_mode: "shared", environment_identity: runtime.runtime_id },
    request_ref: "request.json", resolution_ref: "resolution.json", result_ref: "result.json", trajectory_ref: "trajectory.ref.json",
    created_at: now, completed_at: now, sealed: true,
  });
  await atomicWriteJSON(path.join(directory, "bundle.complete.json"), { schema_version: "1", run_id: runId, eval_id: offer.work.eval_id, trial_id: trialId });
  return { directory, trial: { task_name: taskId, trial_name: trialId, verifier_result: { rewards: { reward: 1 } } } };
}

async function writeTrajectory(directory: string, runId: string): Promise<void> {
  const projector = new TrajectoryProjector({ runId, cwd: "/workspace", prompt: "remote", model: "", fidelity: "normalized" });
  projector.feed({ type: "session.created", session_id: `session-${runId}` });
  projector.feed({ type: "message.completed", text: "done" });
  const projected = projector.finalize("succeeded");
  const writer = await TrajectoryWriter.open({ runDirectory: directory, cwd: "/workspace", sessionId: projected.header.id, fidelity: projected.fidelity, header: projected.header });
  for (const event of projected.events) writer.append(event);
  const file = await canonicalTrajectoryFileRef(directory, await writer.close());
  await atomicWriteJSON(path.join(directory, "trajectory.ref.json"), trajectoryRefV2({ runId, fidelity: "normalized", files: [file] }));
}

async function writeResourceInspector(root: string): Promise<string> {
  const executable = path.join(root, "fake-resource-inspector");
  const declaration = {
    schema_version: "1", task: {}, verifier: { separate: false }, compose_services: [{ name: "main", replicas: 1 }],
    provider_sidecars: { main_egress: false, verifier_egress: false },
    environment_images: [], environment_image_fallbacks: [], environment_builds: [],
  };
  await writeFile(executable, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(declaration))});\n`, { mode: 0o755 });
  return executable;
}

async function waitFor<T>(probe: () => Promise<T | null | false | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for remote eval state");
    await delay(10);
  }
}
