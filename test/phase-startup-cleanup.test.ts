import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { EvalDockerResourceReaper } from "../src/evals/index.js";
import { buildEvalExecutionPlan, createExecutionLease, deriveTaskResourceRequirement, validateEvalId, validateEvalRequest, verifierOnlyWorkItem } from "../src/evals/index.js";
import { EvalScheduler, ResourceLedger } from "../src/control-plane/index.js";
import { reapStartupDockerResources } from "../src/control-plane/startup-docker-cleanup.js";
import { atomicWriteJSON, hitchRootId } from "../src/foundation/index.js";
import { dockerOwnershipLabelMap, dockerResourceOwnership } from "../src/evals/docker-ownership.js";
import { bindPhaseDockerBackend, preparePhaseDockerExecution } from "../src/evals/phase-docker-backend.js";

const GIB = 1024 ** 3;
const defaults = { cpu_millis: 1_000, memory_bytes: GIB, container_slots: 1, build_slots: 0 };
const evalId = validateEvalId(`eval_${"a".repeat(32)}`);
type Report = Awaited<ReturnType<EvalDockerResourceReaper>>;
function clean(root: string): Report { return { schema_version: "1", root_id: hitchRootId(root), scanned: 0, deleted: [], retained: [], issues: [] }; }

async function history(root: string, phaseEnvelope = true, profiled = false) {
  const request = await validateEvalRequest({ dataset: "demo@1.0", harness_ref: "pi@version:1.2.3", max_concurrent: 1 });
  const requirement = deriveTaskResourceRequirement({ taskId: "task-a", defaultResources: defaults, defaultSource: "operator-default", phaseEnvelope,
    declaration: { schema_version: "1", task: { cpu_millis: 1000, memory_bytes: 2 * GIB },
      verifier: { separate: true, environment: { cpu_millis: 1000, memory_bytes: 2 * GIB } },
      compose_services: [{ name: "main", replicas: 1 }, { name: "simulator", replicas: 1 }], verifier_compose_services: [{ name: "main", replicas: 1 }],
      provider_sidecars: { main_egress: false, verifier_egress: false }, environment_images: [], environment_image_fallbacks: [], environment_builds: [],
      lifecycle: { contract: "harbor-native-docker-single-step-v1", capability: "phase-exclusive-teardown-v1", verifier_mode: "separate",
        verifier_dependencies: { inputs: "artifacts-only", live_services: [], artifacts: [{ service: "simulator", path: "/snapshot.json" }] } } } });
  const plan = buildEvalExecutionPlan({ evalId, request,
    candidate: { revisionIdentity: `sha256:${"b".repeat(64)}`, artifactId: `sha256:${"c".repeat(64)}` },
    tasks: ["task-a"], taskResources: [requirement], maxParallelism: 1, workItemMode: "task-slots",
    ...(profiled ? { resourceProfiling: { schema_version: "1" as const, unknown_max_parallelism: 1, requested_parallelism: 1, scope: "worker" as const, approvals: [] } } : {}) });
  const evalDirectory = path.join(root, "evals", evalId);
  await atomicWriteJSON(path.join(evalDirectory, "execution-plan.json"), plan);
  await atomicWriteJSON(path.join(evalDirectory, "result.json"), { status: "failed" });
  const rerunId = `rerun_${"d".repeat(32)}`;
  await atomicWriteJSON(path.join(evalDirectory, "reruns", rerunId, "state.json"), { status: "failed" });
  const source = plan.work_items[0]!;
  const verifier = verifierOnlyWorkItem(source, rerunId, `assessment_${"e".repeat(32)}`, plan);
  const worker = { workerId: "local", provider: "local-docker", collisionDomainId: "local-docker" };
  const leases = [];
  for (const work of [source, verifier]) {
    const lease = await createExecutionLease({ evalDirectory, evalId, workId: work.work_id, worker, reservation: work.reservation, ttlMs: 45_000 });
    await preparePhaseDockerExecution({ root, lease: lease.current() });
    await lease.markRunning(); await lease.release(); leases.push(lease);
  }
  return { evalDirectory, leases };
}

