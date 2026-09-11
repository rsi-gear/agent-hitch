import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { RemoteVerifierWorkV2, RemoteWorkOfferV1 } from "../src/domain/index.js";
import { buildEvalExecutionPlan, validateEvalId } from "../src/evals/index.js";
import { assertRemoteVerifierWork, parseRemoteVerifierWork } from "../src/evals/remote-verifier-contract.js";
import { verifierOnlyWorkItem } from "../src/evals/physical-work-plan.js";
import { RemoteWorkInputStore, prepareRemoteWorkInputs } from "../src/control-plane/remote-work-inputs.js";
import { validateRemoteOfferContract } from "../src/control-plane/remote-offer-contract.js";
import { parseRemoteWorkerRegistration } from "../src/control-plane/remote-workers.js";
import { RemoteWorkerRunner } from "../src/control-plane/remote-worker-runner.js";
import type { RemoteWorkerHttpClient } from "../src/control-plane/remote-worker-client.js";
import { parseRemoteHarborWorkSpec } from "../src/workers/remote-harbor-work-spec.js";
import { remoteHarborWorker } from "../src/workers/index.js";
import { sha256JSON } from "../src/foundation/index.js";
import { forceRemove } from "../test-support/helpers.js";

const sha = `sha256:${"a".repeat(64)}` as const, runId = `run_${"b".repeat(32)}`;
const assessmentId = `assessment_${"c".repeat(32)}`, rerunId = `rerun_${"d".repeat(32)}`;
function fixture() {
  const request = { schema_version: "1", backend: "harbor" as const, dataset: "dataset", harness_ref: "pi@version:1.2.3", model: "local/debug",
    attempts: 1, max_concurrent: 1, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0,
    timeout_ms: 900_000, setup_timeout_ms: 1_800_000, agent_args: [], pass_env: [], benchmark_id: "demo", benchmark_revision: "1.0" };
  const plan = buildEvalExecutionPlan({ evalId: validateEvalId(`eval_${"e".repeat(32)}`), request, tasks: ["one"], workItemMode: "task-slots",
    maxParallelism: 1, candidate: { revisionIdentity: sha, artifactId: sha }, provider: "remote-docker",
    trialResources: { cpu_millis: 1_000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 } });
  const original = plan.work_items[0]!;
  const physical = { schema_version: "2" as const, kind: "verifier-only" as const, source_work_id: original.work_id, rerun_id: rerunId, assessment_id: assessmentId };
  const work = verifierOnlyWorkItem(original, rerunId, assessmentId);
  const sourceTrial = { id: "native-trial-id", trial_name: "one__original", task_name: "one",
    agent_result: { metadata: { hitch_run_id: runId, controller_runtime_id: sha } } };
  const candidate = { run_id: runId, status: "succeeded", output: "original response" };
  const descriptor: RemoteVerifierWorkV2 = { schema_version: "2", kind: "verifier-only", assessment_id: assessmentId,
    source_ref: { trial_id: sourceTrial.trial_name, run_id: runId, task_id: "one", attempt: 1,
      observation_status: "invalid", invalid_reason: "verifier_result_missing" },
    source_manifest: { schema_version: "2", status: "available", task_id: "one", trial_id: sourceTrial.trial_name,
      run_id: runId, controller_runtime_id: sha, source_result_digest: sha256JSON(sourceTrial), original_result_digest: sha,
      source_bundle_digest: sha, source_config_digest: sha, task_digest: sha, artifacts_digest: sha, snapshot_digest: sha, regrade_config_digest: sha },
    source_trial: sourceTrial, candidate_result: candidate, candidate_result_digest: sha256JSON(candidate),
    canonical_bundle_digest: sha, verifier_runtime_id: sha };
  return { request, plan, work, physical, descriptor };
}

