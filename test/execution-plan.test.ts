import test from "node:test";
import assert from "node:assert/strict";
import { buildEvalExecutionPlan, deriveTaskResourceRequirement, parseEvalExecutionPlan, validateEvalId } from "../src/evals/index.js";
import { groupRerunSlotsByArtifact } from "../src/evals/rerun.js";
import type { EvalRequest } from "../src/domain/index.js";

const request: EvalRequest = {
  schema_version: "1",
  backend: "harbor",
  dataset: "demo@1.0",
  harness_ref: "pi@version:1.2.3",
  model: "openai/test",
  attempts: 2,
  max_concurrent: 4,
  infrastructure_retries: 1,
  infrastructure_retry_backoff_ms: 1_000,
  timeout_ms: 900_000,
  setup_timeout_ms: 1_800_000,
  agent_args: ["--test"],
  pass_env: [],
  benchmark_id: "demo",
  benchmark_revision: "1.0",
};

const input = {
  evalId: validateEvalId("eval_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  request,
  candidate: {
    revisionIdentity: `sha256:${"b".repeat(64)}`,
    artifactId: `sha256:${"c".repeat(64)}`,
  },
  maxParallelism: 2,
  trialResources: { cpu_millis: 2_000, memory_bytes: 4_096, container_slots: 1, build_slots: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
};

test("execution plan creates deterministic slots and attempt work items for known tasks", () => {
  const plan = buildEvalExecutionPlan({ ...input, tasks: ["two", "one"] });
  assert.equal(plan.membership, "known");
  assert.deepEqual(plan.slots.map((slot) => `${slot.task_id}#${slot.attempt}`), ["one#1", "one#2", "two#1", "two#2"]);
  assert.equal(new Set(plan.slots.map((slot) => slot.slot_id)).size, 4);
  assert.deepEqual(plan.work_items.map((item) => ({ attempt: item.logical_attempt, tasks: item.task_ids, parallelism: item.requested_parallelism })), [
    { attempt: 1, tasks: ["one", "two"], parallelism: 2 },
    { attempt: 2, tasks: ["one", "two"], parallelism: 2 },
  ]);
  assert.deepEqual(plan.work_items[0]?.reservation, { cpu_millis: 4_000, memory_bytes: 8_192, container_slots: 2, build_slots: 0 });
  assert.deepEqual(parseEvalExecutionPlan(plan), plan);
  assert.deepEqual(buildEvalExecutionPlan({ ...input, tasks: ["one", "two"] }), plan);
});

test("execution plan conservatively represents opaque dataset membership", () => {
  const plan = buildEvalExecutionPlan({ ...input, tasks: null });
  assert.equal(plan.membership, "opaque");
  assert.deepEqual(plan.slots, []);
  assert.equal(plan.work_items.length, 1);
  assert.equal(plan.work_items[0]?.opaque_membership, true);
  assert.equal(plan.work_items[0]?.requested_parallelism, 2);
  assert.deepEqual(plan.work_items[0]?.reservation, { cpu_millis: 4_000, memory_bytes: 8_192, container_slots: 2, build_slots: 0 });
});

test("execution plan scales and round-trips GPU reservations", () => {
  const plan = buildEvalExecutionPlan({ ...input, tasks: ["one", "two"], trialResources: { ...input.trialResources, gpu_count: 1 } });
  assert.equal(plan.default_trial_resources.gpu_count, 1);
  assert.equal(plan.work_items[0]?.reservation.gpu_count, 2);
  assert.deepEqual(parseEvalExecutionPlan(plan), plan);
});

test("execution plan scales and round-trips ephemeral disk reservations", () => {
  const plan = buildEvalExecutionPlan({
    ...input,
    tasks: ["one", "two"],
    trialResources: { ...input.trialResources, ephemeral_disk_bytes: 8_192 },
  });
  assert.equal(plan.default_trial_resources.ephemeral_disk_bytes, 8_192);
  assert.equal(plan.work_items[0]?.reservation.ephemeral_disk_bytes, 16_384);
  assert.deepEqual(parseEvalExecutionPlan(plan), plan);
});

test("execution plan seals requested and effective model capture policy", () => {
  const modelCapture = {
    requested_mode: "hybrid" as const,
    effective_mode: "native" as const,
    required: false,
    degraded_reason: "provider-model-proxy-unavailable",
  };
  const plan = buildEvalExecutionPlan({ ...input, tasks: ["one"], modelCapture });
  assert.deepEqual(plan.model_capture, modelCapture);
  assert.deepEqual(parseEvalExecutionPlan(plan), plan);
  assert.throws(
    () => parseEvalExecutionPlan({ ...plan, model_capture: { ...modelCapture, required: true } }),
    /required model capture cannot be degraded/,
  );
});

test("task-slot planning emits one schedulable work item per logical trial", () => {
  const plan = buildEvalExecutionPlan({ ...input, tasks: ["two", "one"], workItemMode: "task-slots" });
  assert.equal(plan.work_items.length, 4);
  assert.deepEqual(plan.work_items.map((item) => `${item.task_ids[0]}#${item.logical_attempt}`), ["one#1", "one#2", "two#1", "two#2"]);
  assert.ok(plan.work_items.every((item) => item.slots.length === 1 && item.requested_parallelism === 1));
  assert.deepEqual(plan.work_items[0]?.reservation, input.trialResources);
  assert.deepEqual(parseEvalExecutionPlan(plan), plan);
});

test("task-slot planning seals scheduling hints without changing work identity", () => {
  const plain = buildEvalExecutionPlan({ ...input, tasks: ["two", "one"], workItemMode: "task-slots" });
  const taskScheduling = {
    one: { policy: "critical-path-lpt-v1" as const, estimated_duration_ms: 10_000, remaining_path_ms: 12_000, estimate_source: "history-p75" as const, estimate_sample_count: 4 },
    two: { policy: "critical-path-lpt-v1" as const, estimated_duration_ms: 60_000, remaining_path_ms: 60_000, estimate_source: "evolution-baseline" as const, estimate_sample_count: 1 },
  };
  const prioritized = buildEvalExecutionPlan({ ...input, tasks: ["two", "one"], workItemMode: "task-slots", taskScheduling });
  assert.deepEqual(prioritized.work_items.map((item) => item.scheduling), [taskScheduling.one, taskScheduling.one, taskScheduling.two, taskScheduling.two]);
  assert.deepEqual(prioritized.work_items.map((item) => item.work_id), plain.work_items.map((item) => item.work_id));
  assert.deepEqual(parseEvalExecutionPlan(prioritized), prioritized);
  assert.throws(
    () => buildEvalExecutionPlan({ ...input, tasks: ["one", "two"], workItemMode: "task-slots", taskScheduling: { one: taskScheduling.one } }),
    /cover every planned task exactly once/,
  );
  const forged = structuredClone(prioritized);
  forged.work_items[0]!.scheduling!.estimate_sample_count = 0;
  assert.throws(() => parseEvalExecutionPlan(forged), /sample count is invalid/);
});

test("execution planning binds each task environment to its matching artifact contract", () => {
  const x64 = `sha256:${"d".repeat(64)}`;
  const arm64 = `sha256:${"e".repeat(64)}`;
  const artifactAssignments = [
    {
      taskIds: ["one"], artifactId: x64,
      runtimeContract: { docker_platform: "linux/amd64", artifact_platform: "linux-x64", node_version: "v22.23.0" },
    },
    {
      taskIds: ["two"], artifactId: arm64,
      runtimeContract: { docker_platform: "linux/arm64", artifact_platform: "linux-arm64", node_version: "v22.23.0" },
    },
  ];
  const taskPlan = buildEvalExecutionPlan({
    ...input,
    candidate: { ...input.candidate, artifactAssignments },
    tasks: ["two", "one"],
    workItemMode: "task-slots",
  });
  assert.deepEqual(taskPlan.work_items.map((item) => ({
    task: item.task_ids[0], attempt: item.logical_attempt, artifact: item.artifact_id, contract: item.runtime_contract,
  })), [
    { task: "one", attempt: 1, artifact: x64, contract: artifactAssignments[0]!.runtimeContract },
    { task: "one", attempt: 2, artifact: x64, contract: artifactAssignments[0]!.runtimeContract },
    { task: "two", attempt: 1, artifact: arm64, contract: artifactAssignments[1]!.runtimeContract },
    { task: "two", attempt: 2, artifact: arm64, contract: artifactAssignments[1]!.runtimeContract },
  ]);
  assert.deepEqual(parseEvalExecutionPlan(taskPlan), taskPlan);
  assert.deepEqual(groupRerunSlotsByArtifact([
    { task_id: "one", attempt: 1 },
    { task_id: "two", attempt: 1 },
  ], taskPlan, [x64, arm64]), [
    { logicalAttempt: 1, slots: [{ task_id: "one", attempt: 1 }], artifactId: x64, splitAttempt: true },
    { logicalAttempt: 1, slots: [{ task_id: "two", attempt: 1 }], artifactId: arm64, splitAttempt: true },
  ]);

  const shardPlan = buildEvalExecutionPlan({
    ...input,
    candidate: { ...input.candidate, artifactAssignments },
    tasks: ["one", "two"],
  });
  assert.equal(shardPlan.work_items.length, 4, "attempt shards must split at artifact-contract boundaries");
  assert.ok(shardPlan.work_items.every((item) => item.task_ids.length === 1));
});

test("execution plan persists per-task evidence and reserves heterogeneous tasks", () => {
  const taskResources = [
    deriveTaskResourceRequirement({
      taskId: "one",
      defaultResources: input.trialResources,
      defaultSource: "operator-default",
      declaration: { schema_version: "1", task: { cpu_millis: 3_000 }, verifier: { separate: false }, compose_services: [{ name: "main", replicas: 1 }], provider_sidecars: { main_egress: false, verifier_egress: false }, environment_images: [], environment_image_fallbacks: [], environment_builds: [] },
    }),
    deriveTaskResourceRequirement({
      taskId: "two",
      defaultResources: input.trialResources,
      defaultSource: "operator-default",
      declaration: { schema_version: "1", task: { memory_bytes: 8_192 }, verifier: { separate: false }, compose_services: [{ name: "main", replicas: 1 }], provider_sidecars: { main_egress: false, verifier_egress: false }, environment_images: [], environment_image_fallbacks: [], environment_builds: [] },
    }),
  ];
  const taskPlan = buildEvalExecutionPlan({ ...input, tasks: ["two", "one"], taskResources, workItemMode: "task-slots" });
  assert.deepEqual(taskPlan.task_resources, taskResources);
  assert.deepEqual(taskPlan.work_items.map((entry) => entry.reservation), [
    taskResources[0]!.reservation, taskResources[0]!.reservation,
    taskResources[1]!.reservation, taskResources[1]!.reservation,
  ]);
  assert.deepEqual(parseEvalExecutionPlan(taskPlan), taskPlan);

  const shardPlan = buildEvalExecutionPlan({ ...input, tasks: ["one", "two"], taskResources, maxParallelism: 1 });
  assert.deepEqual(shardPlan.work_items[0]?.reservation, { cpu_millis: 3_000, memory_bytes: 8_192, container_slots: 1, build_slots: 0 });
  const forged = structuredClone(taskPlan);
  forged.task_resources![0]!.components[0]!.resources.cpu_millis += 1;
  assert.throws(() => parseEvalExecutionPlan(forged), /resource totals are invalid/);
});

test("execution plan parser rejects slots assigned more than once", () => {
  const plan = buildEvalExecutionPlan({ ...input, tasks: ["one", "two"] });
  const duplicate = structuredClone(plan);
  duplicate.work_items[1]!.slots[0] = duplicate.work_items[0]!.slots[0] as string;
  assert.throws(() => parseEvalExecutionPlan(duplicate), /slots are not assigned exactly once/);
});

test("execution plan parser rejects unknown fields and forged reservations", () => {
  const plan = buildEvalExecutionPlan({ ...input, tasks: ["one", "two"], workItemMode: "task-slots" });
  assert.throws(() => parseEvalExecutionPlan({ ...plan, surprise: true }), /unknown field: surprise/);
  const forged = structuredClone(plan);
  forged.work_items[0]!.reservation.cpu_millis += 1;
  assert.throws(() => parseEvalExecutionPlan(forged), /does not match its slots/);
});

test("execution plan pins environment images into each matching work item", () => {
  const manifestDigest = `sha256:${"d".repeat(64)}` as const;
  const image = {
    task_ids: ["one"],
    image_id: `sha256:${"e".repeat(64)}` as const,
    requested_reference: "registry.test/task:latest",
    reference: `registry.test/task@${manifestDigest}`,
    manifest_digest: manifestDigest,
    platform: "linux/amd64",
    resolution: "registry" as const,
    cache_hit: false,
  };
  const plan = buildEvalExecutionPlan({
    ...input,
    tasks: ["one"],
    workItemMode: "task-slots",
    environmentImages: [image],
    environmentImageFallbacks: [{ task_id: "one", source: "compose", service: "database", code: "backend-build" }],
  });
  assert.deepEqual(plan.work_items[0]?.image_refs, [image]);
  assert.deepEqual(plan.image_fallbacks, [{ task_id: "one", source: "compose", service: "database", code: "backend-build" }]);
  assert.deepEqual(parseEvalExecutionPlan(plan), plan);
  const forged = structuredClone(plan);
  forged.work_items[0]!.image_refs![0]!.reference = `registry.test/task@sha256:${"f".repeat(64)}`;
  assert.throws(() => parseEvalExecutionPlan(forged), /image refs 0 is invalid/);
});
