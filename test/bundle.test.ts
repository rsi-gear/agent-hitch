import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteJSON } from "../src/foundation/index.js";
import { verifyResultBundleIndex, writeResultBundleIndex } from "../src/runs/index.js";

test("result bundle index seals every run file and detects later mutation", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-result-bundle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runId = "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await atomicWriteJSON(path.join(directory, "request.json"), { schema_version: "1", prompt: "test" });
  await atomicWriteJSON(path.join(directory, "resolution.json"), { schema_version: "1", identity: "sha256:b".padEnd(71, "b") });
  await atomicWriteJSON(path.join(directory, "result.json"), { schema_version: "1", run_id: runId, status: "succeeded", exit_code: 0 });
  await writeFile(path.join(directory, "events.jsonl"), `${JSON.stringify({ sequence: 1, type: "run.completed" })}\n`);
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
  assert.deepEqual(await verifyResultBundleIndex(directory), index);

  await atomicWriteJSON(path.join(directory, "result.json"), { schema_version: "1", run_id: runId, status: "failed", exit_code: 12 });
  await assert.rejects(verifyResultBundleIndex(directory), /file set or integrity does not match/);
});

