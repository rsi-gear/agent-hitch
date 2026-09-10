import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeRemoteResultEnvelope, importRemoteResultEnvelope, parseRemoteResultEnvelope } from "../src/control-plane/index.js";
import type { BackendWorkItemV1, EvalRequest, ExecutionLeaseV1, ResolvedRevision } from "../src/domain/index.js";
import { sha256Bytes } from "../src/foundation/index.js";
import { parseTrainingBinding, trainingProxyIdentity } from "../src/model-access/index.js";
import { forceRemove } from "../test-support/helpers.js";

const EVAL_ID = `eval_${"a".repeat(32)}`;
const WORK_ID = `work_${"b".repeat(32)}`;
const LEASE_ID = `lease_${"c".repeat(32)}`;
const RESERVATION = { cpu_millis: 1_000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };

test("remote result parser rejects traversal and non-canonical paths", () => {
  const base = envelope([{ path: "../escape", content: Buffer.from("x") }]);
  assert.throws(() => parseRemoteResultEnvelope(base), (error: unknown) => (error as { code?: string }).code === "remote_result_invalid");
  assert.throws(() => parseRemoteResultEnvelope(envelope([
    { path: "z", content: Buffer.from("z") },
    { path: "a", content: Buffer.from("a") },
  ])), (error: unknown) => (error as { code?: string }).code === "remote_result_invalid");
});

test("remote result accepts a large binary artifact and rejects malformed Base64", () => {
  const value = envelope([{ path: "artifact.bin", content: Buffer.alloc(32 * 1024 * 1024, 0xfb) }]);
  assert.equal(parseRemoteResultEnvelope(value).files[0]!.size, 32 * 1024 * 1024);
  for (const encoded of ["Zg", "Zg=", "Zg===", "=g==", "Z===", "====", "Zg==AAAA", "Zm9v\n", "Zm v", "Zm_v", "Zm-v", "Zmø="]) {
    const malformed = envelope([{ path: "file", content: Buffer.from(encoded, "base64") }]);
    malformed.files[0]!.content_base64 = encoded;
    assert.throws(() => parseRemoteResultEnvelope(malformed), { code: "remote_result_invalid" }, encoded);
  }
});

