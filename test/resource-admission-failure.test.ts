import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { runEval, validateEvalRequest } from "../src/evals/index.js";
import { writeSyntheticEvalResult } from "../src/control-plane/synthetic-result.js";
import { validateEvalId } from "../src/evals/request.js";
import { atomicWriteJSON } from "../src/foundation/index.js";

test("resource admission failure publishes bounded planning diagnostics before resolving the harness", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hitch-admission-failure-")); t.after(() => rm(root, { recursive: true, force: true }));
  const dataset = path.join(root, "dataset"); await mkdir(dataset);
  const fixture = JSON.parse(await readFile("test-contracts/hitch-resources-v1.json", "utf8"));
  await writeFile(path.join(dataset, "benchmark.adapter.json"), JSON.stringify(fixture.dataset));
  const request = await validateEvalRequest({ schema_version: "1", backend: "harbor", dataset,
    harness_ref: `pi@git+file:///does-not-exist#${"a".repeat(40)}`, model: "not-called", attempts: 1 });
  const result = await runEval({ root, request, normalizedRequest: request, environmentBuildMode: "prebuild-required" });
  assert.equal(result.status, "failed"); assert.equal(result.failure_stage, "planning");
  assert.equal(result.error?.code, "invalid_input"); assert.match(result.error?.message ?? "", /backend builds/);
  assert.equal(result.dataset, dataset); assert.deepEqual(result.trials, []); assert.equal(result.candidate, undefined);
  assert.equal(JSON.parse(await readFile(path.join(root, "evals", result.eval_id as string, "result.json"), "utf8")).failure_stage, "planning");
});

test("synthetic failures retain only matching frozen identity without inventing a quality score", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hitch-synthetic-failure-")); t.after(() => rm(root, { recursive: true, force: true }));
  const request = await validateEvalRequest({ dataset: "example@1", harness_ref: "pi@version:1.2.3", model: "not-called" });
  const id = validateEvalId(`eval_${"a".repeat(32)}`), at = new Date().toISOString();
  const candidate = { requested_harness_ref: request.harness_ref, revision_identity: "sha256:" + "b".repeat(64), model: request.model };
  await atomicWriteJSON(path.join(root, "control.json"), { schema_version: "1", eval_id: id, generation: 0, state: "preparing", requested_parallelism: 1, admitted_parallelism: 0, created_at: at, updated_at: at });
  await atomicWriteJSON(path.join(root, "logical-plan.json"), { schema_version: "1", eval_id: id, dataset: request.dataset, candidate });
  await writeSyntheticEvalResult({ directory: root, evalId: id, request, status: "failed", code: "control_plane_error", message: "bounded setup failure", completedAt: at });
  const result = JSON.parse(await readFile(path.join(root, "result.json"), "utf8"));
  assert.equal(result.failure_stage, "preparing"); assert.equal(result.dataset, request.dataset); assert.deepEqual(result.candidate, candidate);
  assert.deepEqual(result.trials, []); assert.equal(result.reward, undefined); assert.equal(result.summary?.primary_reward ?? null, null);
});
