import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EvalRequest, ExecutionEvidenceV1, ResourceProfileIdentityV1, Sha256 } from "../src/domain/index.js";
import { atomicWriteJSON, sha256JSON } from "../src/foundation/index.js";
import { approveResourceConfiguration, buildEvalExecutionPlan, buildTaskResourceProfileIdentity, collectEvalResourceProfile,
  createExecutionLease, ensurePhysicalRetryDecision, deriveTaskResourceRequirement, makeResourceProfile, matchApprovedResourceConfiguration, parseApprovedResourceConfiguration,
  parseResourceProfileIdentity, recommendResourceConfiguration, resourceProfileIdentityDigest, resourceProfileTrialFromExecution, validateEvalId } from "../src/evals/index.js";
import type { ResourceProfileTrialV1 } from "../src/evals/index.js";
import { mergeProfileObservations } from "../src/evals/resource-profile-collection.js";
import { resourcesCommand } from "../src/cli/commands/resources.js";
import { parseEvalRequest } from "../src/cli/arguments.js";

const digest = (value: string) => sha256JSON(value);
const MIB = 1024 ** 2;
const defaults = { cpu_millis: 1000, memory_bytes: 1024 * MIB, container_slots: 1, build_slots: 0 };
const request: EvalRequest = { schema_version: "1", backend: "harbor", dataset: "/missing-task-tree", harness_ref: "pi@version:1.2.3", model: "fixture/model",
  attempts: 1, max_concurrent: 4, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0, timeout_ms: 1000, setup_timeout_ms: 1000,
  agent_args: [], pass_env: [], benchmark_id: "fixture", benchmark_revision: "fixture" };
function identity(): ResourceProfileIdentityV1 {
  const tasks = [{ task_id: "task-a", task_digest: digest("task") }];
  return parseResourceProfileIdentity({ schema_version: "1", tasks, task_set_digest: sha256JSON(tasks),
    harness_artifact_digest: digest("artifact"), controller_runtime_digest: digest("controller"), runtime_contract_digest: digest("runtime"),
    role_images: [{ component_id: "main:main", image_digest: digest("image"), replicas: 1 }], platform: "linux/amd64",
    backend: { id: "harbor", version: "0.21.0", provider: "local-docker", lifecycle_digest: digest("lifecycle") },
    input_scale: { rows: 10 }, resource_parameters: { timeout_ms: 1000, limits: [{ component_id: "main:main", replicas: 1, resources: defaults }] } });
}
function requirement() {
  return deriveTaskResourceRequirement({ taskId: "task-a", defaultResources: defaults, defaultSource: "operator-default", declaration: {
    schema_version: "1", task: {}, verifier: { separate: false }, compose_services: [{ name: "main", replicas: 1 }],
    provider_sidecars: { main_egress: false, verifier_egress: false }, environment_images: [], environment_image_fallbacks: [], environment_builds: [] } });
}
function completeSample(index: number, peak = 100 * MIB): ResourceProfileTrialV1 {
  return { sample_id: `physical-${index}`, task_id: "task-a", identity_digest: resourceProfileIdentityDigest(identity()),
    source: { path: `provider-proof-${index}`, digest: digest(`proof-${index}`), trust: "provider-lifecycle-attestation" },
    input_case: { id: `case-${index}`, kind: index % 2 ? "stress" : "representative" },
    lifecycle: { complete: true, covered_phases: ["cold-start", "agent", "artifact-collection", "verifier", "exit"] },
    roles: [{ component_id: "main:main", container_id: `container-${index}`, memory_peak_bytes: peak, peak_kind: "terminal-kernel-peak", peak_semantics: "cgroup-usage",
      oom_killed: false, exit_code: 0, complete_lifetime: true }], blocked_reasons: [] };
}
function evidence(): ExecutionEvidenceV1 {
  return { schema_version: "1", provider: "local-docker", worker_id: "worker", collision_domain_id: "local", eval_id: `eval_${"a".repeat(32)}`,
    work_id: `work_${"b".repeat(32)}`, lease_id: `lease_${"c".repeat(32)}`, lease_epoch: 1, task_id: "task-a", reservation: defaults,
    enforced: { main_limits: defaults, sidecar_limits: {} }, observed: { status: "partial", started_at: "2026-10-21T00:00:00Z", collected_at: "2026-10-21T00:01:00Z",
      sample_count: 2, unavailable_fields: [], issues: [], containers: [{ container_id: "d".repeat(64), first_observed_at: "2026-10-21T00:00:00Z",
        last_observed_at: "2026-10-21T00:01:00Z", peak_memory_bytes: 300 * MIB, oom_killed: true, exit_code: 137 }] } };
}

