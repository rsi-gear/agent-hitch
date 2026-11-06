import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BackendWorkItemV1, EnvironmentImageManifestV1, EnvironmentImageUseV1, EvalRequest } from "../src/domain/index.js";
import { buildEvalExecutionPlan } from "../src/evals/execution-plan.js";
import { deriveTaskResourceRequirement } from "../src/evals/task-resources.js";
import { beginLocalCandidateRestart, localCandidateRestartWork } from "../src/evals/local-candidate-rerun.js";
import { groupRerunSlotsByArtifact } from "../src/evals/rerun.js";
import { validateEvalId } from "../src/evals/request.js";
import { atomicWriteJSON, hitchRootId } from "../src/foundation/index.js";
import { dockerOwnershipLabelMap } from "../src/evals/docker-ownership.js";
import { verifyTrialEnvironmentImageExecution } from "../src/evals/trial-environment-evidence.js";
import { installEmptyDockerBackendForTest } from "../test-support/empty-docker-backend.js";

const GIB = 1024 ** 3;
const rerunId = `rerun_${"d".repeat(32)}`;
const evalId = validateEvalId(`eval_${"a".repeat(32)}`);
const artifactId = `sha256:${"c".repeat(64)}` as const;
const request: EvalRequest = { schema_version: "1", backend: "harbor", dataset: "/tasks", harness_ref: "pi@version:1.2.3", model: "test/model",
  attempts: 1, max_concurrent: 4, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0, timeout_ms: 0, setup_timeout_ms: 0,
  agent_args: [], pass_env: [], benchmark_id: "automationbench-public", benchmark_revision: "fixture" };
function frozenPlan(phaseEnvelope = true, environmentImages: EnvironmentImageUseV1[] = []) {
  const taskResources = ["finance", "marketing"].map(taskId => deriveTaskResourceRequirement({ taskId, phaseEnvelope,
    defaultResources: { cpu_millis: 1000, memory_bytes: GIB, container_slots: 1, build_slots: 0 }, defaultSource: "operator-default",
    declaration: { schema_version: "1", task: { cpu_millis: 1000, memory_bytes: 2 * GIB },
      verifier: { separate: true, environment: { cpu_millis: 1000, memory_bytes: 2 * GIB } },
      compose_services: [{ name: "main", replicas: 1 }, { name: "simulator", replicas: 1 }],
      verifier_compose_services: [{ name: "main", replicas: 1 }], provider_sidecars: { main_egress: false, verifier_egress: false },
      environment_images: [], environment_image_fallbacks: [], environment_builds: [],
      lifecycle: { contract: "harbor-native-docker-single-step-v1", capability: "phase-exclusive-teardown-v1", verifier_mode: "separate",
        verifier_dependencies: { inputs: "artifacts-only", live_services: [], artifacts: [{ service: "simulator", path: "/snapshot.json" }] } } },
  }));
  return buildEvalExecutionPlan({ evalId, request, candidate: { revisionIdentity: `sha256:${"b".repeat(64)}`, artifactId },
    maxParallelism: 4, tasks: taskResources.map(r => r.task_id), taskResources, environmentImages, workItemMode: "task-slots", provider: "local-docker",
    createdAt: "2026-10-21T00:00:00.000Z" });
}

test("local V2 candidate restart isolates slots sharing an artifact and preserves the immutable resource binding", () => {
  const plan = frozenPlan();
  const slots = plan.slots.map(slot => ({ task_id: slot.task_id, attempt: slot.attempt }));
  const groups = groupRerunSlotsByArtifact(slots, plan, [artifactId]);
  assert.deepEqual(groups.map(group => group.slots.length), [1, 1]);
  assert.equal(groupRerunSlotsByArtifact(slots, frozenPlan(false), [artifactId]).length, 1);
  const restarted = localCandidateRestartWork(plan, slots[0]!, rerunId);
  const source = plan.work_items.find(work => work.work_id === restarted.physical.source_work_id)!;
  assert.notEqual(restarted.work.work_id, source.work_id);
  assert.deepEqual({ ...restarted.work, work_id: source.work_id }, source);
  assert.equal(restarted.work.reservation.memory_bytes, 3 * GIB);
  assert.deepEqual(restarted.phaseResourceContract!.agent_services, [{ name: "main", replicas: 1 }, { name: "simulator", replicas: 1 }]);
  const tampered = structuredClone(plan);
  tampered.work_items[0]!.resource_contract_digest = `sha256:${"e".repeat(64)}`;
  assert.throws(() => localCandidateRestartWork(tampered, slots[0]!, rerunId));
});

