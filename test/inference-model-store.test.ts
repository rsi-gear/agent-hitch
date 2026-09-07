import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { statePaths } from "../src/foundation/index.js";
import { addLocalModel, gcLocalModels, resolveLocalModel, verifyLocalModel } from "../src/inference/index.js";
import { validateRunRequest } from "../src/runs/index.js";
import { validateEvalRequest } from "../src/evals/index.js";
import { safetensorsFixture } from "../test-support/helpers.js";

async function writeModel(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "config.json"), JSON.stringify({
    architectures: ["TinyForCausalLM"],
    model_type: "tiny",
    torch_dtype: "bfloat16",
    license: "apache-2.0",
  }));
  await writeFile(path.join(directory, "tokenizer.json"), "{}\n");
  await writeFile(path.join(directory, "tokenizer_config.json"), JSON.stringify({ chat_template: "{{ messages }}" }));
  await writeFile(path.join(directory, "model.safetensors"), safetensorsFixture());
}

test("local model import is content-addressed, resolvable, and integrity checked", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hitch-local-model-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "state");
  const source = path.join(temporary, "checkpoint-a");
  await writeModel(source);

  const first = await addLocalModel({ root, directory: source, name: "coder" });
  assert.equal(first.format, "hf-safetensors");
  assert.equal(first.model_type, "tiny");
  assert.equal(first.files.length, 4);
  assert.deepEqual(first.files.map((file) => file.path), [...first.files.map((file) => file.path)].sort());
  assert.equal((await resolveLocalModel(root, "local/coder")).model_id, first.model_id);
  assert.equal((await resolveLocalModel(root, `local/${first.model_id}`)).model_id, first.model_id);
  await verifyLocalModel(root, first);

  const secondSource = path.join(temporary, "checkpoint-b");
  await writeModel(secondSource);
  const second = await addLocalModel({ root, directory: secondSource, name: "same-bytes" });
  assert.equal(second.model_id, first.model_id, "source directory names must not affect model identity");

  const weight = first.files.find((file) => file.path === "model.safetensors")!;
  const storedWeight = path.join(statePaths(root).modelFiles, weight.sha256.slice("sha256:".length));
  await chmod(storedWeight, 0o600);
  await writeFile(storedWeight, "tampered\n");
  await assert.rejects(verifyLocalModel(root, first), (error: unknown) => (error as { code?: string }).code === "local_model_integrity_failed");
});

test("local model import rejects executable checkpoints, dynamic code, and symlinks", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hitch-local-model-reject-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "state");

  const pickle = path.join(temporary, "pickle");
  await writeModel(pickle);
  await writeFile(path.join(pickle, "pytorch_model.bin"), "pickle");
  await assert.rejects(addLocalModel({ root, directory: pickle, name: "pickle" }), /unsafe executable or pickle/);

  const dynamic = path.join(temporary, "dynamic");
  await writeModel(dynamic);
  await writeFile(path.join(dynamic, "config.json"), JSON.stringify({ model_type: "tiny", auto_map: { AutoModel: "model.py" } }));
  await assert.rejects(addLocalModel({ root, directory: dynamic, name: "dynamic" }), /trust_remote_code or auto_map/);

  const linked = path.join(temporary, "linked");
  await writeModel(linked);
  await symlink(path.join(linked, "model.safetensors"), path.join(linked, "duplicate.safetensors"));
  await assert.rejects(addLocalModel({ root, directory: linked, name: "linked" }), /symbolic link/);

  const malformed = path.join(temporary, "malformed-safetensors");
  await writeModel(malformed);
  await writeFile(path.join(malformed, "model.safetensors"), "not really safetensors\n");
  await assert.rejects(addLocalModel({ root, directory: malformed, name: "malformed" }), /safetensors header/);
});

test("local model GC is dry-run by default and preserves every referenced model file", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hitch-local-model-gc-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "state");
  const firstSource = path.join(temporary, "checkpoint-first");
  const secondSource = path.join(temporary, "checkpoint-second");
  await writeModel(firstSource);
  await writeModel(secondSource);
  await writeFile(path.join(secondSource, "config.json"), JSON.stringify({
    architectures: ["TinyV2ForCausalLM"], model_type: "tiny-v2", torch_dtype: "bfloat16",
  }));
  const first = await addLocalModel({ root, directory: firstSource, name: "coder" });
  const second = await addLocalModel({ root, directory: secondSource, name: "coder", force: true });
  assert.notEqual(first.model_id, second.model_id);

  const preview = await gcLocalModels(root);
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.models, [first.model_id]);
  assert.equal((await resolveLocalModel(root, `local/${first.model_id}`)).model_id, first.model_id);

  const applied = await gcLocalModels(root, true);
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.models, [first.model_id]);
  await assert.rejects(resolveLocalModel(root, `local/${first.model_id}`), /unavailable or invalid/);
  await verifyLocalModel(root, await resolveLocalModel(root, "local/coder"));
});

test("run and eval local inference inputs default safely and reject conflicting controls", async () => {
  const run = await validateRunRequest({
    harness_ref: "codex@installed",
    model: "local/coder",
    cwd: process.cwd(),
    prompt: "hello",
  });
  assert.deepEqual(run.local_inference, {
    model: "local/coder",
    device: "auto",
    profile: "baseline",
    offline: false,
  });

  await assert.rejects(validateRunRequest({
    harness_ref: "codex@installed",
    model: "openai/cloud",
    cwd: process.cwd(),
    prompt: "hello",
    local_inference: { device: "cpu" },
  }), /require a local/);
  await assert.rejects(validateRunRequest({
    harness_ref: "codex@installed",
    model: "local/coder",
    cwd: process.cwd(),
    prompt: "hello",
    local_inference: { inference_id: `sha256:${"a".repeat(64)}`, device: "cuda" },
  }), /cannot be combined/);

  const evaluation = await validateEvalRequest({
    backend: "harbor",
    dataset: "demo@1.0",
    harness_ref: "codex@version:1.2.3",
    model: "local/coder",
    local_inference: { device: "cuda", profile: "throughput", offline: true },
  });
  assert.deepEqual(evaluation.local_inference, {
    model: "local/coder",
    device: "cuda",
    profile: "throughput",
    offline: true,
  });
});