test("resource profiles bind every identity dimension and exact current role limits for explicit approval", () => {
  const original = identity(), baseline = resourceProfileIdentityDigest(original);
  for (const mutate of [
    (value: ResourceProfileIdentityV1) => { value.harness_artifact_digest = digest("changed"); },
    (value: ResourceProfileIdentityV1) => { value.controller_runtime_digest = digest("changed"); },
    (value: ResourceProfileIdentityV1) => { value.runtime_contract_digest = digest("changed"); },
    (value: ResourceProfileIdentityV1) => { value.role_images[0]!.image_digest = digest("changed"); },
    (value: ResourceProfileIdentityV1) => { value.platform = "linux/arm64"; },
    (value: ResourceProfileIdentityV1) => { value.backend.lifecycle_digest = digest("changed"); },
    (value: ResourceProfileIdentityV1) => { value.backend.provider = "remote"; },
    (value: ResourceProfileIdentityV1) => { value.backend.version = "0.22.0"; },
    (value: ResourceProfileIdentityV1) => { value.input_scale.rows = 11; },
    (value: ResourceProfileIdentityV1) => { value.resource_parameters.timeout_ms = 2000; },
    (value: ResourceProfileIdentityV1) => { value.tasks[0]!.task_digest = digest("changed"); value.task_set_digest = sha256JSON(value.tasks); },
  ]) { const changed = structuredClone(original); mutate(changed); assert.notEqual(resourceProfileIdentityDigest(changed), baseline); }
  const approval = approveResourceConfiguration({ identity: original, role_limits: [{ component_id: "main:main", cpu_millis: 1000, memory_bytes: defaults.memory_bytes }], actor: "operator", reason: "explicitly accept this trial configuration" });
  assert.equal(matchApprovedResourceConfiguration(approval, original, requirement()).matched, true);
  const changed = structuredClone(original); changed.input_scale.rows = 11;
  assert.equal(matchApprovedResourceConfiguration(approval, changed, requirement()).matched, false);
  const smaller = approveResourceConfiguration({ identity: original, role_limits: [{ component_id: "main:main", cpu_millis: 1000, memory_bytes: 512 * MIB }], actor: "operator", reason: "different limits" });
  assert.equal(matchApprovedResourceConfiguration(smaller, original, requirement()).matched, false);
  assert.equal(matchApprovedResourceConfiguration(approval, undefined, requirement()).matched, false);
  assert.throws(() => parseApprovedResourceConfiguration({ ...approval, approval: { ...approval.approval, reason: "tampered" } }), /digest changed/);
});

