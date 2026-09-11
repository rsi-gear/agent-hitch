import test from "node:test";
import assert from "node:assert/strict";
import { chmod, cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Ajv2020 } from "ajv/dist/2020.js";
import { captureRemoteVerifierSource, verifyImportedRemoteVerifierSource, verifyRemoteVerifierSourceSnapshot } from "../src/evals/index.js";
import { encodeRemoteResultEnvelope, parseRemoteResultEnvelope } from "../src/control-plane/index.js";
import { encodeVerifierSource, importVerifierSource, parseVerifierSource } from "../src/control-plane/remote-verifier-source-transport.js";
import { writeResultBundleIndex } from "../src/runs/index.js";
import { atomicWriteJSON, sha256JSON, statePaths } from "../src/foundation/index.js";

async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-verifier-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = `run_${"a".repeat(32)}`, runtimeId = sha256JSON("runtime"), taskId = "one";
  const taskDirectory = path.join(root, "task"), trialDirectory = path.join(root, "trial"), bundleDirectory = path.join(root, "bundle"), destination = path.join(root, "snapshot");
  await mkdir(taskDirectory); await mkdir(path.join(trialDirectory, "artifacts", "empty"), { recursive: true });
  await writeFile(path.join(taskDirectory, "task.toml"), '[verifier]\nenvironment_mode = "separate"\n');
  await writeFile(path.join(trialDirectory, "artifacts", "patch.diff"), "candidate output\n");
  await chmod(path.join(trialDirectory, "artifacts", "patch.diff"), 0o640);
  const trial = { id: "source-trial-uuid", trial_name: "one__original", task_name: "one", agent_result: { metadata: { hitch_run_id: runId, controller_runtime_id: runtimeId } } };
  await atomicWriteJSON(path.join(trialDirectory, "result.json"), trial);
  await atomicWriteJSON(path.join(trialDirectory, "config.json"), { task: { path: taskDirectory },
    agent: { import_path: "hitch_harbor_agent:HitchHarborAgent", credential: "do-not-copy-private-agent-config" },
    environment: { type: "docker", import_path: "hitch_harbor_environment:HitchHarborDockerEnvironment" },
    verifier: { import_path: "hitch_harbor_verifier:HitchRetryingVerifier" } });
  await atomicWriteJSON(path.join(trialDirectory, "benchmark-lifecycle.json"), { schema_version: "1", failure: null, phases: { snapshot: { original: true } } });
  await atomicWriteJSON(path.join(trialDirectory, "hitch-final-response.json"), { schema_version: "1", source: "hitch-run-result", run_id: runId, termination: "succeeded", response: "done" });
  await atomicWriteJSON(path.join(bundleDirectory, "manifest.json"), { schema_version: "1", run_id: runId, sealed: true });
  await atomicWriteJSON(path.join(bundleDirectory, "result.json"), { run_id: runId, status: "succeeded", output: "done" });
  await writeResultBundleIndex(bundleDirectory);
  return { root, runId, runtimeId, taskId, taskDirectory, trialDirectory, bundleDirectory, destination, trial };
}