async function staged(root: string) {
  const f = fixture(), store = new RemoteWorkInputStore(root);
  const harness = path.join(root, "harness"), runtime = path.join(root, "runtime"), snapshot = path.join(root, "snapshot");
  const dataset = path.join(root, "dataset");
  for (const dir of [harness, runtime, snapshot, path.join(snapshot, "artifacts"), path.join(dataset, "one")]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(harness, "fixture.txt"), "pinned harness");
  await writeFile(path.join(runtime, "fixture.txt"), "pinned runtime");
  await writeFile(path.join(dataset, "one", "task.toml"), '[verifier]\nenvironment_mode = "separate"\n');
  await writeFile(path.join(snapshot, "benchmark-lifecycle.json"), '{"schema_version":"1","failure":null,"phases":{}}');
  await writeFile(path.join(snapshot, "regrade-config.json"), "{}");
  const input: Parameters<typeof prepareRemoteWorkInputs>[0] = { root, ...f, request: { ...f.request, dataset },
    physicalExecution: f.physical, runtimeDirectory: runtime, runtimeId: sha,
    verifierOnly: { descriptor: f.descriptor, sourceSnapshotDirectory: snapshot, verifierRuntimeDirectory: runtime },
    resolvedRevision: { schema_version: "1", requested_ref: f.request.harness_ref, canonical_ref: f.request.harness_ref,
      harness_id: "pi", selector: {}, source: {}, revision: {}, identity: sha, resolved_at: new Date().toISOString() } as never,
    preparedArtifact: { directory: harness, artifact_id: sha, artifact_integrity: sha, entrypoint_integrity: sha,
      harness_id: "pi", revision_identity: sha, adapter_version: "1", recipe_version: "1", platform: "linux/amd64", node_version: "22.0.0", source_type: "npm" } };
  const inputs = await prepareRemoteWorkInputs(input);
  const offer = { work: f.work, inputs, credential_names: [], lease: { eval_id: f.plan.eval_id, provider: f.plan.provider,
    lease_id: `lease_${"f".repeat(32)}`, epoch: 1 } } as unknown as RemoteWorkOfferV1;
  const raw = await readFile((await store.verify(inputs[0]!)).path, "utf8");
  return { ...f, input, inputs, offer, store, raw, spec: JSON.parse(raw) as Record<string, unknown> };
}

test("verifier work binds the original candidate, source runtime and invalid logical slot", () => {
  const f = fixture();
  assert.deepEqual(assertRemoteVerifierWork({ verifier: f.descriptor, ...f, runtimeId: sha }), f.descriptor);
  const invalid: unknown[] = [ { ...f.descriptor, assessment_id: "../escape" }, { ...f.descriptor, canonical_bundle_digest: "bad" },
    { ...f.descriptor, candidate_result: { ...f.descriptor.candidate_result, output: "changed" } },
    { ...f.descriptor, source_trial: { ...f.descriptor.source_trial, config: { credential: "private" } } },
    { ...f.descriptor, source_ref: { ...f.descriptor.source_ref, observation_status: "valid", reward: 1 } },
    { ...f.descriptor, source_ref: { ...f.descriptor.source_ref, invalid_reason: "agent_error" } },
    { ...f.descriptor, source_manifest: { ...f.descriptor.source_manifest, run_id: `run_${"a".repeat(32)}` } },
    { ...f.descriptor, source_manifest: { ...f.descriptor.source_manifest, regrade_config_digest: undefined } },
    { ...f.descriptor, source_manifest: { ...f.descriptor.source_manifest, original_result_digest: undefined } },
    { ...f.descriptor, unexpected_path: "/worker/private" } ];
  for (const value of invalid) assert.throws(() => parseRemoteVerifierWork(value));
  const trial = { ...f.descriptor.source_trial, agent_result: { metadata: { hitch_run_id: runId, controller_runtime_id: `sha256:${"b".repeat(64)}` } } };
  assert.throws(() => parseRemoteVerifierWork({ ...f.descriptor, source_trial: trial,
    source_manifest: { ...f.descriptor.source_manifest, source_result_digest: sha256JSON(trial) } }));
  for (const change of [{ physical: undefined }, { runtimeId: `sha256:${"b".repeat(64)}` },
    { verifier: { ...f.descriptor, source_ref: { ...f.descriptor.source_ref, attempt: 2 } } },
    { verifier: { ...f.descriptor, assessment_id: `assessment_${"b".repeat(32)}` } }]) {
    assert.throws(() => assertRemoteVerifierWork({ verifier: f.descriptor, ...f, runtimeId: sha, ...change }));
  }
});