test("recommendations use maxima plus stated margin, retain OOM failures, and treat P95 only as description", () => {
  const samples = Array.from({ length: 21 }, (_, i) => completeSample(i, (i === 20 ? 2000 : 100) * MIB));
  const profile = makeResourceProfile({ identity: identity(), trials: samples });
  const recommendation = recommendResourceConfiguration(profile);
  assert.equal(recommendation.lowering_eligible, true);
  assert.equal(recommendation.automatic_application, false);
  assert.equal(recommendation.current_role_limits[0]!.memory_bytes, defaults.memory_bytes);
  assert.equal(recommendation.min_complete_trials, 3);
  assert.equal(recommendation.roles[0]!.p95_descriptive_bytes, 100 * MIB);
  assert.equal(recommendation.roles[0]!.suggested_memory_bytes, 2500 * MIB);
  assert.equal(recommendResourceConfiguration(makeResourceProfile({ identity: identity(), trials: samples.slice(0, 2) })).lowering_eligible, false);
  const failed = completeSample(21); failed.lifecycle.complete = false; failed.roles[0]!.oom_killed = true; failed.roles[0]!.exit_code = 137;
  const blocked = recommendResourceConfiguration(makeResourceProfile({ identity: identity(), trials: [...samples, failed] }));
  assert.equal(blocked.all_trials, 22);
  assert.ok(blocked.blocked_reasons.includes("oom_samples_prevent_lowering"));
  assert.ok(blocked.roles.every(role => role.suggested_memory_bytes === undefined));
  assert.ok(blocked.actions.some(action => action.action === "retain_current_limits"));
  assert.ok(blocked.actions.some(action => action.action === "investigate_failures_and_rerun"));
  const unverified = completeSample(22); unverified.lifecycle.complete = false;
  assert.equal(recommendResourceConfiguration(makeResourceProfile({ identity: identity(), trials: [...samples, unverified] })).lowering_eligible, false);
  assert.throws(() => makeResourceProfile({ identity: identity(), trials: [samples[0]!, samples[0]!] }), /duplicate/);
});

test("historical partial samples and imports cannot become complete, and merging never discards an OOM", () => {
  const trial = resourceProfileTrialFromExecution({ evidence: evidence(), identityDigest: resourceProfileIdentityDigest(identity()),
    source: { path: "historical-mkt/execution.json", digest: digest("old"), trust: "frozen-eval-evidence" } });
  const next = structuredClone(trial); next.roles[0]!.oom_killed = false; next.roles[0]!.exit_code = 0;
  const merged = mergeProfileObservations(trial, next);
  assert.equal(merged.roles[0]!.oom_killed, true); assert.equal(merged.roles[0]!.exit_code, 137);
  const result = recommendResourceConfiguration(makeResourceProfile({ identity: identity(), trials: [trial] }));
  assert.equal(result.lowering_eligible, false);
  assert.equal(result.roles.find(role => role.component_id.startsWith("unattributed:"))!.observed_max_bytes, 300 * MIB);
  assert.equal(result.roles.find(role => role.component_id === "main:main")!.current_limits!.memory_bytes, defaults.memory_bytes);
  assert.ok(result.trial_eligibility[0]!.reasons.includes("terminal_kernel_peaks_not_proven"));
  const imported = completeSample(1); imported.source.trust = "operator-import";
  assert.equal(recommendResourceConfiguration(makeResourceProfile({ identity: identity(), trials: [imported] }), undefined, { min_complete_trials: 1 }).lowering_eligible, false);
});

test("planning identities bind immutable role image digests, backend version, environment values and changed task bytes", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-profile-identity-")); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "task.toml"), "first");
  const args = { taskId: "task-a", taskDirectory: directory, taskResources: requirement(), artifactDigest: digest("artifact"), controllerRuntimeDigest: digest("controller"),
    runtimeContract: { docker_platform: "linux/amd64", artifact_platform: "linux-x64", node_version: "22" }, request: { ...request, pass_env: ["SIZE"] }, provider: "local-docker", backendVersion: "0.21.0",
    environmentImages: [{ source: "compose" as const, service: "main", reference: `fixture@${digest("image")}` }], images: [], env: { SIZE: "10" } };
  const first = await buildTaskResourceProfileIdentity(args); assert.ok(first.identity_digest);
  const remote = await buildTaskResourceProfileIdentity({ ...args, provider: "remote-docker" });
  assert.equal(remote.identity, undefined);
  assert.ok(remote.blocked_reasons.includes("backend_version_unverified_on_provider"));
  assert.notEqual((await buildTaskResourceProfileIdentity({ ...args, env: { SIZE: "11" } })).identity_digest, first.identity_digest);
  await writeFile(path.join(directory, "task.toml"), "changed");
  assert.notEqual((await buildTaskResourceProfileIdentity(args)).identity_digest, first.identity_digest);
  assert.ok((await buildTaskResourceProfileIdentity({ ...args, environmentImages: [] })).blocked_reasons.some(reason => reason.startsWith("image_digest_unavailable")));
  const { backendVersion: _version, ...missingVersion } = args;
  assert.ok((await buildTaskResourceProfileIdentity(missingVersion)).blocked_reasons.includes("backend_version_unavailable"));
});