test("candidate restart admits frozen peak, applies main/sidecar limits, and releases only after cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hitch-candidate-phase-"));
  try {
    const plan = frozenPlan();
    const slot = { task_id: "finance", attempt: 1 };
    const evalDirectory = path.join(root, "evals", evalId);
    const env: NodeJS.ProcessEnv = { ...process.env }; await installEmptyDockerBackendForTest(root, env);
    const order: string[] = [];
    let admitted: BackendWorkItemV1 | undefined;
    const managed = await beginLocalCandidateRestart({ plan, slot, evalDirectory, rerunId, rerunDirectory: path.join(evalDirectory, "reruns", rerunId),
      options: { root, evalId, selector: { mode: "invalid" }, env,
        workItemAdmission: { acquire: async input => { admitted = input.workItem; order.push("admitted"); return {
          allocationId: `allocation_${"f".repeat(32)}`, collisionKeys: [], release: () => { order.push("released"); } }; } },
        dockerResourceReaper: async input => {
          const lease = JSON.parse(await readFile(path.join(evalDirectory, "leases", `${input.leaseIds![0]}.json`), "utf8"));
          assert.equal(lease.state, "released");
          assert.equal(lease.parent_allocation_id, `allocation_${"f".repeat(32)}`);
          order.push("cleaned");
          return { schema_version: "1", root_id: hitchRootId(root), scanned: 0, deleted: [], retained: [], issues: [] };
        },
      } });
    assert.equal(admitted!.reservation.memory_bytes, 3 * GIB);
    assert.equal(managed.backend.executionResources!.memory_bytes, 2 * GIB);
    assert.equal(managed.backend.dockerServiceLimits!.simulator!.memory_bytes, GIB);
    assert.equal(managed.backend.dockerOwnership!.work_id, admitted!.work_id);
    assert.equal(managed.backend.phaseResourceContract!.task_id, slot.task_id);
    await managed.backend.onProcessStarting!(env);
    assert.equal((await managed.captureExecutionEvidence()).reservation.memory_bytes, 3 * GIB);
    await managed.close();
    await managed.close();
    assert.deepEqual(order, ["admitted", "cleaned", "released"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("candidate restart preserves role image bindings and setup-failure observations", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hitch-candidate-images-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifests: EnvironmentImageManifestV1[] = ["main", "simulator", "verifier"].map((name, index) => ({
    schema_version: "1", image_id: `sha256:${String(index + 1).repeat(64)}`,
    source: { kind: name === "simulator" ? "compose-build" : "build-context", benchmark_id: request.benchmark_id,
      benchmark_revision: request.benchmark_revision, task_id: "finance" },
    platform: "linux/amd64", build: { builder: "buildkit", frontend: "dockerfile.v0", secret_names: [], cache_key: artifactId },
    output: { reference: `hitch-environment:${name}`, manifest_digest: `sha256:${String(index + 4).repeat(64)}`,
      config_digest: `sha256:${String(index + 7).repeat(64)}` }, base_images: [], created_at: "2026-10-21T00:00:00.000Z",
  }));
  const uses: EnvironmentImageUseV1[] = manifests.map((manifest, index) => ({
    task_ids: ["finance"], image_id: manifest.image_id, requested_reference: manifest.output.reference,
    reference: `${manifest.output.reference}@${manifest.output.manifest_digest}`, manifest_digest: manifest.output.manifest_digest,
    platform: manifest.platform, resolution: "prebuilt", cache_hit: true, role: index === 2 ? "verifier" : "candidate",
    ...(index === 1 ? { service: "simulator" } : {}),
  }));
  const plan = frozenPlan(true, uses), evalDirectory = path.join(root, "evals", evalId);
  const managed = await beginLocalCandidateRestart({ plan, slot: { task_id: "finance", attempt: 1 }, evalDirectory,
    rerunId, rerunDirectory: path.join(evalDirectory, "reruns", rerunId), options: {
      root, evalId, selector: { mode: "invalid" }, env: { ...process.env, HITCH_DOCKER_PATH: "/missing/docker" },
      environmentImageManifestLoader: async id => manifests.find(manifest => manifest.image_id === id)!,
      dockerResourceReaper: async () => { throw new Error("never-launched setup failure must not require Docker cleanup"); },
    } });
  try {
    assert.equal(managed.backend.prebuiltTaskImage, manifests[0]!.output.config_digest);
    assert.deepEqual({ ...managed.backend.prebuiltServiceImages }, { simulator: manifests[1]!.output.config_digest });
    assert.equal(managed.backend.verifierImages!.prebuiltImage, manifests[2]!.output.config_digest);
    const evidence = await managed.captureExecutionEvidence();
    assert.deepEqual(evidence.observed.containers, [], "setup failed before any task container could be observed");
    assert.deepEqual(JSON.parse(await readFile(path.join(managed.backendDirectory, "execution.json"), "utf8")), evidence);
    const saved = JSON.parse(await readFile(path.join(managed.backendDirectory, "environment", "image.manifest.json"), "utf8"));
    assert.deepEqual(new Set(saved.uses.map((use: EnvironmentImageUseV1) => use.image_id)), new Set(uses.map(use => use.image_id)));
    assert.equal(saved.manifests.length, 3);
    const setupFailure = { exception_info: { exception_type: "EnvironmentStartTimeoutError" }, agent_execution: null, verifier: null };
    assert.equal(verifyTrialEnvironmentImageExecution(evidence, managed.images, setupFailure), evidence);
    assert.throws(() => verifyTrialEnvironmentImageExecution(evidence, managed.images), { code: "environment_image_evidence_unavailable" });
  } finally { await managed.close(); }
  assert.equal(JSON.parse(await readFile(path.join(managed.backendDirectory, "environment", "image.manifest.json"), "utf8")).manifests.length, 3);
});

test("candidate restart retains admission when Docker cleanup cannot be confirmed", async () => {
  for (const failure of ["report", "backend"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hitch-candidate-phase-"));
  try {
    const plan = frozenPlan();
    const env: NodeJS.ProcessEnv = { ...process.env }; await installEmptyDockerBackendForTest(root, env);
    let released = false;
    const managed = await beginLocalCandidateRestart({ plan, slot: { task_id: "finance", attempt: 1 }, rerunId,
      evalDirectory: path.join(root, "evals", evalId), rerunDirectory: path.join(root, "rerun"), options: {
        root, evalId, selector: { mode: "invalid" }, env,
        workItemAdmission: { acquire: async () => ({ allocationId: `allocation_${"f".repeat(32)}`, collisionKeys: [], release: () => { released = true; } }) },
        dockerResourceReaper: async () => ({ schema_version: "1", root_id: hitchRootId(root), scanned: 1, deleted: [], retained: [],
          issues: failure === "report" ? [{ kind: "container", stage: "delete", message: "cannot confirm removal" }] : [] }),
      } });
    await managed.backend.onProcessStarting!(env);
    if (failure === "backend") await atomicWriteJSON(path.join(managed.backendDirectory, "job", "trial", "hitch-phase-resources-agent.json"), {
      schema_version: "1", role: "agent", docker_backend_id: "original-daemon", containers: [],
      ownership: dockerOwnershipLabelMap(managed.backend.dockerOwnership!),
    });
    await assert.rejects(managed.close(), /cleanup is unconfirmed/);
    assert.equal(released, false);
  } finally { await rm(root, { recursive: true, force: true }); }
  }
});
