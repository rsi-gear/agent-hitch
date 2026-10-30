import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EvalRequest, ExecutionEvidenceV1, ExternalEndpointBindingV1, ResourceProfileIdentityV1 } from "../src/domain/index.js";
import { atomicWriteJSON, sha256JSON } from "../src/foundation/index.js";
import { buildEvalExecutionPlan, collectEvalResourceProfile, deriveTaskResourceRequirement, recommendResourceConfiguration,
  resourceProfileIdentityDigest, validateEvalId } from "../src/evals/index.js";
import { candidateRestartWorkItem, verifierOnlyWorkItem } from "../src/evals/physical-work-plan.js";
import { endpointEvaluationAttemptId } from "../src/evals/endpoint-attempts.js";
import { assertRerunResourceApproval } from "../src/evals/resource-profile-rerun.js";
import { createEvalProgress } from "../src/evals/progress.js";
import { rerunEval } from "../src/evals/rerun.js";

const digest = sha256JSON, MIB = 1024 ** 2, evalId = validateEvalId(`eval_${"a".repeat(32)}`);
const resources = { cpu_millis: 1000, memory_bytes: 1024 * MIB, container_slots: 1, build_slots: 0 };
const request: EvalRequest = { schema_version: "1", backend: "harbor", dataset: "fixture@fixture", harness_ref: "pi@version:1.2.3", model: "fixture/model",
  attempts: 1, max_concurrent: 4, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0, timeout_ms: 1000, setup_timeout_ms: 1000,
  agent_args: [], pass_env: [], benchmark_id: "fixture", benchmark_revision: "fixture" };
function requirement(taskId = "task-a") {
  return deriveTaskResourceRequirement({ taskId, defaultResources: resources, defaultSource: "operator-default", declaration: {
    schema_version: "1", task: {}, verifier: { separate: true, environment: {} }, compose_services: [{ name: "main", replicas: 1 }],
    provider_sidecars: { main_egress: false, verifier_egress: false }, environment_images: [], environment_image_fallbacks: [], environment_builds: [] } });
}
function endpoint(deployment: string): ExternalEndpointBindingV1 {
  return { schema_version: "1", kind: "external-endpoint", endpoint_ref: "endpoint/profile", endpoint_revision: digest(deployment), api: "responses", wire_model: "model",
    capabilities: { streaming: true, tool_calls: true, parallel_tool_calls: false, input_modalities: ["text"] }, generation: { max_output_tokens: 1024 },
    deployment_receipt: { schema_version: "1", model_digest: digest("model"), wire_model: "model", deployment_ref: deployment,
      source: "fixture", service_config: { engine: "fixture", engine_version: "1" } } };
}
function identity(): ResourceProfileIdentityV1 {
  const tasks = [{ task_id: "task-a", task_digest: digest("task") }];
  return { schema_version: "1", tasks, task_set_digest: digest(tasks), harness_artifact_digest: digest("artifact"), controller_runtime_digest: digest("controller"),
    runtime_contract_digest: digest("runtime"), role_images: [{ component_id: "main:main", image_digest: digest("image"), replicas: 1 }], platform: "linux/amd64",
    backend: { id: "harbor", version: "0.21.0", provider: "local-docker", lifecycle_digest: digest("lifecycle") }, input_scale: {},
    resource_parameters: { endpoint_binding_digest: digest(endpoint("original")) } };
}
function observation(workId: string, index: number, peak: number): ExecutionEvidenceV1 {
  return { schema_version: "1", provider: "local-docker", worker_id: "worker", collision_domain_id: "local", eval_id: evalId,
    work_id: workId, lease_id: `lease_${index.toString(16).repeat(32)}`, lease_epoch: 1, task_id: "task-a", reservation: resources,
    enforced: { main_limits: resources, sidecar_limits: {} }, observed: { status: "partial", started_at: "2026-10-21T00:00:00Z", collected_at: "2026-10-21T00:01:00Z",
      sample_count: 1, unavailable_fields: [], issues: [], containers: [{ container_id: "d".repeat(64), first_observed_at: "2026-10-21T00:00:00Z",
        last_observed_at: "2026-10-21T00:01:00Z", peak_memory_bytes: peak * MIB, oom_killed: peak > 1000, exit_code: peak > 1000 ? 137 : 0 }] } };
}