test("profile approvals bind frozen endpoint generation, environment binding and exact artifact pins without exposing secrets", async () => {
  const frozen: EvalRequest = { ...request, model: "endpoint/profile", pass_env: ["API_TOKEN"],
    environment_binding: `hmac-sha256:${"a".repeat(64)}`,
    endpoint_binding: { schema_version: "1", kind: "external-endpoint", endpoint_ref: "endpoint/profile", endpoint_revision: digest("endpoint"),
      api: "responses", wire_model: "model-one", capabilities: { streaming: true, tool_calls: true, parallel_tool_calls: false, input_modalities: ["text"] },
      generation: { max_output_tokens: 1024, temperature: 0 }, deployment_receipt: { schema_version: "1", model_digest: digest("model"), wire_model: "model-one",
        deployment_ref: "deployment-one", source: "fixture", service_config: { engine: "fixture", engine_version: "1" } } },
    artifact_pins: [{ platform: "linux-x64", artifact_id: digest("artifact"), artifact_integrity: digest("artifact-bytes"), entrypoint_integrity: digest("launcher") }] };
  const build = (value: EvalRequest) => buildTaskResourceProfileIdentity({ taskId: "task-a", taskDigest: digest("task"), taskResources: requirement(),
    artifactDigest: digest("artifact"), controllerRuntimeDigest: digest("controller"),
    runtimeContract: { docker_platform: "linux/amd64", artifact_platform: "linux-x64", node_version: "22" }, request: value,
    provider: "local-docker", backendVersion: "0.21.0", environmentImages: [{ source: "compose", service: "main", reference: `fixture@${digest("image")}` }],
    images: [], env: { API_TOKEN: "private-profile-secret" } });
  const baseline = await build(frozen); assert.ok(baseline.identity);
  assert.equal(JSON.stringify(baseline.identity).includes("private-profile-secret"), false);
  assert.equal(baseline.identity.resource_parameters.endpoint_binding_digest, sha256JSON(frozen.endpoint_binding));
  const approval = approveResourceConfiguration({ identity: baseline.identity,
    role_limits: [{ component_id: "main:main", cpu_millis: 1000, memory_bytes: defaults.memory_bytes }], actor: "operator", reason: "accept this frozen configuration" });
  for (const mutate of [
    (value: EvalRequest) => { value.endpoint_binding!.endpoint_revision = digest("different-endpoint"); },
    (value: EvalRequest) => { value.endpoint_binding!.generation.max_output_tokens = 4096; },
    (value: EvalRequest) => { value.endpoint_binding!.generation.temperature = 1; },
    (value: EvalRequest) => { value.endpoint_binding!.deployment_receipt!.model_digest = digest("different-model"); },
    (value: EvalRequest) => { value.endpoint_binding!.deployment_receipt!.service_config.engine_version = "2"; },
    (value: EvalRequest) => { value.environment_binding = `hmac-sha256:${"b".repeat(64)}`; },
    (value: EvalRequest) => { value.artifact_pins![0]!.artifact_integrity = digest("different-artifact-bytes"); },
    (value: EvalRequest) => { value.artifact_pins![0]!.entrypoint_integrity = digest("different-launcher"); },
  ]) {
    const changed = structuredClone(frozen); mutate(changed);
    const result = await build(changed);
    assert.notEqual(result.identity_digest, baseline.identity_digest);
    assert.equal(matchApprovedResourceConfiguration(approval, result.identity, requirement()).matched, false);
  }
  const privateBinding = { ...frozen.endpoint_binding!, connection: { base_url: "https://private-profile.invalid", auth: { kind: "env", name: "API_TOKEN" } } };
  await assert.rejects(build({ ...frozen, endpoint_binding: privateBinding }), /unknown fields/);
});

