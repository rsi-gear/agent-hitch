import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteJSON, hitchRootId, sha256JSON, statePaths } from "../src/foundation/index.js";
import type { ModelNodeBindingV2 } from "../src/domain/index.js";

// Real CLI and Python RPC; the archived prior boot and ML package metadata are fixtures.
// No reboot, Docker, CUDA, model loading, or old-PID signal is performed.
test("public generation recovery interoperates with Gear RPC and survives a lost controller receipt", {
  skip: !process.env.GEAR_TRAINING_NODE_PYTHONPATH,
}, async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hitch-generation-rpc-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "hitch"), packages = path.join(temporary, "fixture-packages");
  for (const name of ["sglang", "torch"]) {
    const metadata = path.join(packages, `${name}-0.0.0.dist-info`); await mkdir(metadata, { recursive: true });
    await writeFile(path.join(metadata, "METADATA"), `Name: ${name}\nVersion: 0.0.0\n`);
    await writeFile(path.join(metadata, "RECORD"), "fixture\n");
  }
  const env = { ...process.env, PYTHONPATH: [packages, process.env.GEAR_TRAINING_NODE_PYTHONPATH].join(path.delimiter) };
  const python = process.env.GEAR_TRAINING_TEST_PYTHON || "python3", configPath = path.join(temporary, "node.json");
  const config = { schemaVersion: 2, nodeId: "generation-fixture", nodeRoot: path.join(temporary, "node"), storeRoot: path.join(temporary, "cas"),
    jobConfigPath: path.join(temporary, "unused.json"), inferencePort: 31000 };
  await atomicWriteJSON(configPath, config);
  const serviceId = `inference_${"a".repeat(32)}`, inferenceId = sha256JSON("original-immutable-lock");
  const setup = JSON.parse((await promisify(execFile)(python, ["-c", seed, JSON.stringify({ config, serviceId, inferenceId, ownerId: hitchRootId(root) })], { env })).stdout);
  const old: ModelNodeBindingV2 = { schema_version: "2", node_id: config.nodeId, generation: setup.previous.generation,
    runtime_digest: setup.observation.runtimeDigest, launcher: "process" };
  const current = { ...old, generation: setup.observation.generation };
  const registrationFile = path.join(temporary, "registration.json"), bindingFile = path.join(temporary, "binding.json");
  await atomicWriteJSON(registrationFile, { schema_version: "2", binding: current, connection: { transport: { type: "local" }, python: [python], configPath,
    gateway: { localPort: config.inferencePort, nodePort: config.inferencePort } } });
  await atomicWriteJSON(bindingFile, current);
  const stateFile = path.join(statePaths(root).inferenceServices, serviceId, "state.json"), now = new Date().toISOString();
  const record = { schema_version: "1", service_id: serviceId, inference_id: inferenceId, isolation_key: sha256JSON("scope"), state: "ready", epoch: 3,
    owner_id: "controller-owner", lease_owner_ids: ["controller-owner"], backend: "cpu", model_node: old, service_handle: setup.handle, started_at: now, updated_at: now };
  await atomicWriteJSON(stateFile, record);
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ["dist/bin/hitch.js", "--root", root, ...args], { env, timeout: 20_000 })).stdout);
  await cli("model-node", "register", "--file", registrationFile);
  const before = await readFile(path.join(config.nodeRoot, "inference", serviceId, "identity.json"));
  const first = await cli("model-node", "recover-service", serviceId, "--file", bindingFile);
  assert.equal(first.resources_released, true); assert.equal(first.gpu_seconds, 0); assert.deepEqual(first.model_node, old);
  assert.deepEqual(first.generation_release.receipt.node, { nodeId: current.node_id, generation: current.generation });
  assert.deepEqual(first.generation_release.receipt.handle, setup.handle);
  // The node committed release, but the controller lost both final local writes.
  await rm(path.join(path.dirname(stateFile), "generation-release.json")); await atomicWriteJSON(stateFile, record);
  assert.deepEqual(await cli("model-node", "recover-service", serviceId, "--file", bindingFile), first);
  assert.deepEqual(await readFile(path.join(config.nodeRoot, "inference", serviceId, "identity.json")), before);
  await rm(configPath);
  assert.deepEqual(await cli("local", "inspect-service", serviceId), first);
  assert.equal(JSON.stringify(first).includes("old-private-token"), false);
});

const seed = `
import json, sys, time
from pathlib import Path
from gear_training.content import atomic_json, digest_json
from gear_training.node import NodeService
from gear_training.node_generation import record_generation
p=json.loads(sys.argv[1]); node=NodeService(p['config']); root=Path(p['config']['nodeRoot'])
previous={'nodeId':node.identity['nodeId'],'generation':'prior-generation-fixture'}
record_generation(root,{**previous,'bootIdentity':'prior-os-boot-fixture'})
directory=root/'inference'/p['serviceId']
identity={'node':previous,'ownerId':p['ownerId'],'inferenceId':p['inferenceId'],'inputDigest':digest_json('original-start')}
handle={'schema_version':'2','kind':'process','node_id':previous['nodeId'],'generation':previous['generation'],'service_id':p['serviceId'],'process':{'pid':42,'created_at':1.5}}
atomic_json(directory/'identity.json',identity)
atomic_json(directory/'status.json',{'schemaVersion':2,'state':'ready','resourcesReleased':False,'handle':handle})
atomic_json(directory/'access.json',{'engineToken':'old-private-token'})
owner='inference/'+p['serviceId']
atomic_json(root/'device-leases.json',{'schemaVersion':2,'owners':{digest_json(owner):{'owner':owner,'node':previous,'devices':[],'acquiredAt':time.time(),'processes':[{'pid':42,'createdAt':1.5}],'closing':False,'gpuSeconds':0}}})
print(json.dumps({'observation':node.probe(),'previous':previous,'handle':handle}))
`;
