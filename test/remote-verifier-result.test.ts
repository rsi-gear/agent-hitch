import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { encodeRemoteVerifierResultEnvelope, parseRemoteVerifierResultEnvelope } from "../src/control-plane/remote-verifier-result.js";
import { importRemoteVerifierResultEnvelope } from "../src/control-plane/remote-verifier-import.js";
import { parseRemoteResultEnvelope } from "../src/control-plane/index.js";
import { loadRemoteVerifierSource, remoteVerifierTrialName } from "../src/evals/index.js";
import { readRegradeObservation } from "../src/evals/regrade-evidence.js";
import { verifyResultBundleIndex } from "../src/runs/index.js";
import { atomicWriteJSON, sha256JSON } from "../src/foundation/index.js";
import { remoteVerifierFixture } from "../test-support/remote-verifier.js";

async function encoded(f: Awaited<ReturnType<typeof remoteVerifierFixture>>, score = 1, log = "tests passed\n") {
  const lease = f.owner.current(), verifierDirectory = path.join(f.root, "worker-verifier");
  await mkdir(path.join(verifierDirectory, "empty"), { recursive: true });
  await writeFile(path.join(verifierDirectory, "test-stdout.txt"), log); await chmod(path.join(verifierDirectory, "test-stdout.txt"), 0o640);
  const outcome = { trial: { ...f.descriptor.source_trial, trial_name: remoteVerifierTrialName(f.descriptor.assessment_id),
      agent_setup: null, agent_execution: null, verifier_result: { rewards: { reward: score, total_score: score } } },
    backend: { process_exit_code: 0, signal: null, config_path: "/worker/private/config.json" },
    execution: { ...f.execution, work_id: lease.work_id, lease_id: lease.lease_id, lease_epoch: lease.epoch,
      worker_id: lease.worker_id, collision_domain_id: lease.collision_domain_id },
    source_manifest_digest: sha256JSON(f.descriptor.source_manifest), candidate_result_digest: sha256JSON(f.descriptor.candidate_result),
    config_digest: sha256JSON("restored-config"), controller_runtime_id: f.descriptor.verifier_runtime_id, trial_directory: path.dirname(verifierDirectory) };
  const body = await encodeRemoteVerifierResultEnvelope({ lease, verifier: f.descriptor, outcome, verifierDirectory });
  const artifactPath = path.join(f.root, "artifact.json"); await writeFile(artifactPath, body);
  const args = { root: f.root, evalDirectory: f.evalDirectory, verifier: f.descriptor, plan: f.plan, work: f.work, physical: f.physical, lease, artifactPath };
  return { body, outcome, verifierDirectory, args };
}

test("remote assessment preserves the canonical candidate and replays an atomic publication", async t => {
  const f = await remoteVerifierFixture(t), before = sha256JSON(await verifyResultBundleIndex(f.runDirectory));
  const source = await loadRemoteVerifierSource({ root: f.root, evalDirectory: f.evalDirectory, evalId: f.evalId, provider: f.plan.provider,
    sourceRef: f.descriptor.source_ref, taskDirectory: f.taskDirectory, benchmarkId: f.plan.benchmark.id, benchmarkRevision: f.plan.benchmark.revision });
  assert.equal(source.trialDirectory, f.trialDirectory, "source follows the physical candidate-restart work, not the original logical work");
  const r = await encoded(f), envelope = parseRemoteVerifierResultEnvelope(JSON.parse(r.body.toString()));
  const ajv = new Ajv2020({ strict: false, validateFormats: false, loadSchema: async uri =>
    JSON.parse(await readFile(new URL(`../../docs/schemas/${path.basename(new URL(uri).pathname)}`, import.meta.url), "utf8")) });
  const schema = await ajv.compileAsync({ $ref: "https://agent-hitch.local/schemas/remote-verifier-result.schema.json" });
  await ajv.compileAsync({ $ref: "https://agent-hitch.local/schemas/remote-execution-lease-grant.schema.json" });
  assert.equal(schema(envelope), true, ajv.errorsText(schema.errors));
  assert.equal(schema({ ...envelope, outcome: { ...envelope.outcome, trial: { ...envelope.outcome.trial, config: {} } } }), false);
  assert.equal(r.body.includes("/worker/private"), false); assert.equal(r.body.includes("private-agent-token"), false);
  assert.throws(() => parseRemoteResultEnvelope(envelope), "scoring output must not enter candidate import");
  const imported = await importRemoteVerifierResultEnvelope(r.args);
  assert.equal(imported.ref.run_id, f.runId); assert.equal(imported.ref.trial_id, f.descriptor.source_ref.trial_id);
  assert.equal(imported.ref.observation_status, "valid"); assert.equal(imported.ref.reward, 1);
  assert.deepEqual(imported.ref.scores, { total_score: 1, normalization: "standard" });
  assert.equal((await readRegradeObservation(f.root, f.evalId, imported.ref)).status, "valid");
  assert.deepEqual(await importRemoteVerifierResultEnvelope(r.args), imported);
  assert.equal(sha256JSON(await verifyResultBundleIndex(f.runDirectory)), before);
  assert.deepEqual(await readdir(path.join(f.root, "runs")), [f.runId]);
  assert.deepEqual(await readdir(path.join(f.evalDirectory, "assessments")), [f.descriptor.assessment_id]);
  assert.equal(await readFile(path.join(imported.backendDirectory, "evidence/source-artifacts/patch.diff"), "utf8"), "original patch\n");
  const changed = { ...envelope, outcome: { ...envelope.outcome, trial: { ...envelope.outcome.trial, verifier_result: { rewards: { reward: 0.5, total_score: 0.5 } } } } };
  await atomicWriteJSON(r.args.artifactPath, changed);
  await assert.rejects(importRemoteVerifierResultEnvelope(r.args), /conflicts with its sealed result/);
  await writeFile(r.args.artifactPath, r.body);
  await writeFile(path.join(f.sourceSnapshotDirectory, "artifacts/patch.diff"), "changed");
  await assert.rejects(importRemoteVerifierResultEnvelope(r.args), /snapshot digest mismatch/);
});

