import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { EvalRequest, TaskResourceRequirementV1 } from "../src/domain/index.js";
import type { HarborTaskResourceDeclarationV1 } from "../src/backends/index.js";
import { buildEvalExecutionPlan, deriveTaskResourceRequirement, parseEvalExecutionPlan, validateEvalId } from "../src/evals/index.js";
import { parseTaskResourceRequirements, runtimeResourcesForTask } from "../src/evals/execution-plan-resources.js";
import { phaseResourceContractForTask } from "../src/evals/phase-resource-runtime.js";
import { harborEnvironmentConfig } from "../src/backends/harbor/environment-config.js";
import { planLocalEvalInputs } from "../src/evals/local-eval-planning.js";

const GIB = 1024 ** 3;
const defaults = { cpu_millis: 1_000, memory_bytes: GIB, container_slots: 1, build_slots: 0 };
function declaration(): HarborTaskResourceDeclarationV1 {
  return {
    schema_version: "1", task: { cpu_millis: 1_000, memory_bytes: 2 * GIB },
    verifier: { separate: true, environment: { cpu_millis: 1_000, memory_bytes: 2 * GIB } },
    compose_services: [{ name: "main", replicas: 1 }, { name: "simulator", replicas: 1 }],
    verifier_compose_services: [{ name: "main", replicas: 1 }],
    provider_sidecars: { main_egress: false, verifier_egress: false },
    environment_images: [], environment_image_fallbacks: [], environment_builds: [],
    lifecycle: { contract: "harbor-native-docker-single-step-v1", capability: "phase-exclusive-teardown-v1", verifier_mode: "separate",
      verifier_dependencies: { inputs: "artifacts-only", live_services: [], artifacts: [{ service: "simulator", path: "/evidence/snapshot.json" }] } },
  };
}
function requirement(taskId = "marketing-example", source = declaration(), phaseEnvelope = true): TaskResourceRequirementV1 {
  return deriveTaskResourceRequirement({ taskId, declaration: source, defaultResources: defaults, defaultSource: "operator-default", phaseEnvelope });
}
const request: EvalRequest = { schema_version: "1", backend: "harbor", dataset: "/tasks", harness_ref: "pi@version:1.2.3", model: "test/model",
  attempts: 1, max_concurrent: 4, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0, timeout_ms: 0, setup_timeout_ms: 0,
  agent_args: [], pass_env: [], benchmark_id: "automationbench-public", benchmark_revision: "fixture" };
function plan(resources = [requirement()], provider = "local-docker") {
  return buildEvalExecutionPlan({ evalId: validateEvalId(`eval_${"a".repeat(32)}`), request,
    candidate: { revisionIdentity: `sha256:${"b".repeat(64)}`, artifactId: `sha256:${"c".repeat(64)}` },
    maxParallelism: 4, tasks: resources.map(r => r.task_id), taskResources: resources, workItemMode: "task-slots", provider,
    createdAt: "2026-10-21T00:00:00.000Z" });
}

test("AutomationBench template uses the same phase envelope for every domain and non-benchmark tasks", () => {
  for (const id of ["marketing-example", "finance-example", "sales-example", "hr-example", "unrelated-snapshot-task"]) {
    const r = requirement(id);
    assert.deepEqual(r.reservation, { cpu_millis: 2_000, memory_bytes: 3 * GIB, container_slots: 2, build_slots: 0 });
    assert.equal(r.main_limits.memory_bytes, 2 * GIB);
    assert.deepEqual(r.lifecycle!.phases.map(p => [p.id, p.demand.memory_bytes]), [["agent", 3 * GIB], ["artifact-collection", GIB], ["verifier", 2 * GIB]]);
    assert.equal(r.components.find(c => c.name === "simulator")!.fields.memory_bytes.estimated, true);
    const frozen = plan([r]);
    assert.equal(frozen.resource_contract_version, "2");
    assert.equal(frozen.work_items[0]!.schema_version, "2");
    assert.deepEqual(parseEvalExecutionPlan(frozen), frozen);
  }
});

test("phase demand uses enforced maximum limits, replicas once, and per-phase egress", () => {
  const source = declaration();
  source.task.memory_bytes = GIB;
  source.verifier.environment!.memory_bytes = 8 * GIB;
  source.compose_services[1]!.replicas = 2;
  source.provider_sidecars = { main_egress: true, verifier_egress: true };
  const r = requirement("asymmetric", source);
  assert.equal(r.reservation.memory_bytes, 10 * GIB + 128 * 1024 ** 2);
  assert.equal(r.reservation.container_slots, 4);
  assert.equal(r.declared_limits![0]!.fields.memory_bytes.value, GIB);
  assert.equal(r.components[0]!.resources.memory_bytes, 8 * GIB);
  assert.deepEqual(parseTaskResourceRequirements([r], [r.task_id], "2"), [r]);
  const runtime = runtimeResourcesForTask({ task_resources: [r] }, r.task_id, defaults);
  assert.equal(runtime.sidecarLimits.simulator!.memory_bytes, GIB);
  assert.deepEqual(Object.keys(runtime.sidecarLimits), ["simulator", "harbor-docker-egress-control-sidecar"]);
  const legacyOverhead = plan([r], "remote-test").task_resources![0]!.components.filter(c => c.role === "provider-sidecar");
  assert.equal(legacyOverhead.length, 1);
  assert.equal(legacyOverhead[0]!.name, "harbor-docker-egress-control-sidecar");
  assert.equal(legacyOverhead[0]!.replicas, 2);
});

