import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { atomicWriteJSON, hitchRootId, readJSON, sha256JSON, statePaths } from "../src/foundation/index.js";
import { validateInferenceGenerationRelease } from "../src/inference/generation-recovery.js";
import { addLocalModel, buildInferenceLock, prepareLocalInference, registerModelNode, parseModelNodeRegistration,
  parseModelNodeBinding, validateInferenceLockShape, SGLangServiceSupervisor, ManagedSGLangLauncher } from "../src/inference/index.js";
import type { RunId, ModelNodeBindingV2, InferenceServiceRecordV1 } from "../src/domain/index.js";
import type { ModelNodeRegistrationV2 } from "../src/inference/index.js";
import { LocalInferenceManager, ResourceLedger } from "../src/control-plane/index.js";
import { validateEvalRequest } from "../src/evals/index.js";
import { parseEvalRequest } from "../src/cli/arguments.js";
import { managedHarborModelRuntime } from "../src/runs/local-inference-environment.js";
import { safetensorsFixture } from "../test-support/helpers.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-model-node-")), root = path.join(directory, "hitch");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "model"); await mkdir(source);
  await writeFile(path.join(source, "config.json"), JSON.stringify({ architectures: ["Qwen2ForCausalLM"], model_type: "qwen2", torch_dtype: "float32", max_position_embeddings: 128 }));
  await writeFile(path.join(source, "tokenizer.json"), "{}");
  await writeFile(path.join(source, "tokenizer_config.json"), JSON.stringify({ chat_template: "{{ messages }}" }));
  await writeFile(path.join(source, "model.safetensors"), safetensorsFixture());
  const model = await addLocalModel({ root, directory: source, name: "fixture" });
  const packages = [{ name: "sglang", version: "0.0.0", recordDigest: sha256JSON("fixture"), commit: null }];
  // This protocol peer supplies CPU fixtures; its claimed CUDA inventory is
  // test input, never hardware validation or proof of model inference.
  const runtime = { schemaVersion: 2, kind: "python-env", pythonVersion: "3.12.1", packagesDigest: sha256JSON(packages), packages,
    system: "Linux", machine: "x86_64", bridgeDigest: sha256JSON("bridge-fixture"), outerImageDigest: null };
  const observation = { nodeId: "gpu-fixture", generation: "boot-1", runtimeDigest: sha256JSON(runtime), runtime,
    gpuUuids: ["GPU-1234"], launchers: ["process"], capabilities: { binaryCas: true, durableInferenceProcesses: true } };
  const binding: ModelNodeBindingV2 = { schema_version: "2", node_id: observation.nodeId, generation: observation.generation,
    runtime_digest: observation.runtimeDigest, launcher: "process" };
  const configPath = path.join(directory, "node.json"), script = path.join(directory, "node-peer.mjs"), calls = path.join(directory, "calls.jsonl");
  await writeFile(configPath, JSON.stringify({ observation, calls })); await writeFile(script, peer);
  const registration: ModelNodeRegistrationV2 = { schema_version: "2", binding,
    connection: { transport: { type: "local" }, python: [process.execPath, script], configPath, gateway: { localPort: 31000, nodePort: 31000 } } };
  const registrationFile = path.join(directory, "registration.json"), bindingFile = path.join(directory, "binding.json");
  await writeFile(registrationFile, JSON.stringify(registration)); await writeFile(bindingFile, JSON.stringify(binding));
  const cli = async (args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ["dist/bin/hitch.js", "--root", root, ...args], { timeout: 15_000 })).stdout);
  const register = () => registerModelNode(root, registration);
  const plan = () => prepareLocalInference({ root, selection: { model: "local/fixture", device: "cuda", profile: "baseline", offline: true, model_node: binding },
    harnessRef: "training-tool@commit:" + "a".repeat(40), doctor: { deviceConstraint: "GPU-1234" } });
  return { directory, root, model, observation, binding, registration, registrationFile, bindingFile, configPath, calls, cli, register, plan };
}

