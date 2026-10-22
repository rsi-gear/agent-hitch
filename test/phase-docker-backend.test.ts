import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteJSON, hitchRootId } from "../src/foundation/index.js";
import { createExecutionLease } from "../src/evals/execution-leases.js";
import { dockerOwnershipLabelMap, dockerResourceOwnership } from "../src/evals/docker-ownership.js";
import { confirmPhaseResourceCleanup } from "../src/evals/phase-resource-cleanup.js";
import { bindPhaseDockerBackend, confirmPhaseDockerBackend, phaseReceiptTrialParents, preparePhaseDockerExecution, readPhaseDockerBindings } from "../src/evals/phase-docker-backend.js";

const evalId = `eval_${"a".repeat(32)}`;
const workId = `work_${"b".repeat(32)}`;
const backendA = "docker-daemon-original", backendB = "docker-daemon-switched";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-phase-daemon-"));
  const evalDirectory = path.join(root, "evals", evalId);
  const lease = await createExecutionLease({ evalDirectory, evalId, workId, ttlMs: 45_000,
    worker: { workerId: "local", provider: "local-docker", collisionDomainId: "local" },
    reservation: { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 } });
  await lease.markRunning(); await lease.release();
  const parent = path.join(evalDirectory, "harbor", "work-items", workId, "epoch-000001", "job");
  const receiptPath = path.join(parent, "trial", "hitch-phase-resources-agent.json");
  const receipt = { schema_version: "1", role: "agent", docker_backend_id: backendA, containers: [],
    ownership: dockerOwnershipLabelMap(dockerResourceOwnership(root, lease.current(), "task-a")) };
  await atomicWriteJSON(receiptPath, receipt);
  const docker = path.join(root, "docker"), identity = path.join(root, "docker-id");
  await writeFile(docker, '#!/bin/sh\nif [ "$1" = info ]; then cat "$PHASE_DOCKER_ID_FILE"; fi\n', { mode: 0o755 });
  await writeFile(identity, backendA);
  const env = { ...process.env, HITCH_DOCKER_PATH: docker, PHASE_DOCKER_ID_FILE: identity, DOCKER_CONTEXT: "fixture" };
  const clean = { schema_version: "1" as const, root_id: hitchRootId(root), scanned: 0, deleted: [], retained: [], issues: [] };
  const input = { root, lease: lease.current(), env, trialParents: [parent] };
  return { root, evalDirectory, lease, parent, receiptPath, receipt, identity, env, clean, input };
}

test("empty cleanup on a different Docker daemon is rejected before sweeping", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(f.identity, backendB);
  let swept = false;
  await assert.rejects(confirmPhaseResourceCleanup({ ...f.input, reaper: async () => { swept = true; return f.clean; } }),
    { code: "phase_transition_unconfirmed" });
  assert.equal(swept, false);
});

test("Docker context switching during an empty sweep does not write a cleanup fence", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await assert.rejects(confirmPhaseResourceCleanup({ ...f.input, reaper: async () => { await writeFile(f.identity, backendB); return f.clean; } }),
    { code: "phase_transition_unconfirmed" });
  const bindings = await readPhaseDockerBindings({ root: f.root, leases: [f.lease.current()], trialParents: [f.parent], useCleanupFences: true });
  assert.equal(bindings[0]!.confirmed, false);
});

test("successful cleanup fences only its exact receipt and authorized resource epochs", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await confirmPhaseResourceCleanup({ ...f.input, reaper: async () => f.clean });
  await writeFile(f.identity, backendB);
  const load = () => readPhaseDockerBindings({ root: f.root, leases: [f.lease.current()], trialParents: [f.parent], useCleanupFences: true });
  const bindings = await load();
  assert.equal(bindings[0]!.confirmed, true);
  await confirmPhaseDockerBackend(bindings, f.env);
  await atomicWriteJSON(f.receiptPath, { ...f.receipt, failure: "later receipt revision" });
  assert.equal((await load())[0]!.confirmed, false);
  await assert.rejects(confirmPhaseDockerBackend(await load(), f.env), /backend changed/);
  await atomicWriteJSON(f.receiptPath, { ...f.receipt, ownership: { ...f.receipt.ownership, "io.hitch.lease-epoch": "2" } });
  await assert.rejects(load(), /ownership/);
});

