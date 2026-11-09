import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { admitParameters, admitTaskParameters, parseParameterJSON, submitParameterAction, validateParameterContract, type ParameterContract } from "../src/parameters/index.js";

const defaults = () => ({ method: { folds: 5, seed: 42 }, budget: null, scoring: "accuracy" });
const contract = (): ParameterContract => ({ version: 1, parameters: defaults(),
  schema: { type: "object", required: ["method", "budget", "scoring"], additionalProperties: false, properties: {
    method: { type: "object", required: ["folds", "seed"], additionalProperties: false, properties: { folds: { type: "integer", minimum: 2, maximum: 12 }, seed: { type: "integer" } } },
    budget: { type: ["integer", "null"] }, scoring: { type: "string", enum: ["accuracy", "f1"] },
  } }, parameter_policy: {
    "/method/folds": { mutable: true, actors: ["meta", "target"], apply_at: "training_start", minimum: 3, maximum: 10 },
    "/method/seed": { mutable: false }, "/budget": { mutable: true, actors: ["meta"], apply_at: "task_start", minimum: 1, maximum: 50, nullable: true },
  }, evaluation_paths: ["/scoring"], capability_requirements: [{ path: "/budget", condition: "non_null", capability: "trusted-counter@1", coverage: "all top-level actions" }],
});

test("exact paths and final-value validation reject parent overwrite/deletion/unknown paths", () => {
  const s = admitParameters(contract());
  const altered = { ...defaults(), method: { folds: 6, seed: 99 } };
  const bad = submitParameterAction(s, "a", altered);
  assert.equal(bad.accepted, false);
  assert.equal(bad.state.effective.method && (bad.state.effective.method as { seed: number }).seed, 42);
  assert.ok(bad.state.audit.some(a => a.path === "/method/seed" && !a.accepted));
  const removed = { ...defaults(), method: { folds: 6 } };
  assert.equal(submitParameterAction(s, "b", removed).accepted, false);
  assert.equal(submitParameterAction(s, "c", { ...defaults(), unknown: 2 }).accepted, false);
  const mutableParent = contract(); mutableParent.parameter_policy["/method"] = { mutable: true, actors: ["target"], apply_at: "training_start" };
  assert.throws(() => admitParameters(mutableParent), /overlapping/);
  const unknown = contract(); unknown.parameter_policy["/missing"] = { mutable: false };
  assert.throws(() => admitParameters(unknown), /unknown parameter path/);
  const wildcard = contract(); wildcard.parameter_policy["/method/*"] = { mutable: false };
  assert.throws(() => admitParameters(wildcard), /JSON Pointer/);
});

test("JSON duplicates including escaped keys are rejected before parser loses declarations", () => {
  assert.throws(() => parseParameterJSON('{"/x":1,"\\u002fx":2}'), /duplicate/);
  assert.throws(() => parseParameterJSON('{"a":{"x":1,"x":2}}'), /duplicate/);
  assert.deepEqual(parseParameterJSON('{"a":[true,false,null,1e2,"x\\\"y"]}'), { a: [true, false, null, 100, 'x"y'] });
});

test("authorized Meta and Target choices create immutable action identities and preserve old facts", () => {
  const meta = { ...defaults(), method: { folds: 6, seed: 42 } };
  const baseline = admitParameters(contract(), { identity: { task: "dataset@1", harness: "base" } });
  const s = admitParameters(contract(), { meta, identity: { task: "dataset@1", harness: "candidate" } });
  assert.equal(s.evaluation_id, baseline.evaluation_id);
  assert.notEqual(s.candidate_id, baseline.candidate_id);
  assert.notEqual(s.execution_id, baseline.execution_id);
  const a = submitParameterAction(s, "first", { ...defaults(), method: { folds: 7, seed: 42 } });
  assert.equal(a.accepted, true);
  const b = submitParameterAction(a.state, "second", { ...defaults(), method: { folds: 8, seed: 42 } });
  assert.equal(b.accepted, true); assert.notEqual(a.action_id, b.action_id);
  assert.deepEqual(b.state.actions.first, a.state.actions.first);
  const replay = submitParameterAction(b.state, "first", { ...defaults(), method: { folds: 7, seed: 42 } });
  assert.equal(replay.action_id, a.action_id); assert.deepEqual(replay.state, b.state);
  const replacement = submitParameterAction(b.state, "first", defaults());
  assert.equal(replacement.accepted, false); assert.match(replacement.reason, /frozen/);
  assert.equal(b.state.compliance, "configuration_validated_execution_unverified");
});