test("verifier input transport preserves six pinned inputs and requires explicit scoring without model access", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-verifier-contract-")); t.after(() => forceRemove(root));
  const f = await staged(root), parsed = parseRemoteHarborWorkSpec(f.spec, f.offer);
  assert.equal(parsed.schema_version, "2"); assert.deepEqual(parsed.credential_names, []);
  assert.deepEqual(parsed.schema_version === "2" && parsed.verifier_only, f.descriptor);
  assert.equal(parsed.request.model, "local/debug"); assert.equal(f.raw.includes(root), false);
  assert.deepEqual(f.inputs.map(ref => ref.kind), ["work-spec", "harness-artifact", "controller-runtime", "task-input", "verifier-source", "verifier-runtime"]);
  const descriptorMissing = { ...f.spec }; delete descriptorMissing.verifier_only;
  const physicalMissing = { ...f.spec }; delete physicalMissing.physical_execution;
  for (const spec of [descriptorMissing, physicalMissing, { ...f.spec, verifier_source: "2" }, { ...f.spec, schema_version: "1" }]) {
    assert.throws(() => parseRemoteHarborWorkSpec(spec, f.offer));
  }
  for (const inputs of [f.inputs.slice(0, 5), [...f.inputs, f.inputs[5]!], f.inputs.map(ref => ref.kind === "verifier-source" ? { ...ref, format: "json" as const } : ref)]) {
    assert.throws(() => parseRemoteHarborWorkSpec(f.spec, { ...f.offer, inputs }));
  }
  await assert.rejects(prepareRemoteWorkInputs({ ...f.input, credentialNames: ["API_KEY"] }));
  await assert.rejects(prepareRemoteWorkInputs({ ...f.input, captureVerifierSource: true }));
  await assert.rejects(prepareRemoteWorkInputs({ ...f.input, physicalExecution: { schema_version: "2", kind: "candidate-restart", source_work_id: f.physical.source_work_id, rerun_id: rerunId } }));
  const features = { docker: true, buildkit: false, model_proxy: false, isolated_same_task_attempts: false, physical_work: "2" as const };
  await assert.rejects(validateRemoteOfferContract(f.offer, features, f.store), /verifier_only v2/);
  await validateRemoteOfferContract(f.offer, { ...features, verifier_only: "2" }, f.store);
  await assert.rejects(validateRemoteOfferContract({ ...f.offer, credential_names: ["API_KEY"] }, { ...features, verifier_only: "2" }, f.store));
  await assert.rejects(validateRemoteOfferContract({ ...f.offer, inputs: f.inputs.slice(0, 5) }, { ...features, verifier_only: "2" }, f.store));
  const inputMap = new Map(await Promise.all(f.inputs.map(async ref => [ref.kind, await readFile((await f.store.verify(ref)).path)] as const)));
  await assert.rejects(remoteHarborWorker({ root })({ offer: f.offer, inputs: inputMap, credentials: new Map(), signal: new AbortController().signal,
    emit: async () => {} }), /current controller execution lease grants/);
});

test("verifier source inputs reject private config and symlinks", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-verifier-private-")); t.after(() => forceRemove(root));
  const f = await staged(root), source = f.input.verifierOnly!.sourceSnapshotDirectory;
  await writeFile(path.join(source, "config.json"), '{"secret":"private-original-agent-config"}');
  await assert.rejects(prepareRemoteWorkInputs(f.input), /only recorded artifacts/);
  const clean = path.join(root, "clean-source"); await mkdir(clean);
  await symlink(source, path.join(clean, "artifacts"));
  await assert.rejects(prepareRemoteWorkInputs({ ...f.input, verifierOnly: { ...f.input.verifierOnly!, sourceSnapshotDirectory: clean } }));
});