test("remote result import rejects digest corruption without publishing a run", async (t) => {
  const fixture = await transportFixture(t);
  const value = envelope([{ path: "execution.json", content: Buffer.from("{}") }]);
  (value.files[0] as { sha256: string }).sha256 = `sha256:${"f".repeat(64)}`;
  await writeFile(fixture.artifact, `${JSON.stringify(value)}\n`);
  await assert.rejects(importRemoteResultEnvelope(fixture.input), (error: unknown) => (error as { code?: string }).code === "remote_result_invalid");
  await assert.rejects(stat(path.join(fixture.root, "runs")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("remote result encoding omits Harbor's embedded private agent config without changing scoring evidence", async t => {
  const f = await transportFixture(t), bundle = path.join(f.root, "bundle"); await mkdir(bundle);
  await writeFile(path.join(bundle, "result.json"), "{}");
  const trial = { task_name: "task-a", trial_name: "trial-a", agent_result: { metadata: { hitch_run_id: `run_${"e".repeat(32)}` } },
    verifier_result: { rewards: { reward: 0 } }, config: { agent: { kwargs: { model_capture: { token: "private-worker-proxy-token" } } } } };
  const bytes = await encodeRemoteResultEnvelope({ evalId: EVAL_ID, workId: WORK_ID, leaseId: LEASE_ID, leaseEpoch: 1, trial, bundleDirectory: bundle });
  assert.equal(bytes.includes("private-worker-proxy-token"), false);
  const result = parseRemoteResultEnvelope(JSON.parse(bytes.toString()));
  const { config: _config, ...publicTrial } = trial;
  assert.equal(result.schema_version, "1"); assert.deepEqual(result.trial, publicTrial);
  assert.equal(trial.config.agent.kwargs.model_capture.token, "private-worker-proxy-token", "original private state is unchanged");
});

test("remote result version must match negotiated verifier source capture before importing files", async t => {
  const f = await transportFixture(t), v1 = envelope([{ path: "execution.json", content: Buffer.from("{}") }]);
  await writeFile(f.artifact, JSON.stringify(v1));
  await assert.rejects(importRemoteResultEnvelope({ ...f.input, verifierSourceExpected: true }), /negotiated work spec/);
  const v2 = { ...v1, schema_version: "2", verifier_source: { manifest: { schema_version: "2", status: "unavailable", reason: "source-unavailable",
    task_id: "task-a", trial_id: "trial-a", run_id: `run_${"e".repeat(32)}`, controller_runtime_id: `sha256:${"a".repeat(64)}`, source_result_digest: `sha256:${"b".repeat(64)}` } } };
  await writeFile(f.artifact, JSON.stringify(v2));
  await assert.rejects(importRemoteResultEnvelope(f.input), /negotiated work spec/);
  await assert.rejects(stat(path.join(f.evalDirectory, "harbor")), { code: "ENOENT" });
});

test("remote result import fences execution evidence to the assigned lease", async (t) => {
  const fixture = await transportFixture(t);
  const bundle = path.join(fixture.root, "worker-bundle");
  await mkdir(bundle);
  await writeFile(path.join(bundle, "execution.json"), `${JSON.stringify(executionEvidence("worker_forged"))}\n`);
  const body = await encodeRemoteResultEnvelope({
    evalId: EVAL_ID, workId: WORK_ID, leaseId: LEASE_ID, leaseEpoch: 1,
    trial: { task_name: "task-a", trial_name: "trial-a" }, bundleDirectory: bundle,
  });
  await writeFile(fixture.artifact, body);
  await assert.rejects(importRemoteResultEnvelope(fixture.input), /execution evidence does not match its lease/);
  await assert.rejects(stat(path.join(fixture.evalDirectory, "harbor", "work-items", WORK_ID, "epoch-000001")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("remote result rejects substituted canonical run, training policy and managed node before publishing", async t => {
  const f = await transportFixture(t), runId = `run_${"d".repeat(32)}`, hash = `sha256:${"a".repeat(64)}` as const;
  const training = parseTrainingBinding({ kind: "training-external", bindingId: "binding_result", trainingRunId: "train_result",
    policyLeaseRef: { uri: `cas:${hash}`, digest: hash, mediaType: "application/json" }, expectedPolicyVersion: "runtime-1/update-1",
    fencingToken: "fence", expiresAt: new Date(Date.now() + 60_000).toISOString(), endpointRef: "hitch-training:binding_result",
    credentialRef: "hitch-training:binding_result", generationContractDigest: hash, requiredCapture: "exact-policy-tokens-v1",
    api: "chat-completions", maxOutputTokens: 16, maxEpisodeSteps: 4 });
  const modelNode = { schema_version: "2" as const, node_id: "node", generation: "one", runtime_digest: hash, launcher: "process" as const };
  const managed = { schema_version: "2" as const, kind: "managed-inference" as const, inference_id: hash, model_id: hash, model_node: modelNode, api: "responses" as const, max_output_tokens: 16 };
  const managedRequest = { local_inference: { model: "local/test", device: "auto", profile: "baseline", offline: true, inference_id: hash, model_node: modelNode } } as EvalRequest;
  const cases = [
    { manifest: { run_id: `run_${"f".repeat(32)}`, training_external: trainingProxyIdentity(training) },
      request: { training_binding: training } as EvalRequest, proof: { runId, binding: { schema_version: "2" as const, kind: "training-external" as const, training } }, error: /canonical run differs/ },
    { manifest: { run_id: runId, training_external: { ...trainingProxyIdentity(training), policy_version: "stale" } },
      request: { training_binding: training } as EvalRequest, proof: { runId, binding: { schema_version: "2" as const, kind: "training-external" as const, training } }, error: /training identity differs/ },
    { manifest: { run_id: runId, model: { effective_id: hash, inference_id: hash, identity_resolved: true, model_node: { ...modelNode, generation: "other" } } },
      request: managedRequest, proof: { runId, binding: managed }, error: /managed model identity differs/ },
  ];
  for (const entry of cases) {
    await writeFile(f.artifact, JSON.stringify(envelope([{ path: "manifest.json", content: Buffer.from(JSON.stringify(entry.manifest)) }])));
    await assert.rejects(importRemoteResultEnvelope({ ...f.input, request: entry.request, modelProof: entry.proof }), entry.error);
    await assert.rejects(stat(path.join(f.root, "runs")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(f.evalDirectory, "harbor", "work-items", WORK_ID, "epoch-000001")), { code: "ENOENT" });
  }
  await assert.rejects(importRemoteResultEnvelope({ ...f.input, request: managedRequest }), /no controller model\/run proof/);
});

async function transportFixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-result-"));
  t.after(() => forceRemove(root));
  const evalDirectory = path.join(root, "evals", EVAL_ID);
  await mkdir(evalDirectory, { recursive: true });
  const artifact = path.join(root, "result-envelope.json");
  return {
    root, evalDirectory, artifact,
    input: {
      root, evalDirectory, artifactPath: artifact,
      request: {} as EvalRequest, resolvedRevision: {} as ResolvedRevision,
      work: workItem(), lease: executionLease(),
    },
  };
}

function workItem(): BackendWorkItemV1 {
  return {
    schema_version: "1", work_id: WORK_ID, eval_id: EVAL_ID, backend: "harbor", logical_attempt: 1,
    task_ids: ["task-a"], slots: [`slot_${"d".repeat(32)}`], opaque_membership: false,
    requested_parallelism: 1, reservation: RESERVATION, provider: "remote-docker",
  };
}

function executionLease(): ExecutionLeaseV1 {
  const now = new Date().toISOString();
  return {
    schema_version: "1", lease_id: LEASE_ID, work_id: WORK_ID, eval_id: EVAL_ID,
    worker_id: "worker_remote_a", provider: "remote-docker", collision_domain_id: "docker:remote-a",
    reservation: RESERVATION, state: "running", epoch: 1, resource_epochs: [1], issued_at: now,
    accepted_at: now, heartbeat_at: now, expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

function executionEvidence(workerId: string) {
  const now = new Date().toISOString();
  return {
    schema_version: "1", provider: "remote-docker", worker_id: workerId, collision_domain_id: "docker:remote-a",
    eval_id: EVAL_ID, work_id: WORK_ID, lease_id: LEASE_ID, lease_epoch: 1, task_id: "task-a",
    reservation: RESERVATION, enforced: { main_limits: RESERVATION, sidecar_limits: {} },
    observed: { status: "unavailable", started_at: now, collected_at: now, sample_count: 0, containers: [], unavailable_fields: [], issues: [] },
  };
}

function envelope(files: Array<{ path: string; content: Buffer }>) {
  return {
    schema_version: "1", eval_id: EVAL_ID, work_id: WORK_ID, lease_id: LEASE_ID, lease_epoch: 1,
    trial: { task_name: "task-a", trial_name: "trial-a" },
    files: files.map((file) => ({
      path: file.path, size: file.content.length, sha256: sha256Bytes(file.content), content_base64: file.content.toString("base64"),
    })),
  };
}