test("verifier source survives portable encoding with empty directories, file modes and canonical candidate identity", async t => {
  const f = await fixture(t), capture = await captureRemoteVerifierSource(f);
  assert.equal(capture.manifest.status, "available"); assert.equal(capture.directory, f.destination);
  const encoded = await encodeVerifierSource(capture);
  assert.equal(JSON.stringify(encoded).includes("do-not-copy-private-agent-config"), false);
  assert.equal(JSON.stringify(encoded).includes(f.root), false);
  const imported = path.join(f.root, "imported"); await mkdir(imported);
  await importVerifierSource({ source: encoded, trial: f.trial, trialDirectory: imported, taskId: f.taskId,
    taskDirectory: f.taskDirectory, bundleDirectory: f.bundleDirectory, runtimeId: f.runtimeId });
  await verifyRemoteVerifierSourceSnapshot({ manifest: capture.manifest, snapshotDirectory: path.join(imported, "verifier-source"),
    taskDirectory: f.taskDirectory, bundleDirectory: f.bundleDirectory });
  assert.equal(await readFile(path.join(imported, "verifier-source/artifacts/patch.diff"), "utf8"), "candidate output\n");
  assert.deepEqual(JSON.parse(await readFile(path.join(imported, "verifier-source.json"), "utf8")), capture.manifest);
  const base = { evalId: `eval_${"b".repeat(32)}`, workId: `work_${"c".repeat(32)}`, leaseId: `lease_${"d".repeat(32)}`, leaseEpoch: 1, trial: f.trial, bundleDirectory: f.bundleDirectory };
  const v1 = parseRemoteResultEnvelope(JSON.parse((await encodeRemoteResultEnvelope(base)).toString()));
  assert.equal(v1.schema_version, "1"); assert.equal(Object.hasOwn(v1, "verifier_source"), false);
  const v2 = parseRemoteResultEnvelope(JSON.parse((await encodeRemoteResultEnvelope({ ...base, verifierSource: capture })).toString()));
  assert.equal(v2.schema_version, "2"); assert.deepEqual(v2.files, v1.files, "canonical candidate bundle remains unchanged");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  for (const name of ["remote-tree-envelope", "remote-verifier-source", "remote-result-envelope"]) {
    ajv.addSchema(JSON.parse(await readFile(new URL(`../../docs/schemas/${name}.schema.json`, import.meta.url), "utf8")));
  }
  const validate = ajv.getSchema("https://agent-hitch.local/schemas/remote-result-envelope.schema.json")!;
  assert.equal(validate(v1), true, ajv.errorsText(validate.errors));
  assert.equal(validate(v2), true, ajv.errorsText(validate.errors));
  assert.equal(validate({ ...v2, schema_version: "1" }), false);
  assert.equal(validate({ ...v1, schema_version: "2" }), false);
  const extraSource = structuredClone(v2);
  if (extraSource.schema_version !== "2") assert.fail("expected v2");
  extraSource.verifier_source.tree!.files[0]!.path = "config.json";
  assert.equal(validate(extraSource), false);
});

test("missing or unsafe source evidence is recorded as unavailable without deleting an existing snapshot", async t => {
  const f = await fixture(t);
  await symlink("patch.diff", path.join(f.trialDirectory, "artifacts", "symlink"));
  assert.equal((await captureRemoteVerifierSource(f)).manifest.status, "unavailable");
  await rm(path.join(f.trialDirectory, "artifacts", "symlink"));
  await link(path.join(f.trialDirectory, "artifacts", "patch.diff"), path.join(f.trialDirectory, "artifacts", "hardlink"));
  assert.equal((await captureRemoteVerifierSource(f)).manifest.status, "unavailable");
  await rm(path.join(f.trialDirectory, "artifacts", "hardlink"));
  await atomicWriteJSON(path.join(f.trialDirectory, "hitch-final-response.json"), { schema_version: "1", source: "hitch-run-result", run_id: f.runId, termination: "succeeded", response: "substituted candidate" });
  assert.equal((await captureRemoteVerifierSource(f)).manifest.status, "unavailable");
  await mkdir(f.destination); await writeFile(path.join(f.destination, "existing"), "must remain");
  assert.equal((await captureRemoteVerifierSource(f)).manifest.status, "unavailable");
  assert.equal(await readFile(path.join(f.destination, "existing"), "utf8"), "must remain");
});

