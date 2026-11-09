import test from "node:test";
import assert from "node:assert/strict";
import { listDefinitions } from "../src/adapters/index.js";
import { validateEvalRequest } from "../src/evals/request.js";

test("obsolete research execution requests fail before dataset or model admission", async () => {
  assert(!listDefinitions().some(adapter => adapter.id === "sealed-python"));
  await assert.rejects(validateEvalRequest({
    schema_version: "2", dataset: "old-research@checkpoint", backend: "harbor",
    harness_ref: `sealed-python@git+file:///nonexistent/old-executor#${"a".repeat(40)}`, model: null,
    attempts: 1, infrastructure_retries: 0,
  }), /unsupported schema_version/);
  await assert.rejects(validateEvalRequest({
    schema_version: "1", dataset: "old-research@checkpoint", backend: "harbor",
    harness_ref: "pi@version:1.2.3", model: null,
  }), /model must be a string/);
});

test("historical resource v2 rollout manifests reject before task or model admission", async t => {
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { readResourceInput, parseResourceDataset, parseResourceSelection } = await import("../src/resources/index.js");
  const { loadBenchmarkAdapterManifest } = await import("../src/evals/benchmark-adapter-manifest.js");
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-cutover-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const historical = await readFile("test/fixtures/cutover/resource-v2-rollout.json", "utf8");
  const raw = JSON.parse(historical);
  assert.equal(raw.schema_version, "2");
  assert.equal(raw.adapter.id, "analysis-tabular");
  await writeFile(path.join(directory, "benchmark.adapter.json"), historical);
  // No historical runtime, dataset content, configured resource store, or model
  // is installed. The envelope itself is rejected before resolving any of them.
  await assert.rejects(readResourceInput(directory), /unsupported resource dataset/);
  await assert.rejects(loadBenchmarkAdapterManifest(directory), /unsupported resource dataset/);
  assert.throws(() => parseResourceDataset(raw), /unsupported resource dataset/);
  const fixture = JSON.parse(await readFile("test-contracts/hitch-resources-v1.json", "utf8"));
  const { identity } = await import("../src/resources/index.js");
  const selection = structuredClone(fixture.selection); selection.manifest.schema_version = "2";
  const { digest: _digest, ...body } = selection;
  assert.throws(() => parseResourceSelection({ ...body, digest: identity("hitch-resource-selection@1", body) }), /unsupported resource dataset/);
});