test("public prior-generation recovery seals release without changing the original model lock", async t => {
  const f = await fixture(t); await f.register(); const { lock } = await f.plan();
  const serviceId = `inference_${"f".repeat(32)}`, now = new Date().toISOString();
  const handle = { schema_version: "2" as const, kind: "process" as const, node_id: f.binding.node_id, generation: f.binding.generation,
    service_id: serviceId, process: { pid: 123, created_at: 1.5 } };
  const record: InferenceServiceRecordV1 = { schema_version: "1", service_id: serviceId, inference_id: lock.inference_id, isolation_key: sha256JSON("scope"),
    state: "ready", epoch: 4, owner_id: "controller-run", lease_owner_ids: ["controller-run"], backend: "cuda", model_node: f.binding,
    service_handle: handle, started_at: now, updated_at: now };
  const stateFile = path.join(statePaths(f.root).inferenceServices, serviceId, "state.json");
  const { service_handle: _unobservedHandle, ...starting } = record;
  await atomicWriteJSON(stateFile, { ...starting, state: "starting" });
  const current = { ...f.binding, generation: "boot-2" };
  const receipt = { schemaVersion: 2 as const, kind: "inference-generation-release" as const, serviceId, ownerId: hitchRootId(f.root), inferenceId: lock.inference_id,
    previousNode: { nodeId: f.binding.node_id, generation: f.binding.generation }, node: { nodeId: current.node_id, generation: current.generation },
    sourceIdentityDigest: sha256JSON("original-node-ownership"), handle, admissionOnly: false, state: "stopped" as const, resourcesReleased: true as const,
    gpuSeconds: 42, devices: ["GPU-1234"], previousBootDigest: sha256JSON("os-boot-1"), currentBootDigest: sha256JSON("os-boot-2") };
  for (const change of [{ resourcesReleased: false }, { currentBootDigest: receipt.previousBootDigest }, { gpuSeconds: -1 }, { devices: ["GPU-1234", "GPU-1234"] },
    { handle: { ...handle, process: { pid: 124, created_at: 1.5 } } }, { node: receipt.previousNode }, { access: { engineToken: "private" } }]) {
    assert.throws(() => validateInferenceGenerationRelease(f.root, record, current, { ...receipt, ...change }));
  }
  await atomicWriteJSON(f.configPath, { observation: { ...f.observation, generation: current.generation }, calls: f.calls,
    recovery: receipt, projection: { file: stateFile, record },
    expectedRecovery: { serviceId, ownerId: hitchRootId(f.root), inferenceId: lock.inference_id, previousNode: receipt.previousNode, expectedHandle: null } });
  await atomicWriteJSON(f.registrationFile, { ...f.registration, binding: current });
  await atomicWriteJSON(f.bindingFile, current);
  await f.cli(["model-node", "register", "--file", f.registrationFile]);
  const output = await f.cli(["model-node", "recover-service", serviceId, "--file", f.bindingFile]);
  assert.equal(output.resources_released, true); assert.equal(output.gpu_seconds, 42); assert.deepEqual(output.model_node, f.binding);
  assert.equal(output.generation_release.receipt_digest, sha256JSON(receipt));
  assert.equal(JSON.stringify(output).includes(f.directory), false); assert.equal(JSON.stringify(output).includes("engineToken"), false);
  const ajv = new Ajv2020({ strict: false, validateFormats: false, loadSchema: async uri =>
    JSON.parse(await readFile(new URL(`../../docs/schemas/${path.basename(new URL(uri).pathname)}`, import.meta.url), "utf8")) });
  const validate = await ajv.compileAsync({ $ref: "https://agent-hitch.local/schemas/model-node-generation-release.schema.json" });
  assert.equal(validate(output.generation_release), true, ajv.errorsText(validate.errors));
  assert.equal(validate({ ...output.generation_release, receipt: { ...receipt, access: "private" } }), false);
  const stopped = await readJSON<InferenceServiceRecordV1>(stateFile);
  assert.equal(stopped.state, "stopped"); assert.deepEqual(stopped.model_node, record.model_node); assert.deepEqual(stopped.service_handle, record.service_handle);
  const calls = await readFile(f.calls, "utf8"); await rm(f.configPath);
  assert.deepEqual(await f.cli(["model-node", "recover-service", serviceId, "--file", f.bindingFile]), output);
  assert.deepEqual(await f.cli(["local", "inspect-service", serviceId]), output);
  // A crash after the receipt, before the outer state write, is reconciled locally.
  await atomicWriteJSON(stateFile, { ...record, state: "failed" });
  const supervisor = new SGLangServiceSupervisor({ root: f.root }); await supervisor.recover();
  assert.equal((await supervisor.list())[0]!.state, "stopped"); assert.equal(await readFile(f.calls, "utf8"), calls);
  const receiptFile = path.join(path.dirname(stateFile), "generation-release.json");
  await atomicWriteJSON(receiptFile, { ...output.generation_release, receipt: { ...receipt, gpuSeconds: 999 } });
  await assert.rejects(f.cli(["local", "inspect-service", serviceId]));
  assert.equal(await new ManagedSGLangLauncher().stopOrphan(f.root, record), "ambiguous");
});