test("shared verifier uses one main and keeps its sidecars alive", () => {
  const source = declaration();
  source.verifier = { separate: false };
  source.verifier_compose_services = [];
  source.lifecycle!.verifier_mode = "shared";
  source.lifecycle!.verifier_dependencies.inputs = "backend-defined";
  const r = requirement("shared", source);
  assert.equal(r.reservation.memory_bytes, 3 * GIB);
  assert.equal(r.components.filter(c => c.role === "verifier").length, 0);
  assert.deepEqual(r.lifecycle!.transitions, []);
  assert.deepEqual(parseEvalExecutionPlan(plan([r])), plan([r]));
});

test("legacy plans and unsupported remote providers retain summed reservations", () => {
  const old = plan([requirement("legacy", declaration(), false)]);
  const encoded = JSON.stringify(old);
  assert.equal(old.resource_contract_version, undefined);
  assert.equal(old.work_items[0]!.schema_version, "1");
  assert.equal(old.work_items[0]!.reservation.memory_bytes, 5 * GIB);
  assert.equal(JSON.stringify(parseEvalExecutionPlan(JSON.parse(encoded))), encoded);
  const remote = plan([requirement()], "remote-test");
  assert.equal(remote.resource_contract_version, undefined);
  assert.equal(remote.work_items[0]!.schema_version, "1");
  assert.equal(remote.work_items[0]!.reservation.memory_bytes, 5 * GIB);
  assert.match(remote.task_resources![0]!.diagnostics.join(" "), /provider-capability/);
});

test("resume freezes V1 and V2 budgets without re-inspecting tasks or applying new defaults", async () => {
  for (const phase of [false, true]) {
    const frozen = plan([requirement("frozen", declaration(), phase)]);
    const before = JSON.stringify(frozen);
    const input = { root: "/missing-state", dataset: "/missing-dataset", taskIds: ["frozen"],
      defaultResources: { ...defaults, memory_bytes: 100 * GIB }, defaultSource: "submission-default" as const,
      benchmarkId: request.benchmark_id, benchmarkRevision: request.benchmark_revision,
      buildMode: "prebuild-required" as const, harborExecutable: "/missing-harbor", resumePlan: frozen };
    const resumed = await planLocalEvalInputs(input);
    assert.deepEqual(resumed.taskResources, frozen.task_resources);
    assert.equal(resumed.taskResources![0]!.reservation.memory_bytes, (phase ? 3 : 5) * GIB);
    assert.equal(JSON.stringify(frozen), before);
    resumed.taskResources![0]!.reservation.memory_bytes = 0;
    assert.equal(JSON.stringify(frozen), before, "resumed objects must not mutate the frozen plan");
    await assert.rejects(planLocalEvalInputs({ ...input, taskIds: ["different"] }), /membership/);
  }
});

test("phase parsers reject forged demand, oversized execution overlays, missing phases and V1 laundering", () => {
  const valid = plan();
  for (const tamper of [
    (p: typeof valid) => { p.task_resources![0]!.lifecycle!.phases[0]!.demand.memory_bytes = GIB; },
    (p: typeof valid) => { p.task_resources![0]!.main_limits.memory_bytes = 8 * GIB; },
    (p: typeof valid) => { p.task_resources![0]!.lifecycle!.phases.pop(); },
    (p: typeof valid) => { delete p.resource_contract_version; },
    (p: typeof valid) => { p.work_items[0]!.schema_version = "1"; },
    (p: typeof valid) => { p.work_items[0]!.resource_contract_digest = `sha256:${"d".repeat(64)}`; },
  ]) {
    const forged = structuredClone(valid); tamper(forged);
    assert.throws(() => parseEvalExecutionPlan(forged));
  }
});

test("runtime receives the frozen service graph and ownership-scoped stop contract", () => {
  const frozen = plan(); const work = frozen.work_items[0]!;
  const contract = phaseResourceContractForTask(frozen, work, work.task_ids[0]!)!;
  assert.deepEqual(contract.agent_services, [{ name: "main", replicas: 1 }, { name: "simulator", replicas: 1 }]);
  assert.deepEqual(contract.verifier_services, [{ name: "main", replicas: 1 }]);
  assert.deepEqual(contract.artifacts, [{ service: "simulator", path: "/evidence/snapshot.json" }]);
  const ownership = { root_id: "a".repeat(24), provider: "local-docker", eval_id: frozen.eval_id, work_id: work.work_id,
    lease_id: `lease_${"b".repeat(32)}`, lease_epoch: 1, task_id: work.task_ids[0]! };
  const env = harborEnvironmentConfig(frozen.task_resources![0]!.main_limits, ownership, undefined, undefined, undefined, false, false, undefined, {}, {}, undefined, contract);
  assert.deepEqual((env.kwargs as Record<string, unknown>).hitch_phase_resource_contract, contract);
  assert.throws(() => harborEnvironmentConfig(defaults, undefined, undefined, undefined, undefined, false, false, undefined, {}, {}, undefined, contract), /ownership/);
});

test("published execution plan schema accepts both versions and rejects stripped version markers", async () => {
  const schema = JSON.parse(await readFile("docs/schemas/eval-execution-plan.schema.json", "utf8"));
  const ajv = new Ajv2020({ strict: false, validateFormats: false,
    loadSchema: async uri => JSON.parse(await readFile(path.join("docs/schemas", path.basename(new URL(uri).pathname)), "utf8")) });
  const validate = await ajv.compileAsync(schema);
  const current = plan(); const legacy = plan([requirement("legacy", declaration(), false)]);
  assert.equal(validate(current), true, JSON.stringify(validate.errors));
  assert.equal(validate(legacy), true, JSON.stringify(validate.errors));
  const downgraded = structuredClone(current); delete downgraded.resource_contract_version;
  assert.equal(validate(downgraded), false);
});
