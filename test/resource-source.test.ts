import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveResourceDatasetSource, verifyResourceDatasetSource, resourceRequest, configuredResourceStore, ResourceStore } from "../src/resources/index.js";

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hitch-source-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "dataset"), task = path.join(directory, "case-1"); await mkdir(task, { recursive: true });
  const original = JSON.parse(await readFile("test-contracts/hitch-resources-v1.json", "utf8")).dataset;
  await writeFile(path.join(task, "resource.lock.json"), JSON.stringify(original.tasks[0].lock));
  await writeFile(path.join(task, "task.toml"), 'schema_version="1.4"\n');
  await writeFile(path.join(task, "instruction.md"), "fixed task");
  await mkdir(path.join(task, "empty"));
  return { root, directory, task, original };
}
test("pure descriptor derive matches CAS tree sealing and source-only ingestion needs no resources or images", async t => {
  const f = await fixture(t), derived = await deriveResourceDatasetSource(f.directory, f.original);
  assert.equal(derived.schema_version, "3"); assert.notEqual(derived.tasks[0]!.source_task_digest, f.original.tasks[0].source_task_digest);
  assert.equal(derived.tasks[0]!.resource_closure_digest, f.original.tasks[0].resource_closure_digest);
  const store = new ResourceStore(path.join(f.root, "cas"));
  const imported = await store.import(f.task, "tree", "parity");
  assert.deepEqual(derived.tasks[0]!.sourceTree, imported.resource); await store.finishLease(imported.leaseId, "ended");
  await writeFile(path.join(f.directory, "benchmark.adapter.json"), JSON.stringify(derived));
  assert.deepEqual(await verifyResourceDatasetSource(f.directory), derived);
  const state = path.join(f.root, "state");
  assert.deepEqual(await resourceRequest(state, "ingest-dataset-source", { directory: f.directory }), derived);
  const { store: target } = await configuredResourceStore(state);
  assert.ok((await target.objects.readTree(derived.tasks[0]!.sourceTree.manifestDigest)).entries.some(entry => entry.path === "empty"));
  await writeFile(path.join(f.task, "instruction.md"), "candidate overlay");
  await assert.rejects(verifyResourceDatasetSource(f.directory), /changed since sealing/);
  const changed = await deriveResourceDatasetSource(f.directory, derived);
  assert.notEqual(changed.dataset_digest, derived.dataset_digest);
  assert.equal(changed.tasks[0]!.resource_closure_digest, derived.tasks[0]!.resource_closure_digest);
  await chmod(path.join(f.task, "instruction.md"), 0o755);
  assert.notEqual((await deriveResourceDatasetSource(f.directory, changed)).dataset_digest, changed.dataset_digest);
});
test("pure source APIs reject lock changes, unsafe inputs, foreign versions, and membership drift", async t => {
  const f = await fixture(t), derived = await deriveResourceDatasetSource(f.directory, f.original);
  await assert.rejects(deriveResourceDatasetSource(f.directory, { ...derived, schema_version: "2" }), /unsupported resource dataset/);
  await assert.rejects(deriveResourceDatasetSource(f.directory, derived, ["missing"]), /selection/);
  const lock = structuredClone(derived.tasks[0]!.lock); lock.requiredCapabilities.push("tree@1");
  await writeFile(path.join(f.task, "resource.lock.json"), JSON.stringify(lock));
  await assert.rejects(deriveResourceDatasetSource(f.directory, derived), /lock changed/);
  await writeFile(path.join(f.task, "resource.lock.json"), JSON.stringify(derived.tasks[0]!.lock));
  await symlink("instruction.md", path.join(f.task, "link"));
  await assert.rejects(deriveResourceDatasetSource(f.directory, derived), /symlinks/); await rm(path.join(f.task, "link"));
  await mkdir(path.join(f.directory, "extra")); await writeFile(path.join(f.directory, "extra/task.toml"), "schema_version='1.4'");
  await assert.rejects(verifyResourceDatasetSource(f.directory, derived), /membership/);
});

test("resource materialization keeps original evaluation identity through image labels and candidate overlays", async t => {
  const { resourceFixture } = await import("../test-support/resource-fixture.js");
  const { sealResourceTask, preflightResourceTask, materializeResourceTask, finishResourceWorkspace } = await import("../src/resources/index.js");
  const { admitTaskParameters, prepareParameterCandidateInputs } = await import("../src/parameters/index.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "hitch-materialized-identity-")); t.after(() => rm(root, { recursive: true, force: true }));
  const f = await resourceFixture(root, 1), source = path.join(f.source, "task-0");
  await writeFile(path.join(source, "parameters.json"), JSON.stringify({ version: 1, parameters: { metric: "score" },
    schema: { type: "object", properties: { metric: { type: "string" } }, required: ["metric"], additionalProperties: false },
    parameter_policy: {}, evaluation_paths: ["/metric"], evaluation_inputs: ["instruction.md", "resource.lock.json", "environment/candidate/Dockerfile", "tests/Dockerfile"] }));
  const original = (await admitTaskParameters(source, { identity: { task_id: "task-0" } }))!;
  const materialize = async (owner: string) => {
    const task = await sealResourceTask(f.store, source, "task-0", owner + ":producer");
    const { plan } = await preflightResourceTask(f.store, task, { platform: f.dataset.execution.platform, owner, generation: 1 });
    return materializeResourceTask(f.store, plan, { owner: owner + ":execution", generation: 1, policy: { mode: "copy", maxCopyBytes: 1024 * 1024, maxWorkspaces: 1 } });
  };
  const direct = await materialize("direct");
  assert.match(await readFile(path.join(direct.taskDirectory, "environment/candidate/Dockerfile"), "utf8"), /LABEL dev.hitch.resource.plan/);
  assert.equal((await admitTaskParameters(direct.taskDirectory, { identity: { task_id: "task-0" } }))!.evaluation_id, original.evaluation_id);
  await finishResourceWorkspace(f.store, direct.id, { executionEnded: true, resultSealed: true });
  await prepareParameterCandidateInputs(source, "environment/candidate/gear-target");
  await mkdir(path.join(source, "environment/candidate/gear-target"));
  await writeFile(path.join(source, "environment/candidate/gear-target/prompt.md"), "candidate prompt");
  await writeFile(path.join(source, "environment/candidate/Dockerfile"), (await readFile(path.join(source, "environment/candidate/Dockerfile"), "utf8")) + "# candidate overlay\n");
  const compiled = (await admitTaskParameters(source, { identity: { task_id: "task-0" } }))!, candidate = await materialize("candidate");
  const executed = (await admitTaskParameters(candidate.taskDirectory, { identity: { task_id: "task-0" } }))!;
  assert.equal(executed.evaluation_id, original.evaluation_id); assert.equal(executed.candidate_id, compiled.candidate_id);
  assert.notEqual(executed.candidate_id, original.candidate_id);
  await finishResourceWorkspace(f.store, candidate.id, { executionEnded: true, resultSealed: true });
});