test("collector keeps rerun identities separate in backend, run and assessment evidence while retaining same-identity reruns", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-profile-reruns-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "evals", evalId), frozen = identity(), frozenDigest = resourceProfileIdentityDigest(frozen);
  const manifest = { schema_version: "1", tasks: [{ task_id: "task-a", identity: frozen, identity_digest: frozenDigest, blocked_reasons: [] }] };
  const plan = buildEvalExecutionPlan({ evalId, request, candidate: { revisionIdentity: digest("revision"), artifactId: digest("artifact") },
    tasks: ["task-a"], maxParallelism: 1, taskResources: [requirement()], workItemMode: "task-slots",
    resourceProfiling: { schema_version: "1", unknown_max_parallelism: 1, requested_parallelism: 4, scope: "process", approvals: [], identity_manifest_digest: digest(manifest) } });
  await atomicWriteJSON(path.join(directory, "execution-plan.json"), plan);
  await atomicWriteJSON(path.join(directory, "resource-profile-identities.json"), manifest);
  const source = plan.work_items[0]!;
  const original = path.join(directory, "harbor", "work-items", source.work_id, "epoch-000001");
  await mkdir(path.join(original, "job"), { recursive: true });
  await atomicWriteJSON(path.join(original, "execution.json"), observation(source.work_id, 1, 100));
  for (const [index, kind] of ["same", "endpoint", "unknown", "verifier-same", "verifier-changed"].entries()) {
    const id = index + 2, rerunId = `rerun_${id.toString(16).repeat(32)}`, rerun = path.join(directory, "reruns", rerunId);
    const verifier = kind.startsWith("verifier"), changed = kind === "verifier-changed";
    const attempt = { schema_version: "1", id: endpointEvaluationAttemptId(endpoint("replacement")), parent_id: endpointEvaluationAttemptId(endpoint("original")), endpoint_binding: endpoint("replacement") };
    if (kind !== "unknown") await atomicWriteJSON(path.join(rerun, "request.json"), {
      schema_version: "1", eval_id: evalId, rerun_id: rerunId, rerun_type: verifier ? "verifier-only" : "candidate-restart",
      trials: [{ task_id: "task-a", attempt: 1 }], ...(kind === "endpoint" ? { endpoint_attempt: attempt } : {}),
      ...(changed ? { verifier_runtime_id: digest("replacement-runtime") } : {}),
    });
    let work = candidateRestartWorkItem(source, rerunId), backend = path.join(rerun, "harbor", "work-items", work.work_id, "epoch-000001");
    if (verifier) {
      const assessmentId = `assessment_${id.toString(16).repeat(32)}`, assessment = path.join(directory, "assessments", assessmentId);
      work = verifierOnlyWorkItem(source, rerunId, assessmentId, plan); backend = path.join(assessment, "evidence");
      await atomicWriteJSON(path.join(backend, "work.json"), work);
      await atomicWriteJSON(path.join(backend, "source.json"), { work_id: source.work_id, controller_runtime_id: digest("controller") });
      await atomicWriteJSON(path.join(assessment, "assessment.json"), { eval_id: evalId, task_id: "task-a", rerun_id: rerunId,
        controller_runtime_id: digest(changed ? "replacement-runtime" : "controller") });
    } else await mkdir(path.join(backend, "job"), { recursive: true });
    const execution = observation(work.work_id, id, kind === "same" ? 200 : kind === "verifier-same" ? 150 : 9000);
    await atomicWriteJSON(path.join(backend, "execution.json"), execution);
    if (kind === "endpoint") {
      const runId = `run_${"b".repeat(32)}`;
      await atomicWriteJSON(path.join(root, "runs", runId, "execution.json"), execution);
      await atomicWriteJSON(path.join(rerun, "result.json"), { trials: [{ task_id: "task-a", run_id: runId }] });
    }
  }
  const profile = await collectEvalResourceProfile({ root, evalId, taskId: "task-a" });
  assert.equal(profile.trials.length, 6);
  const sample = (index: number) => profile.trials.find(trial => trial.sample_id === `lease_${index.toString(16).repeat(32)}:1`)!;
  for (const index of [1, 2, 5]) assert.equal(sample(index).identity_digest, frozenDigest);
  for (const [index, issue] of [[3, "physical_profile_endpoint_changed"], [4, "physical_profile_identity_unavailable"], [6, "physical_profile_runtime_changed"]] as const) {
    assert.equal(sample(index).identity_digest, undefined); assert.ok(sample(index).blocked_reasons.includes(issue));
    assert.equal(sample(index).roles[0]!.oom_killed, true);
  }
  assert.ok(sample(3).additional_sources?.length);
  const recommendation = recommendResourceConfiguration(profile);
  assert.equal(recommendation.roles.find(role => role.component_id.startsWith("unattributed:"))!.observed_max_bytes, 200 * MIB);
  assert.equal(recommendation.lowering_eligible, false);
  assert.ok(recommendation.blocked_reasons.includes("oom_samples_prevent_lowering"));
  const unrelated = path.join(directory, "reruns", `rerun_${"9".repeat(32)}`);
  await mkdir(unrelated); await writeFile(path.join(unrelated, "request.json"), "invalid JSON");
  assert.equal((await collectEvalResourceProfile({ root, evalId, taskId: "task-a" })).profile_digest, profile.profile_digest);
  await writeFile(path.join(directory, "assessments", `assessment_${"5".repeat(32)}`, "evidence", "runtime-repair.json"), "invalid JSON");
  const malformed = await collectEvalResourceProfile({ root, evalId, taskId: "task-a" });
  const invalid = malformed.trials.find(trial => trial.sample_id === `lease_${"5".repeat(32)}:1`)!;
  assert.equal(invalid.identity_digest, undefined);
  assert.ok(invalid.blocked_reasons.includes("physical_profile_identity_unavailable"));
  assert.equal(malformed.trials.find(trial => trial.sample_id === `lease_${"1".repeat(32)}:1`)!.identity_digest, frozenDigest);
});

