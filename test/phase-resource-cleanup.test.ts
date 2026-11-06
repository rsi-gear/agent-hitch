import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EvalRequest } from "../src/domain/index.js";
import { ResourceLedger, WorkItemDispatcher } from "../src/control-plane/index.js";
import { hitchRootId } from "../src/foundation/index.js";
import { buildEvalExecutionPlan } from "../src/evals/execution-plan.js";
import { deriveTaskResourceRequirement } from "../src/evals/task-resources.js";
import { confirmPhaseResourceCleanup } from "../src/evals/phase-resource-cleanup.js";
import { executePlannedHarborTasks } from "../src/evals/planned-execution.js";
import type { ExecutePlannedHarborOptions } from "../src/evals/planned-execution.js";
import { beginPlannedInfrastructureRetry } from "../src/evals/planned-retry-lifecycle.js";
import { createEvalProgress } from "../src/evals/progress.js";
import { EvalEventSink } from "../src/evals/events.js";
import { validateEvalId } from "../src/evals/request.js";
import type { DockerReaperReportV1 } from "../src/evals/docker-reaper.js";
import { createExecutionLease } from "../src/evals/execution-leases.js";
import { bindPhaseDockerBackend, preparePhaseDockerExecution } from "../src/evals/phase-docker-backend.js";
import { finishPlannedLocalWork } from "../src/evals/planned-work-cleanup.js";
import { installEmptyDockerBackendForTest } from "../test-support/empty-docker-backend.js";

const GIB = 1024 ** 3;
const evalId = validateEvalId(`eval_${"a".repeat(32)}`);
const artifactId = `sha256:${"c".repeat(64)}` as const;
const request: EvalRequest = { schema_version: "1", backend: "harbor", dataset: "/tasks", harness_ref: "pi@version:1.2.3", model: "test/model",
  attempts: 1, max_concurrent: 2, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0, timeout_ms: 0, setup_timeout_ms: 0,
  agent_args: [], pass_env: [], benchmark_id: "fixture", benchmark_revision: "fixture" };
function plan(shared = false, profiledV1 = false) {
  const taskResources = ["one", "two"].map(taskId => deriveTaskResourceRequirement({ taskId,
    defaultResources: { cpu_millis: 1000, memory_bytes: GIB, container_slots: 1, build_slots: 0 }, defaultSource: "operator-default", phaseEnvelope: !profiledV1,
    declaration: { schema_version: "1", task: { cpu_millis: 1000, memory_bytes: 2 * GIB },
      verifier: shared ? { separate: false } : { separate: true, environment: { cpu_millis: 1000, memory_bytes: 2 * GIB } },
      compose_services: [{ name: "main", replicas: 1 }, { name: "simulator", replicas: 1 }],
      verifier_compose_services: shared ? [] : [{ name: "main", replicas: 1 }], provider_sidecars: { main_egress: false, verifier_egress: false },
      environment_images: [], environment_image_fallbacks: [], environment_builds: [],
      lifecycle: { contract: "harbor-native-docker-single-step-v1", capability: "phase-exclusive-teardown-v1", verifier_mode: shared ? "shared" : "separate",
        verifier_dependencies: { inputs: shared ? "backend-defined" : "artifacts-only", live_services: [], artifacts: [] } } },
  }));
  return buildEvalExecutionPlan({ evalId, request, candidate: { revisionIdentity: `sha256:${"b".repeat(64)}`, artifactId },
    maxParallelism: 2, tasks: taskResources.map(r => r.task_id), taskResources, workItemMode: "task-slots", provider: "local-docker",
    ...(profiledV1 ? { resourceProfiling: { schema_version: "1" as const, unknown_max_parallelism: 1, requested_parallelism: 2, scope: "worker" as const, approvals: [] } } : {}),
    createdAt: "2026-10-21T00:00:00.000Z" });
}
function clean(root: string): DockerReaperReportV1 {
  return { schema_version: "1", root_id: hitchRootId(root), scanned: 0, deleted: [], retained: [], issues: [] };
}
async function fixture(root: string, shared = false, profiledV1 = false): Promise<ExecutePlannedHarborOptions> {
  const evalDirectory = path.join(root, "evals", evalId);
  const sink = new EvalEventSink(evalDirectory, evalId); await sink.open();
  return { root, evalId, evalDirectory, plan: plan(shared, profiledV1), request, sink,
    progress: createEvalProgress({ evalId, benchmarkId: "fixture", benchmarkRevision: "fixture", plannedTasks: 2, plannedTrials: 2, startedAt: "2026-10-21T00:00:00.000Z" }),
    // Backend discovery intentionally fails before launching anything. The
    // cleanup/admission lifecycle still needs to handle its own failure safely.
    resolvedRevision: {} as ExecutePlannedHarborOptions["resolvedRevision"],
    controllerRuntime: {} as ExecutePlannedHarborOptions["controllerRuntime"],
    preparedArtifact: { artifact_id: artifactId } as ExecutePlannedHarborOptions["preparedArtifact"],
    worker: { workerId: "worker-test", provider: "local-docker", collisionDomainId: "test" },
    harborExecutable: path.join(root, "missing-harbor"), env: { ...process.env, HITCH_DOCKER_PATH: "/usr/bin/true" },
  };
}

