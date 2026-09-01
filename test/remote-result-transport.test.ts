import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeRemoteResultEnvelope, importRemoteResultEnvelope, parseRemoteResultEnvelope } from "../src/control-plane/index.js";
import type { BackendWorkItemV1, EvalRequest, ExecutionLeaseV1, ResolvedRevision } from "../src/domain/index.js";
import { sha256Bytes } from "../src/foundation/index.js";
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

test("remote result import rejects digest corruption without publishing a run", async (t) => {
  const fixture = await transportFixture(t);
  const value = envelope([{ path: "execution.json", content: Buffer.from("{}") }]);
  (value.files[0] as { sha256: string }).sha256 = `sha256:${"f".repeat(64)}`;
  await writeFile(fixture.artifact, `${JSON.stringify(value)}\n`);
  await assert.rejects(importRemoteResultEnvelope(fixture.input), (error: unknown) => (error as { code?: string }).code === "remote_result_invalid");
  await assert.rejects(stat(path.join(fixture.root, "runs")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
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