test("terminal phase eval and regrade leases require a confirmed startup sweep even after release", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-phase-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await history(root);
  const events: Record<string, unknown>[] = [], emit = (event: Record<string, unknown>) => { events.push(event); };
  for (const report of [
    { ...clean(root), issues: [{ kind: "container" as const, stage: "list" as const, message: "offline" }] },
    { ...clean(root), issues: [{ kind: "container" as const, stage: "delete" as const, id: "old", message: "stop failed" }] },
    { ...clean(root), retained: [{ kind: "container" as const, id: "old", reason: "ownership uncertain" }] },
    { ...clean(root), root_id: "different" },
  ]) await assert.rejects(reapStartupDockerResources({ root, env: {}, emit, reaper: async () => report }), { code: "phase_cleanup_unconfirmed" });
  await assert.rejects(reapStartupDockerResources({ root, env: {}, emit, reaper: async () => { throw new Error("Docker disconnected"); } }),
    { code: "phase_cleanup_unconfirmed" });
  await reapStartupDockerResources({ root, env: { HITCH_DOCKER_PATH: "/selected/docker" }, emit, reaper: async input => {
    assert.equal(input.env?.HITCH_DOCKER_PATH, "/selected/docker"); return clean(root);
  } });
  assert.ok(events.some(event => event.code === "phase_cleanup_unconfirmed"));
});

test("an empty Docker listing cannot settle a phase host process with unconfirmed lease state", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-phase-active-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { evalDirectory, leases } = await history(root);
  for (const state of ["lost", "expired", "running", "accepted", "releasing"] as const) {
    const { terminal_at: _terminal, ...base } = leases[1]!.current();
    const terminal = state === "lost" || state === "expired";
    await atomicWriteJSON(path.join(evalDirectory, "leases", `${base.lease_id}.json`), { ...base, state,
      ...(terminal ? { terminal_at: new Date().toISOString() } : {}) });
    await assert.rejects(reapStartupDockerResources({ root, env: {}, emit: () => {}, reaper: async () => clean(root) }),
      { code: "phase_cleanup_unconfirmed" });
  }
});

test("legacy-only history preserves optional startup cleanup behavior", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-legacy-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await history(root, false);
  await assert.doesNotReject(reapStartupDockerResources({ root, env: {}, emit: () => {}, reaper: async () => { throw new Error("Docker unavailable"); } }));
});

test("profiled V1 history cannot reopen unknown slots after failed cleanup or missing binding", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-profiled-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { evalDirectory, leases } = await history(root, false, true);
  const input = { root, env: {}, emit: () => {}, reaper: async () => clean(root) };
  await assert.rejects(reapStartupDockerResources({ ...input, reaper: async () => ({ ...clean(root),
    issues: [{ kind: "container", stage: "delete", message: "cannot stop" }] }) }), { code: "phase_cleanup_unconfirmed" });
  await reapStartupDockerResources(input);
  await rm(path.join(evalDirectory, "leases", `${leases[1]!.leaseId}.docker-binding.json`));
  await assert.rejects(reapStartupDockerResources(input), { code: "phase_cleanup_unconfirmed" });
});