test("verifier-only worker capability requires Docker and physical work v2, independent of model proxy", () => {
  const f = fixture(), features = { docker: true, buildkit: false, model_proxy: false, isolated_same_task_attempts: false,
    physical_work: "2", verifier_only: "2" };
  const value = { schema_version: "1", worker_id: "worker_verifier", provider: "remote-docker", collision_domain_id: "remote-docker",
    platforms: ["linux/amd64"], backends: [{ id: "harbor", version: "0.21.0" }], features, task_membership: ["known"],
    capacity: { total: f.work.reservation, allocatable: f.work.reservation,
      reserved_for_system: { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 } } };
  assert.equal(parseRemoteWorkerRegistration(value).features.verifier_only, "2");
  for (const change of [{ docker: false }, { physical_work: undefined }, { verifier_only: "1" }]) {
    assert.throws(() => parseRemoteWorkerRegistration({ ...value, features: { ...features, ...change } }));
  }
});

test("published verifier schemas preserve the physical and candidate-source boundary", async () => {
  const base = "https://agent-hitch.local/schemas/";
  const ajv = new Ajv2020({ strict: false, validateFormats: false, loadSchema: async uri => {
    assert.equal(new URL(uri).origin, "https://agent-hitch.local");
    return JSON.parse(await readFile(new URL(`../../docs/schemas/${path.basename(new URL(uri).pathname)}`, import.meta.url), "utf8"));
  } });
  const physical = await ajv.compileAsync({ $ref: `${base}remote-physical-execution.schema.json` });
  const verifier = await ajv.compileAsync({ $ref: `${base}remote-verifier-work.schema.json` });
  await ajv.compileAsync({ $ref: `${base}remote-harbor-work-spec.schema.json` });
  const f = fixture();
  assert.equal(physical(f.physical), true, ajv.errorsText(physical.errors));
  assert.equal(verifier(f.descriptor), true, ajv.errorsText(verifier.errors));
  assert.equal(physical({ ...f.physical, assessment_id: undefined }), false);
  assert.equal(verifier({ ...f.descriptor, source_trial: { ...f.descriptor.source_trial, config: {} } }), false);
  assert.equal(verifier({ ...f.descriptor, source_ref: { ...f.descriptor.source_ref, assessment: { id: assessmentId, digest: sha } } }), false);
});

for (const missingDescriptor of [false, true]) test(`worker runner ${missingDescriptor ? "rejects six-input candidate fallback before acceptance" : "delivers the six scoring inputs through its execution lifecycle"}`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-verifier-runner-")); t.after(() => forceRemove(root));
  const f = await staged(root);
  if (missingDescriptor) {
    delete f.spec.verifier_only;
    f.offer.inputs![0] = await f.store.put("work-spec", "json", Buffer.from(JSON.stringify(f.spec)));
  }
  let current = { ...f.offer, lease: { ...f.offer.lease, reservation: f.work.reservation }, state: "offered", offer_id: `offer_${"a".repeat(32)}` } as RemoteWorkOfferV1;
  let accepted = 0, executed = 0, released = 0, rejected = 0;
  const errors: unknown[] = [];
  const client = { listOffers: async () => [current], heartbeat: async () => {},
    downloadInput: async (_offer: unknown, ref: Parameters<RemoteWorkInputStore["verify"]>[0]) => readFile((await f.store.verify(ref)).path),
    accept: async () => { accepted++; return current = { ...current, state: "accepted" }; },
    reject: async () => { rejected++; current = { ...current, state: "rejected" }; },
    credentials: async () => ({ credentials: {} }), executionLease: async () => current.lease,
    complete: async () => current = { ...current, state: "release-requested" },
    release: async () => { released++; return current = { ...current, state: "released" }; },
    fencedSignal: new AbortController().signal,
  } as unknown as RemoteWorkerHttpClient;
  const runner = new RemoteWorkerRunner({ client, capacity: f.work.reservation, once: true, pollIntervalMs: 50, heartbeatIntervalMs: 1000,
    signal: AbortSignal.timeout(5000), onError: error => errors.push(error), execute: async input => {
      executed++; assert.equal(input.inputs.size, 6); assert.equal(typeof input.readExecutionLease, "function");
      return { status: "failed", artifacts: [], release: async () => {} };
    } });
  await runner.run(); assert.deepEqual(errors, []);
  assert.equal(rejected, missingDescriptor ? 1 : 0);
  assert.equal(accepted, missingDescriptor ? 0 : 1); assert.equal(executed, missingDescriptor ? 0 : 1); assert.equal(released, missingDescriptor ? 0 : 1);
});