test("invalid remote verifier evidence seals an assessment without replacing the original slot", async t => {
  const f = await remoteVerifierFixture(t), r = await encoded(f, 0, "curl: (6) Could not resolve host: example.test\n");
  const imported = await importRemoteVerifierResultEnvelope(r.args);
  assert.deepEqual(imported.ref, f.descriptor.source_ref); assert.equal(imported.ref.assessment, undefined);
  const record = JSON.parse(await readFile(path.join(imported.backendDirectory, "assessment.json"), "utf8"));
  assert.equal(record.observation.invalid_reason, "verifier_infrastructure_failure");
  assert.equal(record.candidate_executes, false); assert.deepEqual(await importRemoteVerifierResultEnvelope(r.args), imported);
});

test("remote assessment rejects substituted leases, candidate results, runtime repairs and invalid standardized scores", async t => {
  const f = await remoteVerifierFixture(t), r = await encoded(f), original = JSON.parse(r.body.toString());
  for (const change of [
    { verifier_work_digest: sha256JSON("other-work") },
    { lease_epoch: original.lease_epoch + 1 },
    { outcome: { ...original.outcome, trial: { ...original.outcome.trial, agent_result: {} } } },
    { outcome: { ...original.outcome, runtime_repair: { path: "arbitrary-code" } } },
    { outcome: { ...original.outcome, execution: { ...original.outcome.execution, worker_id: "worker_other" } } },
    { outcome: { ...original.outcome, execution: { ...original.outcome.execution, enforced: { ...original.outcome.execution.enforced,
      main_limits: { ...original.outcome.execution.enforced.main_limits, cpu_millis: 2000 } } } } },
  ]) {
    await atomicWriteJSON(r.args.artifactPath, { ...original, ...change });
    await assert.rejects(importRemoteVerifierResultEnvelope(r.args));
  }
  await encoded(f, 2); await assert.rejects(importRemoteVerifierResultEnvelope(r.args), /score or runtime contract/);
  assert.deepEqual(await readdir(path.join(f.evalDirectory, "assessments")), []);
  await writeFile(r.args.artifactPath, r.body);
  await assert.rejects(importRemoteVerifierResultEnvelope({ ...r.args, signal: AbortSignal.abort() }));
});

test("scoring envelopes reject agent execution, configuration, altered files and non-verifier artifacts", async t => {
  const f = await remoteVerifierFixture(t), r = await encoded(f), original = JSON.parse(r.body.toString());
  for (const change of [ { kind: "candidate-result" }, { extra: true },
    { outcome: { ...original.outcome, trial: { ...original.outcome.trial, agent_setup: {} } } },
    { outcome: { ...original.outcome, trial: { ...original.outcome.trial, agent_execution: {} } } },
    { outcome: { ...original.outcome, trial: { ...original.outcome.trial, config: {} } } },
    { outcome: { ...original.outcome, backend: { ...original.outcome.backend, config_path: "/private" } } },
    { evidence: { ...original.evidence, files: original.evidence.files.map((file: object) => ({ ...file, path: "config.json" })) } },
    { evidence: { ...original.evidence, files: original.evidence.files.map((file: object) => ({ ...file, content_base64: "Zm9yZ2Vk" })) } },
  ]) assert.throws(() => parseRemoteVerifierResultEnvelope({ ...original, ...change }));
  await symlink("test-stdout.txt", path.join(r.verifierDirectory, "linked-log"));
  await assert.rejects(encodeRemoteVerifierResultEnvelope({ lease: f.owner.current(), verifier: f.descriptor, outcome: r.outcome, verifierDirectory: r.verifierDirectory }));
});