test("public model-node registration and local plan freeze the actual node without Docker or controller paths", async t => {
  const f = await fixture(t);
  const registered = await f.cli(["model-node", "register", "--file", f.registrationFile]);
  assert.deepEqual(registered.binding, f.binding);
  assert.equal(JSON.stringify(registered).includes(f.configPath), false);
  const planned = await f.cli(["local", "plan", "local/fixture", "--harness", "training-tool@commit:" + "a".repeat(40),
    "--gpu", "GPU-1234", "--model-node-file", f.bindingFile, "--offline"]);
  assert.equal(planned.lock.schema_version, "2"); assert.deepEqual(planned.lock.model_node, f.binding);
  assert.equal(planned.lock.resources.container_slots, 0); assert.equal(planned.lock.resources.gpu_count, 1);
  assert.equal(planned.doctor, undefined); assert.equal(JSON.stringify(planned.lock).includes(f.directory), false);
  assert.deepEqual(await f.cli(["local", "inspect", planned.lock.inference_id]), planned.lock);
  assert.deepEqual(await f.cli(["model-node", "inspect", "--file", f.bindingFile]), f.observation);
  const dataset = path.join(f.directory, "tasks"); await mkdir(dataset);
  const raw = parseEvalRequest(["--dataset", dataset, "--harness", "model-call@version:1.0.0", "--model", "local/fixture", "--inference", planned.lock.inference_id, "--model-node-file", f.bindingFile]);
  const normalized = await validateEvalRequest(raw);
  assert.deepEqual(normalized.local_inference?.model_node, f.binding);
  assert.deepEqual((await validateEvalRequest({ ...raw, local_inference: normalized.local_inference })).local_inference, normalized.local_inference);
  assert.deepEqual(validateInferenceLockShape(planned.lock), planned.lock);
});

test("model-node plans refuse runtime drift, wrong GPU, missing capabilities and ambiguous connection input", async t => {
  const f = await fixture(t); await f.register(); await f.plan();
  await assert.rejects(prepareLocalInference({ root: f.root, selection: { model: "local/fixture", device: "cuda", profile: "baseline", offline: true, model_node: f.binding },
    doctor: { deviceConstraint: "GPU-5678" } }), /absent/);
  await writeFile(f.configPath, JSON.stringify({ observation: { ...f.observation, runtime: { ...f.observation.runtime, pythonVersion: "changed" } }, calls: f.calls }));
  await assert.rejects(f.plan(), /runtime.*changed/);
  await writeFile(f.configPath, JSON.stringify({ observation: { ...f.observation, capabilities: { binaryCas: true, durableInferenceProcesses: false } }, calls: f.calls }));
  await assert.rejects(f.register(), /capability changed/);
  assert.throws(() => parseModelNodeRegistration({ ...f.registration, connection: { ...f.registration.connection, gateway: { localPort: 31000, nodePort: 31001 } } }), /ports must match/);
  assert.throws(() => parseModelNodeBinding({ ...f.binding, host: "an-unfrozen-host" }), /unknown field/);
});