test("controller rejects altered source, task, runtime or candidate and extra private payloads", async t => {
  const f = await fixture(t), capture = await captureRemoteVerifierSource(f), encoded = await encodeVerifierSource(capture);
  const imported = path.join(f.root, "imported"); await mkdir(imported);
  const input = { source: encoded, trial: f.trial, trialDirectory: imported, taskId: f.taskId, taskDirectory: f.taskDirectory, bundleDirectory: f.bundleDirectory, runtimeId: f.runtimeId };
  await assert.rejects(importVerifierSource({ ...input, runtimeId: sha256JSON("other") }), /candidate\/task\/runtime/);
  await assert.rejects(importVerifierSource({ ...input, taskId: "other" }), /candidate\/task\/runtime/);
  await assert.rejects(importVerifierSource({ ...input, trial: { ...f.trial, id: "replacement" } }), /candidate\/task\/runtime/);
  const changed = structuredClone(encoded);
  if (changed.manifest.status !== "available") assert.fail("source must be available");
  changed.manifest.artifacts_digest = sha256JSON("substituted artifacts");
  await assert.rejects(importVerifierSource({ ...input, source: changed }), /snapshot digest mismatch/);
  await rm(path.join(imported, "verifier-source"), { recursive: true, force: true });
  await writeFile(path.join(f.taskDirectory, "task.toml"), "changed task");
  await assert.rejects(importVerifierSource(input), /snapshot digest mismatch/);
  const privateTree = structuredClone(encoded); privateTree.tree!.files[0]!.path = "agent/credentials.json";
  assert.throws(() => parseVerifierSource(privateTree), /only recorded artifacts|canonical/);
});

test("import receipt binds the controller publication and rejects partial import, source changes and resealed candidate substitution", async t => {
  const f = await fixture(t), capture = await captureRemoteVerifierSource(f), source = await encodeVerifierSource(capture);
  const imported = path.join(f.root, "imported"); await mkdir(imported);
  const seal = await importVerifierSource({ ...f, source, trialDirectory: imported });
  const canonical = path.join(statePaths(f.root).runs, f.runId);
  await cp(f.bundleDirectory, canonical, { recursive: true });
  // Canonical import may change observation/publication while preserving the candidate result.
  await atomicWriteJSON(path.join(canonical, "publication.json"), { controller: true });
  const index = await writeResultBundleIndex(canonical);
  assert.notEqual(sha256JSON(index), capture.manifest.status === "available" && capture.manifest.source_bundle_digest);
  const input = { root: f.root, runId: f.runId, trialDirectory: imported, taskDirectory: f.taskDirectory };
  await assert.rejects(verifyImportedRemoteVerifierSource(input), { code: "ENOENT" });
  await assert.rejects(seal({ root: f.root, runId: `run_${"e".repeat(32)}` }), /changed its candidate/);
  await seal({ root: f.root, runId: f.runId });
  assert.deepEqual(await verifyImportedRemoteVerifierSource(input), capture.manifest);
  const artifact = path.join(imported, "verifier-source/artifacts/patch.diff");
  await writeFile(artifact, "substituted artifact");
  await assert.rejects(verifyImportedRemoteVerifierSource(input), /snapshot digest mismatch/);
  await writeFile(artifact, "candidate output\n");
  await atomicWriteJSON(path.join(canonical, "result.json"), { run_id: f.runId, status: "succeeded", output: "replacement candidate" });
  await writeResultBundleIndex(canonical);
  await assert.rejects(verifyImportedRemoteVerifierSource(input), /import receipt does not match/);
  await assert.rejects(seal({ root: f.root, runId: f.runId }), /changed the candidate result/);
});

test("unavailable source can accompany a failed trial without candidate runtime metadata", async t => {
  const f = await fixture(t), trial = { trial_name: f.trial.trial_name, task_name: f.taskId, exception_info: "agent-start-failed" };
  const source = { manifest: { schema_version: "2" as const, status: "unavailable" as const, reason: "source-unavailable" as const,
    task_id: f.taskId, trial_id: trial.trial_name, run_id: f.runId, controller_runtime_id: f.runtimeId, source_result_digest: sha256JSON(trial) } };
  assert.throws(() => parseVerifierSource({ manifest: { ...source.manifest, reason: ["source-unavailable"] } }), /manifest identity is invalid/);
  const imported = path.join(f.root, "imported"); await mkdir(imported);
  const seal = await importVerifierSource({ ...f, source, trial, trialDirectory: imported });
  await seal({ root: f.root, runId: f.runId });
  assert.deepEqual(JSON.parse(await readFile(path.join(imported, "verifier-source.json"), "utf8")), source.manifest);
  await assert.rejects(verifyImportedRemoteVerifierSource({ root: f.root, runId: f.runId, trialDirectory: imported, taskDirectory: f.taskDirectory }), /unavailable/);
});