test("startup rejects a switched daemon for terminal eval/regrade receipts until exact cleanup is fenced", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-phase-backend-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { evalDirectory, leases } = await history(root);
  const parents = [path.join(evalDirectory, "harbor", "work-items", leases[0]!.current().work_id, "epoch-000001", "job"),
    path.join(evalDirectory, "assessments", `assessment_${"e".repeat(32)}`, "evidence", "trials")];
  for (const [index, lease] of leases.entries()) await atomicWriteJSON(path.join(parents[index]!, "trial", "hitch-phase-resources-agent.json"), {
    schema_version: "1", role: "agent", docker_backend_id: "original-docker", containers: [],
    ownership: dockerOwnershipLabelMap(dockerResourceOwnership(root, lease.current(), "task-a")),
  });
  const docker = path.join(root, "docker"), identity = path.join(root, "docker-id");
  await writeFile(docker, '#!/bin/sh\ncat "$PHASE_DOCKER_ID_FILE"\n', { mode: 0o755 });
  const env = { ...process.env, HITCH_DOCKER_PATH: docker, PHASE_DOCKER_ID_FILE: identity, DOCKER_CONTEXT: "fixture" };
  await writeFile(identity, "original-docker");
  for (const lease of leases) await bindPhaseDockerBackend({ root, lease: lease.current(), env });
  let sweeps = 0;
  const input = { root, env, emit: () => {}, reaper: async () => { sweeps++; return clean(root); } };
  await writeFile(identity, "switched-docker");
  await assert.rejects(reapStartupDockerResources(input), { code: "phase_cleanup_unconfirmed" });
  assert.equal(sweeps, 0);
  await writeFile(identity, "original-docker");
  await assert.rejects(reapStartupDockerResources({ ...input, reaper: async () => { await writeFile(identity, "switched-docker"); return clean(root); } }),
    { code: "phase_cleanup_unconfirmed" });
  await writeFile(identity, "original-docker");
  await reapStartupDockerResources(input);
  await writeFile(identity, "switched-docker");
  await reapStartupDockerResources(input);
  assert.equal(sweeps, 2);
});

test("startup protects V2 work with no Python receipts using its independent binding", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-phase-controller-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { evalDirectory, leases } = await history(root);
  const docker = path.join(root, "docker"), identity = path.join(root, "docker-id");
  await writeFile(docker, '#!/bin/sh\ncat "$PHASE_DOCKER_ID_FILE"\n', { mode: 0o755 });
  const env = { ...process.env, HITCH_DOCKER_PATH: docker, PHASE_DOCKER_ID_FILE: identity, DOCKER_CONTEXT: "fixture" };
  await writeFile(identity, "original-docker");
  for (const lease of leases) await bindPhaseDockerBackend({ root, lease: lease.current(), env });
  const input = { root, env, emit: () => {}, reaper: async () => clean(root) };
  await writeFile(identity, "switched-docker");
  await assert.rejects(reapStartupDockerResources(input), { code: "phase_cleanup_unconfirmed" });
  await writeFile(identity, "original-docker");
  await reapStartupDockerResources(input);
  await rm(path.join(evalDirectory, "leases", `${leases[0]!.leaseId}.docker-binding.json`));
  await assert.rejects(reapStartupDockerResources(input), { code: "phase_cleanup_unconfirmed" });
});

test("scheduler cannot drain queued work while phase startup cleanup is pending or failed", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-phase-startup-fence-"));
  await history(root);
  const ledger = new ResourceLedger({ ...defaults, memory_bytes: 8 * GIB, cpu_millis: 8000, container_slots: 8 });
  let finish!: (value: Report) => void, started!: () => void, launches = 0;
  const sweeping = new Promise<void>(resolve => { started = resolve; });
  const report = new Promise<Report>(resolve => { finish = resolve; });
  const scheduler = new EvalScheduler({ root, resources: ledger, trialResources: defaults,
    dockerResourceReaper: async () => { started(); return report; }, executor: async () => { launches++; throw new Error("unexpected dispatch"); } });
  t.after(async () => { await scheduler.shutdown(); await rm(root, { recursive: true, force: true }); });
  const initialization = scheduler.initialize();
  const rejected = assert.rejects(initialization, { code: "phase_cleanup_unconfirmed" });
  await sweeping;
  const queued = await scheduler.submit({ dataset: "demo@1.0", harness_ref: "pi@version:1.2.3", max_concurrent: 1 });
  ledger.tryAcquire("wake-up", "eval", defaults)!.release();
  await setImmediate();
  assert.equal(launches, 0);
  finish({ ...clean(root), retained: [{ kind: "container", id: "old", reason: "not cleaned" }] });
  await rejected;
  ledger.tryAcquire("wake-after-failure", "eval", defaults)!.release();
  await setImmediate();
  assert.equal(launches, 0);
  assert.equal(scheduler.snapshot().running, 0);
  await scheduler.shutdown();
  assert.equal((await scheduler.status(queued))?.control.state, "queued");
});