test("node identity affects inference hashes and JSON contracts require v2 lock provenance", async t => {
  const f = await fixture(t); const registered = await f.register(); const { lock } = await f.plan();
  const changed = buildInferenceLock(f.model, registered.runtime, { backend: "cuda", profile: "baseline", deviceConstraint: "GPU-1234",
    modelNode: { ...f.binding, generation: "boot-2" }, api: "chat-completions" });
  assert.notEqual(changed.inference_id, lock.inference_id);
  assert.throws(() => validateInferenceLockShape({ ...lock, model_node: changed.model_node }), /identity mismatch/);
  assert.throws(() => validateInferenceLockShape({ ...lock, schema_version: "1" }), /legacy/);
  const schema = JSON.parse(await readFile("docs/schemas/inference-lock.schema.json", "utf8"));
  const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
  assert.equal(validate(lock), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...lock, model_node: undefined }), false);
  assert.equal(validate({ ...lock, resources: { ...lock.resources, container_slots: 1 } }), false);
});

test("managed model-node services use node ownership without reserving controller GPUs", async t => {
  const f = await fixture(t); await f.register(); const prepared = await f.plan();
  const resources = new ResourceLedger({ cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0, gpu_count: 0 });
  let stopped = false;
  const supervisor = new SGLangServiceSupervisor({ root: f.root, launcher: { start: async input => ({
    service_handle: { schema_version: "2", kind: "process", node_id: f.binding.node_id, generation: f.binding.generation, service_id: input.serviceId,
      process: { pid: process.pid, created_at: Date.now() / 1000 } }, base_url: "http://127.0.0.1:31000", wire_model: "fixture", engine_token: "fixture-token", admin_token: "fixture-admin",
    observation: { schema_version: "2", observed_at: new Date().toISOString(), version: prepared.runtime.sglang_version, device: "cuda",
      dtype: prepared.lock.execution.dtype, kv_cache_dtype: prepared.lock.execution.kv_cache_dtype,
      attention_backend: prepared.lock.execution.attention_backend, sampling_backend: prepared.lock.execution.sampling_backend,
      context_length: prepared.lock.execution.context_tokens_per_request, max_total_num_tokens: prepared.lock.execution.max_total_tokens,
      max_running_requests: prepared.lock.execution.max_running_requests, gpu_uuid: "GPU-1234",
      probe: { api: prepared.lock.protocol.api, max_output_tokens: 8, streaming: true },
      runtime: { kind: "python-env", node_id: f.binding.node_id, generation: f.binding.generation, environment_digest: f.binding.runtime_digest,
        python_version: f.observation.runtime.pythonVersion, packages_digest: f.observation.runtime.packagesDigest, outer_image_digest: null } },
    stop: async () => { stopped = true; },
  }) } });
  const manager = new LocalInferenceManager({ root: f.root, resources, supervisor }); t.after(() => manager.close());
  const runId = `run_${"a".repeat(32)}`;
  const lease = await manager.acquire({ run_id: runId, harness_ref: "training-tool@commit:" + "a".repeat(40), cache_scope_owner: runId,
    selection: { model: "local/fixture", device: "auto", profile: "baseline", offline: true, inference_id: prepared.lock.inference_id, model_node: f.binding } });
  assert.equal(lease.binding.kind, "managed-node"); assert.deepEqual(lease.binding.model_node, f.binding);
  assert.equal(resources.snapshot().allocations.length, 0);
  assert.deepEqual((await manager.list())[0]?.model_node, f.binding);
  assert.equal((await manager.list())[0]?.isolation_key, sha256JSON({ inference_id: prepared.lock.inference_id, cache_scope_owner: runId }));
  const execution = JSON.parse(await readFile(path.join(f.root, "runs", runId, "inference", "execution.json"), "utf8"));
  assert.equal(execution.schema_version, "2"); assert.deepEqual(execution.model_node_observation, f.observation);
  await lease.release(); await manager.stop(lease.service_id); assert.equal(stopped, true);
});