test("changed rerun bindings reject only selected work carrying an explicit old approval, including the rerun entry point", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-profile-rerun-approval-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "evals", evalId), approvalDigest = digest("approval");
  const plan = buildEvalExecutionPlan({ evalId, request, candidate: { revisionIdentity: digest("revision"), artifactId: digest("artifact") },
    tasks: ["task-a", "task-b"], maxParallelism: 1, taskResources: [requirement(), requirement("task-b")], workItemMode: "task-slots",
    resourceProfiling: { schema_version: "1", unknown_max_parallelism: 1, requested_parallelism: 4, scope: "process",
      approvals: [{ task_id: "task-a", identity_digest: digest("identity"), approval_digest: approvalDigest }] } });
  const baseline = { plan, request: { ...request, endpoint_binding: endpoint("original") }, controllerRuntimeId: digest("controller"), trials: [{ task_id: "task-a", attempt: 1 }] };
  const matches = (error: unknown) => (error as { code?: string }).code === "eval_rerun_resource_approval_changed" && /new eval plan/.test(String(error));
  assert.throws(() => assertRerunResourceApproval({ ...baseline, endpointBinding: endpoint("replacement") }), matches);
  assert.throws(() => assertRerunResourceApproval({ ...baseline, verifierRuntimeId: digest("replacement-runtime") }), matches);
  assert.doesNotThrow(() => assertRerunResourceApproval({ ...baseline, endpointBinding: endpoint("original"), verifierRuntimeId: digest("controller") }));
  assert.doesNotThrow(() => assertRerunResourceApproval({ ...baseline, endpointBinding: endpoint("replacement"), trials: [{ task_id: "task-b", attempt: 1 }] }));
  const legacy = structuredClone(plan); delete legacy.resource_profiling;
  for (const work of legacy.work_items) delete work.resource_profiling;
  assert.doesNotThrow(() => assertRerunResourceApproval({ ...baseline, plan: legacy, verifierRuntimeId: digest("replacement-runtime") }));
  await atomicWriteJSON(path.join(directory, "request.json"), request);
  await atomicWriteJSON(path.join(directory, "execution-plan.json"), plan);
  await atomicWriteJSON(path.join(directory, "plan.json"), { schema_version: "1", eval_id: evalId, attempts: 1, tasks: ["task-a", "task-b"],
    dataset: request.dataset, benchmark_id: request.benchmark_id, benchmark_revision: request.benchmark_revision,
    candidate: {}, prepared_artifacts: [{}], controller_runtime: { runtime_id: digest("controller") } });
  await atomicWriteJSON(path.join(directory, "progress.json"), createEvalProgress({ evalId, benchmarkId: request.benchmark_id,
    benchmarkRevision: request.benchmark_revision, plannedTasks: 2, plannedTrials: 2, startedAt: "2026-10-21T00:00:00Z" }));
  let admitted = false;
  await assert.rejects(rerunEval({ root, evalId, rerunType: "verifier-only", selector: { mode: "tasks", taskNames: ["task-a"] },
    verifierRuntimeId: digest("replacement-runtime"), workItemAdmission: { acquire: async () => { admitted = true; throw new Error("must not admit"); } } }), matches);
  assert.equal(admitted, false);
});
