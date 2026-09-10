import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CollisionLockManager, RemoteWorkerRegistry, RemoteWorkerProtocol, RemoteWorkerHttpClient, remoteExecutionBindingDigest } from "../src/control-plane/index.js";
import { RemoteWorkCoordinator } from "../src/control-plane/remote-work-coordinator.js";
import { handleRemoteWorkRoute } from "../src/daemon/worker-routes.js";
import { encodeRemoteVerifierResultEnvelope } from "../src/control-plane/remote-verifier-result.js";
import { parseRemoteHarborWorkSpec } from "../src/workers/remote-harbor-work-spec.js";
import { readExecutionLeases, readEvalProgress, rerunEval, remoteVerifierTrialName, readRemoteRerunCompletion } from "../src/evals/index.js";
import { atomicWriteJSON, delay, readJSON, sha256JSON } from "../src/foundation/index.js";
import { verifyResultBundleIndex } from "../src/runs/index.js";
import { remoteVerifierFixture } from "../test-support/remote-verifier.js";
import { writeRemoteVerifierProcess } from "../test-support/remote-verifier-process.js";
import { remoteHarborWorker } from "../src/workers/index.js";

for (const mode of ["success", "invalid", "release-lost", "generation-cleanup"] as const) test(`remote verifier rerun dispatches scoring and recovers ${mode}`, async t => {
  const interruptedRelease = mode === "release-lost" || mode === "generation-cleanup";
  const f = await remoteVerifierFixture(t, 60_000, true); await f.owner.release();
  const registry = new RemoteWorkerRegistry({ root: f.root }), protocol = new RemoteWorkerProtocol({ root: f.root, registry });
  await registry.initialize(); await protocol.initialize();
  const registration = { schema_version: "1", worker_id: "worker_scoring", provider: f.plan.provider, collision_domain_id: "scoring-engine",
    platforms: [f.artifact!.platform], backends: [{ id: "harbor", version: "0.21.0" }],
    features: { docker: true, buildkit: false, model_proxy: false, isolated_same_task_attempts: false, physical_work: "2", verifier_only: "2" },
    task_membership: ["known"], capacity: { total: f.work.reservation, allocatable: f.work.reservation,
      reserved_for_system: { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 } } };
  const registered = await registry.register(registration);
  const server = http.createServer((request, response) => {
    void handleRemoteWorkRoute({ request, response, url: new URL(request.url!, "http://localhost"), registry, protocol, adminToken: "a".repeat(64) })
      .then(handled => { if (!handled) { response.writeHead(404); response.end(); } }).catch(error => {
        response.writeHead(409, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { code: error.code, message: error.message } }));
      });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const client = new RemoteWorkerHttpClient({ baseUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
    credential: { schema_version: "1", worker_id: registered.worker.worker.worker_id, generation: registered.worker.generation, token: registered.token } });
  const coordinator = new RemoteWorkCoordinator({ root: f.root, registry, protocol, collisions: new CollisionLockManager(), pollIntervalMs: 50, releaseTimeoutMs: interruptedRelease ? 200 : 5000 });
  const rerunId = f.physical.rerun_id, rerunDirectory = path.join(f.evalDirectory, "reruns", rerunId);
  const before = sha256JSON(await verifyResultBundleIndex(f.runDirectory));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("scoring test timeout")), 15_000); t.after(() => clearTimeout(timeout));
  let dispatches = 0;
  const options = { root: f.root, evalId: f.evalId, rerunId, signal: controller.signal, rerunType: "verifier-only" as const, selector: { mode: "invalid" as const },
    executionWorker: { provider: f.plan.provider, workerId: "controller", collisionDomainId: "controller" },
    remoteWorkExecutor: async (input: Parameters<typeof coordinator.execute>[0]) => {
      dispatches++; assert.equal(input.modelTarget, undefined); assert.equal(input.modelCapturePlan, undefined);
      assert.ok(input.verifierOnly); return coordinator.execute(input);
    } };
  const worker = (async () => {
    const offer = await waitFor(async () => (await client.listOffers()).find(item => item.state === "offered"));
    assert.equal(offer.inputs?.length, 6); assert.deepEqual(offer.credential_names ?? [], []);
    const inputs = await Promise.all(offer.inputs!.map(async ref => [ref.kind, await client.downloadInput(offer, ref)] as const));
    const spec = parseRemoteHarborWorkSpec(JSON.parse(inputs.find(([kind]) => kind === "work-spec")![1].toString()), offer);
    assert.equal(spec.schema_version, "2"); if (spec.schema_version !== "2" || !spec.verifier_only) throw new Error("scoring spec missing");
    const descriptor = spec.verifier_only;
    const accepted = mode === "generation-cleanup" ? await protocol.acceptOffer(offer.worker_id,
      { schema_version: "1", offer_id: offer.offer_id, generation: offer.generation, nonce: offer.nonce, accepted: true, sent_at: new Date().toISOString() },
      { schema_version: "2", binding_digest: remoteExecutionBindingDigest(offer), root_id: "a".repeat(24), root_digest: sha256JSON("scoring-root"),
        boot_digest: sha256JSON("scoring-boot"), docker_engine_id: "scoring-engine",
        worker_process: { pid: 1001, start_identity: sha256JSON("scoring-worker"), observed_at: new Date().toISOString() } }) : await client.accept(offer);
    const lease = await waitFor(async () => { const value = await client.executionLease(accepted, new AbortController().signal); return value.state === "running" ? value : undefined; });
    let body: Buffer, release: (() => Promise<void>) | undefined;
    if (mode === "success") {
      const processFixture = await writeRemoteVerifierProcess(f.root);
      const outcome = await remoteHarborWorker({ root: path.join(f.root, "worker-state"), env: processFixture.env,
        harborExecutable: processFixture.harbor, dockerExecutable: processFixture.docker })({ offer: accepted, inputs: new Map(inputs),
        credentials: new Map(), signal: controller.signal, emit: async () => {}, readExecutionLease: signal => client.executionLease(accepted, signal) });
      assert.equal(outcome.status, "succeeded", outcome.artifacts?.filter(a => a.kind === "diagnostic").map(a => a.body.toString()).join("\n"));
      assert.equal(outcome.artifacts?.length, 1); body = outcome.artifacts![0]!.body; release = outcome.release;
    } else {
    const verifierDirectory = path.join(f.root, "worker-output/verifier"); await mkdir(verifierDirectory, { recursive: true });
    await writeFile(path.join(verifierDirectory, "test-stdout.txt"), "scoring only\n");
    const trial = { ...descriptor.source_trial, trial_name: remoteVerifierTrialName(descriptor.assessment_id), agent_setup: null, agent_execution: null,
      ...(mode === "invalid" ? {} : { verifier_result: { rewards: { reward: 1, total_score: 1 } } }) };
    body = await encodeRemoteVerifierResultEnvelope({ lease, verifier: descriptor, verifierDirectory, outcome: { trial,
      backend: { process_exit_code: 0, signal: null }, execution: { ...f.execution, work_id: lease.work_id, lease_id: lease.lease_id,
        lease_epoch: lease.epoch, worker_id: lease.worker_id, collision_domain_id: lease.collision_domain_id },
      source_manifest_digest: sha256JSON(descriptor.source_manifest), candidate_result_digest: sha256JSON(descriptor.candidate_result),
      config_digest: sha256JSON("worker-config"), controller_runtime_id: descriptor.verifier_runtime_id, trial_directory: path.dirname(verifierDirectory) } });
    }
    const artifact = await client.uploadArtifact(accepted, "result-bundle", body);
    await client.complete(accepted, "succeeded", [artifact]);
    const releasing = await waitFor(async () => (await client.listOffers()).find(item => item.offer_id === offer.offer_id && item.state === "release-requested"));
    if (!interruptedRelease) { await release?.(); await client.release(releasing); }
    return { offer: releasing, descriptor };
  })().catch(error => { controller.abort(error); throw error; });
  // Observe both branches so setup failures do not leave an unhandled worker rejection.
  const [controllerResult, workerResult] = await Promise.allSettled([rerunEval(options), worker]);
  if (controllerResult.status === "rejected") t.diagnostic(String(controllerResult.reason));
  assert.equal(workerResult.status, "fulfilled", workerResult.status === "rejected" ? String(workerResult.reason) : "");
  if (workerResult.status !== "fulfilled") return;
  const journalFile = path.join(rerunDirectory, "remote-work", `${workerResult.value.offer.work.work_id}.json`);
  let journal = await readJSON<Record<string, unknown>>(journalFile);
  if (interruptedRelease) {
    assert.equal(controllerResult.status, "rejected");
    assert.equal((controllerResult as PromiseRejectedResult).reason.code, "worker_release_timeout");
    assert.equal(journal.state, "collected"); assert.ok(journal.result, "terminal callback must preserve the result before release");
    const frozenResult = sha256JSON(journal.result);
    if (mode === "generation-cleanup") {
      const offer = workerResult.value.offer, next = await registry.register(registration), original = sha256JSON(offer);
      const challenge = (await protocol.generationCleanup.challenge(offer.worker_id, offer.offer_id, next.worker.generation)).challenge!;
      await protocol.generationCleanup.commit(offer.worker_id, offer.offer_id, next.worker.generation, { schema_version: "2", challenge,
        observed_at: new Date().toISOString(), observation: { ownership: challenge.admission.ownership, execution_process: null,
          worker_status: "terminal", process_group_empty: true, docker_resources_empty: true } });
      assert.equal((await readExecutionLeases(f.evalDirectory)).find(lease => lease.lease_id === offer.lease.lease_id)!.release_confirmation?.schema_version, "3");
      await coordinator.reconcileReleasedLeases({ evalId: f.evalId, evalDirectory: f.evalDirectory, provider: f.plan.provider });
      assert.equal(sha256JSON(await protocol.getOffer(offer.worker_id, offer.offer_id)), original);
    } else {
      await client.release(workerResult.value.offer);
      const recovered = await coordinator.recoverEvalLeases({ evalId: f.evalId, evalDirectory: f.evalDirectory, leases: await readExecutionLeases(f.evalDirectory), emit: () => {} });
      assert.equal(recovered.status, "resumable", recovered.message);
    }
    journal = await readJSON(journalFile); assert.equal(journal.state, "completed"); assert.equal(sha256JSON(journal.result), frozenResult);
  } else {
    assert.equal(controllerResult.status, "fulfilled", controllerResult.status === "rejected" ? String(controllerResult.reason) : "");
    assert.equal(journal.state, "completed");
    assert.ok(await readRemoteRerunCompletion(rerunDirectory, f.evalId, rerunId));
  }
  const progress = await readEvalProgress(f.evalDirectory); assert.equal(progress?.trials[0]?.observation_status, mode === "invalid" ? "invalid" : "valid");
  const generation = progress!.generation;
  // Recreate an interrupted outer journal; physical work and immutable selection remain authoritative.
  const state = await readJSON<Record<string, unknown>>(path.join(rerunDirectory, "state.json"));
  await atomicWriteJSON(path.join(rerunDirectory, "state.json"), { ...state, status: "running" });
  const replay = await rerunEval({ ...options, resumeRemoteRerun: true });
  assert.equal(replay.eval_status, mode === "invalid" ? "failed" : "succeeded"); assert.equal(dispatches, 1);
  assert.equal((await readEvalProgress(f.evalDirectory))?.generation, generation);
  assert.equal(sha256JSON(await verifyResultBundleIndex(f.runDirectory)), before);
  assert.deepEqual(await readdir(path.join(f.root, "runs")), [f.runId]);
  assert.deepEqual(await readdir(path.join(f.evalDirectory, "assessments")), [workerResult.value.descriptor.assessment_id]);
});

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { const value = await read(); if (value !== undefined) return value; await delay(50); }
  throw new Error("remote scoring test timed out");
}