test("phase cleanup accepts zero removals and unrelated leases, and rejects issues, retained owned resources and exceptions", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hitch-phase-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handle = await createExecutionLease({ evalDirectory: path.join(root, "evals", evalId), evalId, workId: plan().work_items[0]!.work_id,
    worker: { workerId: "local", provider: "local-docker", collisionDomainId: "local" }, reservation: plan().work_items[0]!.reservation, ttlMs: 45_000 });
  await handle.release();
  await preparePhaseDockerExecution({ root, lease: handle.current() });
  const env = { ...process.env }; await installEmptyDockerBackendForTest(root, env);
  await bindPhaseDockerBackend({ root, lease: handle.current(), env });
  const input = { root, lease: handle.current(), trialParents: [], env };
  await confirmPhaseResourceCleanup({ ...input, reaper: async () => clean(root) });
  await confirmPhaseResourceCleanup({ ...input, reaper: async () => ({ ...clean(root), retained: [{ kind: "container", id: "other", reason: "lease_not_selected" }] }) });
  for (const reaper of [
    async () => ({ ...clean(root), root_id: "wrong-root" }),
    async () => ({ ...clean(root), issues: [{ kind: "container" as const, stage: "list" as const, message: "unavailable" }] }),
    async () => ({ ...clean(root), retained: [{ kind: "container" as const, id: "owned", reason: "lease is not terminal" }] }),
    async (): Promise<DockerReaperReportV1> => { throw new Error("daemon unavailable"); },
  ]) await assert.rejects(confirmPhaseResourceCleanup({ ...input, reaper }), { code: "phase_transition_unconfirmed" });
});

test("never-launched V2 and profiled V1 work release allocations without requiring Docker", async () => {
  for (const [shared, profiledV1] of [[false, false], [true, false], [true, true]]) for (const fails of [false, true]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "hitch-phase-cleanup-"));
    const options = await fixture(root, shared, profiledV1);
    if (profiledV1) { assert.equal(options.plan.work_items[0]!.schema_version, "1"); assert.equal(options.plan.work_items[0]!.resource_profiling?.unknown, true); }
    const resources = new ResourceLedger({ cpu_millis: 2000, memory_bytes: 3 * GIB, container_slots: 2, build_slots: 0 });
    const dispatcher = new WorkItemDispatcher({ resources });
    let acquired = 0; let released = 0;
    options.admission = { acquire: async input => {
      const permit = await dispatcher.acquire({ evalId: input.evalId, workId: input.workItem.work_id, maxParallelism: 2,
        reservation: input.workItem.reservation, collisionKeys: [input.workItem.work_id],
        ...(input.workItem.resource_profiling ? { resourceProfiling: input.workItem.resource_profiling } : {}),
        ...(input.signal ? { signal: input.signal } : {}) });
      acquired += 1;
      return { allocationId: permit.allocation.allocation_id, collisionKeys: permit.collision_keys, release: () => { released += 1; permit.release(); } };
    } };
    let sweeps = 0;
    options.dockerResourceReaper = async () => { sweeps++; if (fails) throw new Error("Docker unavailable"); return clean(root); };
    try {
      await assert.rejects(executePlannedHarborTasks(options));
      assert.equal(acquired, 1);
      assert.equal(released, 1);
      assert.equal(sweeps, 0);
      if (profiledV1) assert.equal(resources.snapshot().resource_profiling.active_unknown_slots, 0);
    } finally { dispatcher.close(); await options.sink.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("bound planned work keeps its allocation when Docker cleanup fails", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hitch-phase-bound-cleanup-"));
  const options = await fixture(root, true, true);
  t.after(async () => { await options.sink.close(); await rm(root, { recursive: true, force: true }); });
  options.env = { ...process.env }; await installEmptyDockerBackendForTest(root, options.env);
  const item = options.plan.work_items[0]!;
  const lease = await createExecutionLease({ evalDirectory: options.evalDirectory, evalId, workId: item.work_id,
    worker: options.worker, reservation: item.reservation, ttlMs: 45000 });
  await preparePhaseDockerExecution({ root, lease: lease.current() });
  await bindPhaseDockerBackend({ root, lease: lease.current(), env: options.env });
  options.dockerResourceReaper = async () => { throw new Error("Docker unavailable"); };
  const allocation = { held: true };
  await assert.rejects(finishPlannedLocalWork({ options, item, lease, epoch: 1, processRecorded: false, allocation }), { code: "phase_transition_unconfirmed" });
  assert.equal(allocation.held, true);
});

test("physical retries release only after confirmed cleanup for V2 and profiled V1 plans", async () => {
  for (const [shared, profiledV1] of [[false, false], [true, false], [true, true]]) for (const failure of ["none", "issues", "retained", "exception"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "hitch-phase-retry-cleanup-"));
    const options = await fixture(root, shared, profiledV1); let released = false;
    options.env = { ...process.env }; await installEmptyDockerBackendForTest(root, options.env);
    options.admission = { acquire: async () => ({ allocationId: `allocation_${"f".repeat(32)}`, collisionKeys: [], release: () => { released = true; } }) };
    options.dockerResourceReaper = async () => {
      if (failure === "exception") throw new Error("daemon unavailable");
      return { ...clean(root), ...(failure === "issues" ? { issues: [{ kind: "container" as const, stage: "delete" as const, message: "unavailable" }] } : {}),
        ...(failure === "retained" ? { retained: [{ kind: "container" as const, id: "owned", reason: "cannot confirm" }] } : {}) };
    };
    try {
      const lifecycle = await beginPlannedInfrastructureRetry({ options, item: options.plan.work_items[0]!, retry: 1,
        triggers: [{ task_id: "one", attempt: 1, trial_id: "first", run_id: `run_${"d".repeat(32)}`, observation_status: "invalid", invalid_reason: "verifier_infrastructure_failure" }],
        backendDirectory: path.join(options.evalDirectory, "retry") });
      await lifecycle.backend.onProcessStarting!(options.env);
      if (failure === "none") await lifecycle.close();
      else await assert.rejects(lifecycle.close(), { code: "phase_transition_unconfirmed" });
      assert.equal(released, failure === "none");
    } finally { await options.sink.close(); await rm(root, { recursive: true, force: true }); }
  }
});