test("task-start authority, nullable ranges, policy tightening and capabilities are fail-closed", () => {
  assert.doesNotThrow(() => admitParameters(contract()));
  assert.throws(() => admitParameters(contract(), { meta: { ...defaults(), budget: 20 } }), /unsupported_constraint/);
  assert.throws(() => admitParameters(contract(), { meta: { ...defaults(), method: { folds: 11, seed: 42 } } }), /range/);
  assert.throws(() => admitParameters(contract(), { policy: { "/method/seed": { mutable: true, actors: ["target"], apply_at: "training_start" } } }), /tighten/);
  const tightened = admitParameters(contract(), { policy: { "/method/folds": { mutable: true, actors: ["meta"], apply_at: "training_start", minimum: 4, maximum: 8 } } });
  assert.equal(submitParameterAction(tightened, "a", { ...defaults(), method: { folds: 6, seed: 42 } }).accepted, false);
  assert.doesNotThrow(() => admitParameters(contract(), { user: { ...defaults(), method: { folds: 6, seed: 42 } }, policy: { "/method/folds": { mutable: true, actors: ["meta"], apply_at: "training_start", minimum: 6, maximum: 8 } } }));
  for (const key of ["user", "meta", "policy"]) for (const value of [null, false, 0]) assert.throws(() => admitParameters(contract(), { [key]: value }), /object/);
  const nullable = contract(); nullable.parameters.budget = 2;
  delete nullable.parameter_policy["/budget"]!.nullable;
  nullable.capability_requirements = [];
  assert.throws(() => admitParameters(nullable, { policy: { "/budget": { ...nullable.parameter_policy["/budget"]!, nullable: true } } }), /tighten/);
  const unlocked = contract(); unlocked.capability_requirements = [];
  assert.equal(submitParameterAction(admitParameters(unlocked), "a", { ...defaults(), budget: 3 }).accepted, false);
  const evaluation = admitParameters(contract(), { user: { ...defaults(), scoring: "f1" } });
  assert.notEqual(evaluation.evaluation_id, admitParameters(contract()).evaluation_id);
});

test("mutating sandbox policy/effective copies cannot change the host authority", () => {
  const source = contract(), state = admitParameters(source);
  source.parameter_policy["/method/seed"] = { mutable: true, actors: ["target"], apply_at: "training_start" };
  const view = structuredClone(state); view.policy["/method/seed"] = source.parameter_policy["/method/seed"];
  const result = submitParameterAction(state, "attempt", { ...defaults(), method: { folds: 5, seed: 9 } });
  assert.equal(result.accepted, false);
  assert.equal(state.audit.length, 0);
});

test("sealed task candidate values use the same authority and conflicting sources reject", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hitch-params-")); t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "environment")); await mkdir(path.join(directory, "source"));
  await writeFile(path.join(directory, "parameters.json"), JSON.stringify({ ...contract(), candidate_parameters: "environment/candidate.json" }));
  const candidate = { version: 1, tasks: { task: { ...defaults(), method: { folds: 9, seed: 42 } } } };
  await writeFile(path.join(directory, "environment/candidate.json"), JSON.stringify(candidate));
  const state = await admitTaskParameters(directory, { identity: { task_id: "task" } });
  assert.deepEqual(state!.effective, candidate.tasks.task);
  await writeFile(path.join(directory, "source/task-parameters.json"), JSON.stringify(candidate));
  await assert.rejects(admitTaskParameters(directory, { harnessDirectory: directory, identity: { task_id: "task" } }), /conflicting/);
});

async function authority(args: string[], input: unknown, raw = false): Promise<{ code: number | null; value: any; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.resolve("dist/src/parameters/cli.js"), ...args]); let out = "", err = "";
    p.stdout.on("data", c => out += c); p.stderr.on("data", c => err += c); p.on("error", reject);
    p.on("close", code => resolve({ code, value: out ? JSON.parse(out) : null, stderr: err }));
    p.stdin.end(raw ? String(input) : JSON.stringify(input));
  });
}
test("concurrent host submissions serialize, retries preserve accepted actions, changed execution cannot reset", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hitch-authority-")); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "parameters.json"), JSON.stringify(contract()));
  const state = path.join(directory, "state.json");
  assert.equal((await authority(["init", state, directory], { task: "one", repetition: 1 })).code, 0);
  const submissions = await Promise.all([6, 7, 8].map(n => authority(["submit", state], { action: `a${n}`, parameters: { ...defaults(), method: { folds: n, seed: 42 } } })));
  assert.ok(submissions.every(r => r.code === 0 && r.value.accepted));
  for (const invalid of ["{\"action\":\"duplicate\",\"parameters\":{},\"parameters\":{}}", "{\"action\":5}", "{\"action\":\"../bad\",\"parameters\":{}}", "{\"action\":\"bad\",\"parameters\":null}"]) {
    const rejected = await authority(["submit", state], invalid, true);
    assert.equal(rejected.code, 0); assert.equal(rejected.value.accepted, false);
  }
  const before = JSON.parse(await readFile(state, "utf8"));
  assert.equal(before.audit.filter((row: { accepted: boolean }) => !row.accepted).length, 4); assert.equal(Object.keys(before.actions).length, 3);
  const resumed = await authority(["init", state, directory], { task: "one", repetition: 1 }); assert.deepEqual(resumed.value, before);
  const changed = await authority(["init", state, directory], { task: "one", repetition: 2 }); assert.notEqual(changed.code, 0); assert.match(changed.stderr, /identity changed/);
  assert.deepEqual(JSON.parse(await readFile(state, "utf8")), before);
});