test("startup receipt discovery covers work, physical retry, candidate restart, and assessment layouts only", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const backendPaths = [
    path.join(f.evalDirectory, "harbor", "work-items", workId, "infrastructure-retries", "retry-0001", "harbor", "job"),
    path.join(f.evalDirectory, "reruns", `rerun_${"c".repeat(32)}`, "harbor", "work-items", workId, "epoch-000001", "job"),
    path.join(f.evalDirectory, "assessments", `assessment_${"d".repeat(32)}`, "evidence", "trials"),
  ];
  for (const parent of backendPaths) await atomicWriteJSON(path.join(parent, "trial", "hitch-phase-resources-agent.json"), f.receipt);
  await atomicWriteJSON(path.join(f.parent, "trial", "artifacts", "hitch-phase-resources-agent.json"), { poison: true });
  const parents = await phaseReceiptTrialParents(f.root, evalId, [f.lease.current()]);
  for (const parent of [f.parent, ...backendPaths]) assert.ok(parents.includes(parent));
  assert.equal((await readPhaseDockerBindings({ root: f.root, leases: [f.lease.current()], trialParents: parents })).length, 1);
});

test("receipt before backend binding proves no resources only when its container list is empty", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await atomicWriteJSON(f.receiptPath, { ...f.receipt, docker_backend_id: null });
  await confirmPhaseResourceCleanup({ ...f.input, env: { HITCH_DOCKER_PATH: "/missing/docker" }, reaper: async () => f.clean });
  await atomicWriteJSON(f.receiptPath, { ...f.receipt, docker_backend_id: null, containers: [{ id: "unproven" }] });
  await assert.rejects(confirmPhaseResourceCleanup({ ...f.input, reaper: async () => f.clean }), { code: "phase_transition_unconfirmed" });
});

test("independent V2 binding protects shared work without any Python receipt and cannot be reset by another epoch", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await rm(f.receiptPath);
  const load = () => readPhaseDockerBindings({ root: f.root, leases: [f.lease.current()], trialParents: [f.parent], useCleanupFences: true });
  await assert.rejects(load(), /binding is missing/);
  await preparePhaseDockerExecution({ root: f.root, lease: f.lease.current() });
  await confirmPhaseResourceCleanup({ ...f.input, env: { HITCH_DOCKER_PATH: "/unavailable/docker" }, reaper: async () => f.clean });
  await bindPhaseDockerBackend({ root: f.root, lease: f.lease.current(), env: f.env });
  await writeFile(f.identity, backendB);
  const nextEpoch = { ...f.lease.current(), epoch: 2, resource_epochs: [1, 2] };
  await preparePhaseDockerExecution({ root: f.root, lease: nextEpoch });
  await assert.rejects(bindPhaseDockerBackend({ root: f.root, lease: nextEpoch, env: f.env }), /backend changed/);
  await assert.rejects(confirmPhaseResourceCleanup({ ...f.input, reaper: async () => f.clean }), { code: "phase_transition_unconfirmed" });
  await writeFile(f.identity, backendA);
  await confirmPhaseResourceCleanup({ ...f.input, reaper: async () => f.clean });
  assert.equal((await load())[0]!.confirmed, true);
  await atomicWriteJSON(f.receiptPath, { ...f.receipt, docker_backend_id: backendB });
  await assert.rejects(load(), /more than one Docker backend/);
});

test("a not-started marker cannot excuse a recorded backend launch without binding", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await rm(f.receiptPath);
  await preparePhaseDockerExecution({ root: f.root, lease: f.lease.current() });
  await atomicWriteJSON(path.join(f.evalDirectory, "provider", "leases", `${f.lease.leaseId}.json`), { state: "terminal" });
  await assert.rejects(confirmPhaseResourceCleanup({ ...f.input, reaper: async () => f.clean }), { code: "phase_transition_unconfirmed" });
});

test("backend launch and an entire cleanup sweep pin the selected Docker context", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await rm(f.receiptPath);
  const currentContext = path.join(f.root, "current-context");
  await writeFile(currentContext, "context-a");
  await writeFile(f.env.HITCH_DOCKER_PATH, '#!/bin/sh\nif [ "$1" = context ]; then cat "$PHASE_CONTEXT_FILE"; else\nif [ "$DOCKER_CONTEXT" = context-a ]; then echo docker-daemon-original; else echo docker-daemon-switched; fi\nfi\n', { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...f.env, PHASE_CONTEXT_FILE: currentContext };
  delete env.DOCKER_CONTEXT; delete env.DOCKER_HOST;
  await preparePhaseDockerExecution({ root: f.root, lease: f.lease.current() });
  const backendEnv = await bindPhaseDockerBackend({ root: f.root, lease: f.lease.current(), env });
  assert.equal(backendEnv.DOCKER_CONTEXT, "context-a");
  await confirmPhaseResourceCleanup({ ...f.input, env, reaper: async input => {
    assert.equal(input.env?.DOCKER_CONTEXT, "context-a");
    await writeFile(currentContext, "context-b");
    return f.clean;
  } });
});