test("recovery routes an unfinished startup through its saved node and refuses malformed ownership records", async t => {
  const f = await fixture(t); await f.register(); const { lock } = await f.plan();
  let dockerCalls = 0;
  const launcher = new ManagedSGLangLauncher({ start: async () => { dockerCalls++; throw new Error("unexpected Docker"); }, stopOrphan: async () => { dockerCalls++; return "stopped"; } });
  const record: InferenceServiceRecordV1 = { schema_version: "1", service_id: `inference_${"b".repeat(32)}`, inference_id: lock.inference_id, isolation_key: sha256JSON("scope"),
    state: "starting", epoch: 1, owner_id: "controller", lease_owner_ids: [], backend: "cuda", model_node: f.binding,
    started_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  assert.equal(await launcher.stopOrphan(f.root, record), "stopped"); assert.equal(dockerCalls, 0);
  assert.ok((await readFile(f.calls, "utf8")).includes('"operation":"inference.stop"'));
  const servicePath = path.join(statePaths(f.root).inferenceServices, record.service_id); await mkdir(servicePath, { recursive: true });
  await writeFile(path.join(servicePath, "state.json"), JSON.stringify({ ...record, model_node: { ...f.binding, runtime_digest: "corrupt" } }));
  await assert.rejects(new SGLangServiceSupervisor({ root: f.root, launcher }).recover(), /ownership is invalid/);
  assert.equal(dockerCalls, 0);
});

test("failed node preparation seals an owner stop before reporting a released startup", async t => {
  const f = await fixture(t); await f.register(); const prepared = await f.plan();
  const supervisor = new SGLangServiceSupervisor({ root: f.root });
  // This peer implements no CAS upload/prepare operation, so preparation fails
  // before an engine can start. Its stop operation is still durable/replayable.
  await assert.rejects(supervisor.acquire({ lock: prepared.lock, model: prepared.model, runtime: prepared.runtime,
    isolationKey: sha256JSON("prepare-failure"), ownerId: "fixture-owner" }));
  const record = (await supervisor.list())[0]!;
  assert.equal(record.state, "failed"); assert.notEqual(record.error?.code, "inference_recovery_ambiguous");
  assert.ok((await readFile(f.calls, "utf8")).includes('"operation":"inference.stop"'));
});

test("public service inspection reads terminal GPU usage without publishing node credentials", async t => {
  const f = await fixture(t); await f.register(); const { lock } = await f.plan();
  const serviceId = `inference_${"e".repeat(32)}`;
  const record = { schema_version: "1", service_id: serviceId, inference_id: lock.inference_id, isolation_key: sha256JSON("scope"),
    state: "failed", epoch: 1, owner_id: "controller", lease_owner_ids: [], backend: "cuda", model_node: f.binding,
    started_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const directory = path.join(statePaths(f.root).inferenceServices, serviceId); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "state.json"), JSON.stringify(record));
  const status = { schemaVersion: 2, state: "failed", inferenceId: lock.inference_id, resourcesReleased: false, gpuSeconds: 12.5,
    access: { engineToken: "private-node-secret" } };
  const configure = async (value: object) => writeFile(f.configPath, JSON.stringify({ observation: f.observation, calls: f.calls, status: value }));
  await configure(status);
  const observed = await f.cli(["local", "inspect-service", serviceId]);
  assert.equal(observed.resources_released, false); assert.equal(observed.gpu_seconds, 12.5);
  assert.equal(JSON.stringify(observed).includes("private-node-secret"), false);
  // Persisted ownership remains visible when no daemon is running.
  assert.equal((await f.cli(["local", "status", "--json"])).services[0].service_id, serviceId);
  await configure({ ...status, resourcesReleased: true, gpuSeconds: 13 });
  assert.equal((await f.cli(["local", "inspect-service", serviceId])).gpu_seconds, 13);
  await configure({ ...status, inferenceId: sha256JSON("foreign-lock") });
  await assert.rejects(f.cli(["local", "inspect-service", serviceId]), /usage\/ownership/);
  await configure({ ...status, state: "ready", resourcesReleased: true });
  await assert.rejects(f.cli(["local", "inspect-service", serviceId]), /usage\/ownership/);
  await configure({ ...status, gpuSeconds: -1 });
  await assert.rejects(f.cli(["local", "inspect-service", serviceId]), /usage\/ownership/);
});

