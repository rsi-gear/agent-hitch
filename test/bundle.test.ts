import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteJSON, sha256JSON } from "../src/foundation/index.js";
import { verifyResultBundleIndex, writeResultBundleIndex } from "../src/runs/index.js";

test("result bundle index seals every run file and detects later mutation", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-result-bundle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runId = "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await atomicWriteJSON(path.join(directory, "request.json"), { schema_version: "1", prompt: "test" });
  await atomicWriteJSON(path.join(directory, "resolution.json"), { schema_version: "1", identity: "sha256:b".padEnd(71, "b") });
  await atomicWriteJSON(path.join(directory, "result.json"), { schema_version: "1", run_id: runId, status: "succeeded", exit_code: 0 });
  await writeFile(path.join(directory, "events.jsonl"), `${JSON.stringify({ sequence: 1, type: "run.completed" })}\n`);
  await mkdir(path.join(directory, "environment"));
  await atomicWriteJSON(path.join(directory, "environment", "image.manifest.json"), { schema_version: "1", task_id: "task-a", uses: [], manifests: [] });
  await atomicWriteJSON(path.join(directory, "execution.json"), {
    provider: "local-docker", worker_id: "worker-test", lease_id: `lease_${"a".repeat(32)}`,
    reservation: { cpu_millis: 1_000, memory_bytes: 1024, container_slots: 1, build_slots: 0 },
    observed: { sample_count: 2, containers: [] },
  });
  const runtimeId = `sha256:${"c".repeat(64)}` as const;
  await atomicWriteJSON(path.join(directory, "runtime.ref.json"), {
    schema_version: "1", storage: "controller-runtime-ref-v1", runtime_id: runtimeId,
    manifest_digest: `sha256:${"d".repeat(64)}`, created_at: new Date().toISOString(),
  });
  await atomicWriteJSON(path.join(directory, "manifest.json"), {
    schema_version: "1",
    run_id: runId,
    status: "succeeded",
    context: { kind: "ad_hoc" },
    harness: { harness_id: "codex", requested_ref: "codex@installed", revision_identity: null },
    model: { requested_id: "", effective_id: "" },
    protocol: { timeout_ms: 1_000, workspace_mode: "shared" },
    request_ref: "request.json",
    resolution_ref: "resolution.json",
    result_ref: "result.json",
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    sealed: true,
  });

  const index = await writeResultBundleIndex(directory);
  assert.equal(index.run_id, runId);
  assert.ok(index.files.some((file) => file.path === "manifest.json" && file.role === "manifest"));
  assert.ok(index.files.some((file) => file.path === "events.jsonl" && file.role === "control-events"));
  assert.ok(index.files.some((file) => file.path === "environment/image.manifest.json" && file.role === "environment-manifest"));
  assert.deepEqual(index.environment, { images: [], provider: "local-docker", worker_id: "worker-test", lease_id: `lease_${"a".repeat(32)}` });
  assert.deepEqual(index.resources, {
    requested: { cpu_millis: 1_000, memory_bytes: 1024, container_slots: 1, build_slots: 0 },
    observed: { sample_count: 2, container_count: 0, oom_killed_containers: 0 },
  });
  assert.deepEqual(index.capture, {
    mode: "off", required: false, completeness: "none", interaction_count: 0,
    redaction: { policy: "hitch-provider-redaction-v1", status: "not-needed", rules: [] },
  });
  assert.equal(index.provenance.controller_runtime_id, runtimeId);
  assert.deepEqual(await verifyResultBundleIndex(directory), index);
  const legacy = { ...index } as Record<string, unknown>;
  delete legacy.environment;
  delete legacy.resources;
  delete legacy.capture;
  legacy.bundle_digest = sha256JSON({
    schema_version: index.schema_version, run_id: index.run_id, sealed: index.sealed,
    context_identity: index.context_identity, files: index.files, provenance: index.provenance,
  });
  await atomicWriteJSON(path.join(directory, "bundle.index.json"), legacy);
  assert.equal((await verifyResultBundleIndex(directory)).environment, undefined);

  await atomicWriteJSON(path.join(directory, "result.json"), { schema_version: "1", run_id: runId, status: "failed", exit_code: 12 });
  await assert.rejects(verifyResultBundleIndex(directory), /file set or integrity does not match/);
});
