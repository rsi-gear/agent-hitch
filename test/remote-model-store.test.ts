import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { ModelNodeBindingV2 } from "../src/domain/index.js";
import { atomicWriteJSON, sha256JSON, statePaths } from "../src/foundation/index.js";
import { addLocalModel, addModelFromNode, resolveLocalModel, verifyLocalModel, verifyModelOnNode } from "../src/inference/index.js";
import { safetensorsFixture } from "../test-support/helpers.js";

test("remote model registration verifies actual node CAS while keeping controller model files absent", {
  skip: !process.env.GEAR_TRAINING_NODE_PYTHONPATH,
}, async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hitch-remote-model-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "hitch"), source = path.join(temporary, "source"), nodeCas = path.join(temporary, "node-cas");
  await mkdir(source);
  await writeFile(path.join(source, "config.json"), JSON.stringify({ architectures: ["Qwen2ForCausalLM"], model_type: "qwen2", torch_dtype: "float32", max_position_embeddings: 128 }));
  await writeFile(path.join(source, "tokenizer.json"), "{}");
  await writeFile(path.join(source, "tokenizer_config.json"), JSON.stringify({ chat_template: "{{ messages }}" }));
  await writeFile(path.join(source, "model.safetensors"), safetensorsFixture());
  const expected = await addLocalModel({ root: path.join(temporary, "reference"), directory: source, name: "expected" });
  const configPath = path.join(temporary, "node.json");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 2, nodeId: "cpu-artifact-node", nodeRoot: path.join(temporary, "node"), storeRoot: nodeCas, jobConfigPath: path.join(temporary, "unused.json") }));
  const python = process.env.GEAR_TRAINING_TEST_PYTHON || "python3";
  const env = { ...process.env, PYTHONPATH: process.env.GEAR_TRAINING_NODE_PYTHONPATH };
  const observed = JSON.parse((await promisify(execFile)(python, ["-c", `
import json,sys
from gear_training.node import NodeService
from gear_training.export import seal_directory
node=NodeService(json.load(open(sys.argv[1])))
print(json.dumps({"probe":node.probe(),"snapshotRef":seal_directory(node.store,sys.argv[2],serving=True)}))
`, configPath, source], { env })).stdout);
  const binding: ModelNodeBindingV2 = { schema_version: "2", node_id: observed.probe.nodeId, generation: observed.probe.generation,
    runtime_digest: observed.probe.runtimeDigest, launcher: "process" };
  // CPU transport fixture: no CUDA admission or runtime certification is
  // asserted. All model reads and validation still use the real node process.
  const connection = { transport: { type: "local" }, python: ["env", `PYTHONPATH=${env.PYTHONPATH}`, python], configPath, gateway: { localPort: 31992, nodePort: 31992 } };
  await atomicWriteJSON(path.join(statePaths(root).inferenceNodes, sha256JSON(binding).slice(7) + ".json"), { schema_version: "2", binding, connection });
  await rm(source, { recursive: true }); await rm(path.join(temporary, "reference"), { recursive: true });
  const snapshotFile = path.join(temporary, "snapshot-ref.json"), bindingFile = path.join(temporary, "binding.json");
  await atomicWriteJSON(snapshotFile, observed.snapshotRef); await atomicWriteJSON(bindingFile, binding);
  const cli = path.resolve("dist/bin/hitch.js");
  const invoke = (args: string[]) => promisify(execFile)(process.execPath, [cli, "--root", root, ...args]);
  const registered = JSON.parse((await invoke(["models", "add-node", snapshotFile, "--model-node-file", bindingFile, "--name", "remote", "--json"])).stdout);
  assert.equal(registered.model_id, expected.model_id);
  assert.deepEqual(registered.files, expected.files);
  const model = await resolveLocalModel(root, "local/remote");
  await verifyModelOnNode(root, model, binding);
  await assert.rejects(verifyLocalModel(root, model), (e: any) => e.code === "local_model_integrity_failed");
  await assert.rejects(readdir(statePaths(root).modelFiles), (e: any) => e.code === "ENOENT");
  assert.equal(JSON.parse((await invoke(["models", "inspect", "local/remote", "--verify", "--model-node-file", bindingFile, "--json"])).stdout).verified, true);
  assert.equal((await addModelFromNode(root, "remote", observed.snapshotRef, binding)).created_at, model.created_at);
  const weight = model.files.find(file => file.path.endsWith(".safetensors"))!;
  await writeFile(path.join(nodeCas, "objects", weight.sha256.slice(7, 9), weight.sha256.slice(7)), "corrupt");
  await assert.rejects(verifyModelOnNode(root, model, binding), /corrupt-content/);
  await assert.rejects(addModelFromNode(root, "corrupted", observed.snapshotRef, binding), /corrupt-content/);
  await assert.rejects(resolveLocalModel(root, "local/corrupted"));
  await assert.rejects(verifyModelOnNode(root, model, { ...binding, generation: "another-generation" }));
});