test("Harbor proxy and canonical handoff retain the same model-node generation", async t => {
  const f = await fixture(t); const hash = sha256JSON("model");
  const identity = { inference_id: hash, model_id: hash, model_node: f.binding }, runId = `run_${"c".repeat(32)}` as RunId;
  const env = { HITCH_HARBOR_INTERNAL: "1", HITCH_MANAGED_LOCAL_INFERENCE: "1", HITCH_MANAGED_RUN_ID: runId,
    HITCH_MANAGED_INFERENCE_ID: hash, HITCH_MANAGED_MODEL_ID: hash, HITCH_MANAGED_NODE_BINDING: JSON.stringify(f.binding),
    OPENAI_API_KEY: "hitch-managed-local", OPENAI_BASE_URL: `http://host.docker.internal:1234/${"d".repeat(48)}/${runId}/openai` };
  assert.deepEqual(managedHarborModelRuntime(env, runId, identity).model_endpoint.model_node, f.binding);
  assert.throws(() => managedHarborModelRuntime(env, runId, { ...identity, model_node: { ...f.binding, generation: "other" } }), /handoff|environment/);
  const result = spawnSync("python3", ["-c", `
import json,sys
from pathlib import Path
sys.path.insert(0, "test-support")
from bridge_smoke import install_harbor_stubs, load_bridge
install_harbor_stubs()
sys.path.insert(0, "integrations/harbor")
bridge = load_bridge("integrations/harbor/hitch_harbor_agent.py")
identity = json.loads(sys.argv[1])
assert bridge._valid_managed_model_identity(identity)
bad = {**identity, "model_node": {**identity["model_node"], "launcher": "docker"}}
assert not bridge._valid_managed_model_identity(bad)
assert not bridge._valid_managed_model_identity({**identity, "model_node": {"node_id": "missing"}})
for topology in ("host-side", "in-sandbox"):
    route = {"schema_version": "1", "mode": "proxy", "required": True, "topology": topology,
        "base_url_template": "http://host.docker.internal:1234/" + "d" * 48 + "/{run_id}/{provider}",
        "health_url_template": "http://host.docker.internal:1234/" + "d" * 48 + "/{run_id}/health", "managed_inference": identity}
    assert bridge._validate_model_capture(route) == route
print("ok")
`, JSON.stringify(identity)], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
});

const peer = `
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8'));
let input = ''; for await (const chunk of process.stdin) input += chunk;
const envelope = JSON.parse(input);
appendFileSync(config.calls, JSON.stringify({operation: envelope.operation}) + '\\n');
const observed = config.observation;
let result;
if (envelope.operation === 'probe') result = observed;
else if (envelope.operation === 'inference.inspect') result = config.status;
else if (envelope.operation === 'inference.stop') result = {schemaVersion:2, state:'stopped', resourcesReleased:true, inferenceId:envelope.payload.inferenceId};
else if (envelope.operation === 'inference.recover') {
  if (JSON.stringify(envelope.payload) !== JSON.stringify(config.expectedRecovery)) throw new Error('recovery owner changed');
  if (config.projection) writeFileSync(config.projection.file, JSON.stringify(config.projection.record));
  result = config.recovery;
}
else throw new Error('unexpected fixture operation');
process.stdout.write(JSON.stringify({schemaVersion:2, requestId:envelope.requestId, inputDigest:envelope.inputDigest,
  node:{nodeId:observed.nodeId,generation:observed.generation}, result}));
`;
