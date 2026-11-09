import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { admitTaskParameters, validateParameterContract, type ParameterContract } from "../src/parameters/index.js";

const contract = (): ParameterContract => ({ version: 1, parameters: { folds: 5, metric: "score" },
  schema: { type: "object", properties: { folds: { type: "integer" }, metric: { type: "string" } }, required: ["folds", "metric"], additionalProperties: false },
  parameter_policy: { "/folds": { mutable: true, actors: ["meta", "target"], apply_at: "training_start" } },
  evaluation_paths: ["/metric"], evaluation_inputs: ["original/instruction.md", "original/resource.lock.json"], candidate_inputs: ["candidate"],
  candidate_parameters: "candidate/values.json" });

test("sealed original evaluation inputs stay comparable across candidate overlays and executions", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hitch-identity-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "original")); await mkdir(path.join(root, "candidate"));
  await writeFile(path.join(root, "parameters.json"), JSON.stringify(contract()));
  await writeFile(path.join(root, "original/instruction.md"), "Solve the fixed task");
  await writeFile(path.join(root, "original/resource.lock.json"), '{"data":"sealed-1","grader":"sealed-1"}');
  await writeFile(path.join(root, "candidate/prompt.md"), "first prompt");
  const admit = (dataset: string, repetition = 1) => admitTaskParameters(root, { identity: { task_id: "case", task: dataset + ":case", dataset, harness: "same-harness", repetition } });
  const baseline = (await admit("dataset-a"))!;
  await writeFile(path.join(root, "candidate/prompt.md"), "second prompt");
  const prompt = (await admit("dataset-b"))!;
  assert.equal(prompt.evaluation_id, baseline.evaluation_id); assert.notEqual(prompt.candidate_id, baseline.candidate_id); assert.notEqual(prompt.execution_id, baseline.execution_id);
  await writeFile(path.join(root, "candidate/values.json"), JSON.stringify({ version: 1, tasks: { case: { folds: 7, metric: "score" } } }));
  const method = (await admit("dataset-c"))!;
  assert.equal(method.evaluation_id, baseline.evaluation_id); assert.notEqual(method.candidate_id, prompt.candidate_id);
  const repetition = (await admit("dataset-c", 2))!;
  assert.equal(repetition.evaluation_id, method.evaluation_id); assert.equal(repetition.candidate_id, method.candidate_id); assert.notEqual(repetition.execution_id, method.execution_id);
  await writeFile(path.join(root, "original/resource.lock.json"), '{"data":"sealed-1","grader":"sealed-2"}');
  assert.notEqual((await admit("dataset-d"))!.evaluation_id, baseline.evaluation_id);
  await writeFile(path.join(root, "parameters.json"), JSON.stringify({ ...contract(), parameter_policy: { "/folds": { mutable: false } } }));
  await rm(path.join(root, "candidate/values.json"));
  assert.notEqual((await admit("dataset-d"))!.evaluation_id, method.evaluation_id);
});

test("identity declarations reject unsafe, missing, overlapping and symlink inputs", async t => {
  for (const inputs of [[], ["../outside"], ["a", "a"], ["/absolute"], ["a\\b"], ["a\0b"]]) assert.throws(() => validateParameterContract({ ...contract(), evaluation_inputs: inputs }), /safe relative/);
  const root = await mkdtemp(path.join(os.tmpdir(), "hitch-identity-unsafe-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "parameters.json"), JSON.stringify({ ...contract(), evaluation_inputs: ["missing"] }));
  await assert.rejects(admitTaskParameters(root), /ENOENT/);
  await mkdir(path.join(root, "candidate")); await writeFile(path.join(root, "candidate/file"), "content");
  await symlink("candidate/file", path.join(root, "link"));
  await writeFile(path.join(root, "parameters.json"), JSON.stringify({ ...contract(), evaluation_inputs: ["link"] }));
  await assert.rejects(admitTaskParameters(root), /symlink/);
  await writeFile(path.join(root, "parameters.json"), JSON.stringify({ ...contract(), evaluation_inputs: ["candidate"] }));
  await assert.rejects(admitTaskParameters(root), /regular files/);
  await writeFile(path.join(root, "parameters.json"), JSON.stringify({ ...contract(), evaluation_inputs: ["candidate/file"], candidate_inputs: ["candidate", "candidate/file"] }));
  await assert.rejects(admitTaskParameters(root), /overlapping/);
});

test("public candidate preparation preserves direct evaluation identity and is idempotent", async t => {
  const { prepareParameterCandidateInputs } = await import("../src/parameters/index.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "hitch-prepare-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "original"));
  const original = contract(); delete original.candidate_inputs; delete original.candidate_parameters;
  await writeFile(path.join(root, "parameters.json"), JSON.stringify(original));
  await writeFile(path.join(root, "original/instruction.md"), "fixed prompt");
  await writeFile(path.join(root, "original/resource.lock.json"), "fixed resources");
  const direct = (await admitTaskParameters(root, { identity: { task_id: "case", dataset: "direct", harness: "harness" } }))!;
  const prepared = await prepareParameterCandidateInputs(root, "candidate");
  assert.deepEqual(prepared!.schema, original.schema); assert.deepEqual(prepared!.parameters, original.parameters); assert.deepEqual(prepared!.parameter_policy, original.parameter_policy);
  await mkdir(path.join(root, "candidate")); await writeFile(path.join(root, "candidate/prompt.md"), "candidate one");
  await writeFile(path.join(root, "original/instruction.md"), "injected overlay");
  const compiled = (await admitTaskParameters(root, { identity: { task_id: "case", dataset: "compiled", harness: "harness" } }))!;
  assert.equal(compiled.evaluation_id, direct.evaluation_id); assert.notEqual(compiled.candidate_id, direct.candidate_id);
  assert.deepEqual(await prepareParameterCandidateInputs(root, "candidate"), prepared);
  const repeated = (await admitTaskParameters(root, { identity: { task_id: "case", dataset: "compiled", harness: "harness" } }))!;
  assert.equal(repeated.evaluation_id, compiled.evaluation_id); assert.equal(repeated.execution_id, compiled.execution_id);
  assert.throws(() => validateParameterContract({ ...prepared, evaluation_input_origins: { other: "same" } }), /map every input/);
  const collision = await mkdtemp(path.join(os.tmpdir(), "hitch-prepare-collision-")); t.after(() => rm(collision, { recursive: true, force: true }));
  await writeFile(path.join(collision, "parameters.json"), JSON.stringify(original)); await mkdir(path.join(collision, "gear-evaluation"));
  await assert.rejects(prepareParameterCandidateInputs(collision, "candidate"), /reserved/);
});