test("eval CLI profiles use frozen identity manifests without inspecting the current task tree and emit explicit approvals", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-profile-cli-")); t.after(() => rm(root, { recursive: true, force: true }));
  const evalId = validateEvalId(`eval_${"a".repeat(32)}`), evalDirectory = path.join(root, "evals", evalId);
  const manifest = { schema_version: "1", tasks: [{ task_id: "task-a", identity: identity(), identity_digest: resourceProfileIdentityDigest(identity()), blocked_reasons: [] }] };
  const plan = buildEvalExecutionPlan({ evalId, request, candidate: { revisionIdentity: digest("revision"), artifactId: digest("artifact") },
    tasks: ["task-a"], maxParallelism: 1, taskResources: [requirement()], workItemMode: "task-slots",
    resourceProfiling: { schema_version: "1", unknown_max_parallelism: 1, requested_parallelism: 4, scope: "process", approvals: [], identity_manifest_digest: sha256JSON(manifest) } });
  await atomicWriteJSON(path.join(evalDirectory, "execution-plan.json"), plan);
  await atomicWriteJSON(path.join(evalDirectory, "resource-profile-identities.json"), manifest);
  const backend = path.join(evalDirectory, "harbor", "work-items", plan.work_items[0]!.work_id, "epoch-000001");
  await mkdir(path.join(backend, "job"), { recursive: true });
  await atomicWriteJSON(path.join(backend, "execution.json"), { ...evidence(), work_id: plan.work_items[0]!.work_id });
  const profile = await collectEvalResourceProfile({ root, evalId, taskId: "task-a" });
  assert.equal(profile.identity_digest, resourceProfileIdentityDigest(identity()));
  assert.equal(profile.trials.length, 1);
  const output = path.join(root, "recommendation.json");
  await resourcesCommand(["recommend", "--eval", evalId, "--task", "task-a", "--output", output], root);
  assert.equal(JSON.parse(await readFile(output, "utf8")).lowering_eligible, false);
  const config = path.join(root, "configuration.json"), approved = path.join(root, "approved.json");
  await atomicWriteJSON(config, { identity: identity(), role_limits: [{ component_id: "main:main", cpu_millis: 1000, memory_bytes: defaults.memory_bytes }] });
  await resourcesCommand(["approve", "--config", config, "--actor", "operator", "--reason", "accept current explicit limits", "--output", approved], root);
  const parsed = parseEvalRequest(["--dataset", "/dataset", "--harness", "pi@version:1.2.3", "--resource-config", approved]);
  assert.equal(parseApprovedResourceConfiguration(parsed.resource_config).approval.actor, "operator");
  const retry = await ensurePhysicalRetryDecision({ evalDirectory, evalId, item: plan.work_items[0]!, retryIndex: 1,
    trigger: { trial_id: "failed-trial", run_id: `run_${"e".repeat(32)}`, task_id: "task-a", attempt: 1, observation_status: "invalid", invalid_reason: "infrastructure_failure" } });
  await createExecutionLease({ evalDirectory, evalId, workId: retry.retry_work_id!, worker: { workerId: "worker", provider: "local-docker", collisionDomainId: "local" }, reservation: defaults, ttlMs: 60000 });
  const withMissingRetry = await collectEvalResourceProfile({ root, evalId, taskId: "task-a" });
  assert.equal(withMissingRetry.trials.length, 2);
  assert.ok(withMissingRetry.trials.some(trial => trial.blocked_reasons.includes("execution_evidence_missing")));
  await atomicWriteJSON(path.join(evalDirectory, "resource-profile-identities.json"), { ...manifest, tasks: [] });
  await assert.rejects(collectEvalResourceProfile({ root, evalId, taskId: "task-a" }), /manifest changed/);
});
