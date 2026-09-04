import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseTOML } from "smol-toml";
import { loadBenchmark } from "../src/benchmarks/index.js";
import { compileBenchmark } from "../src/evals/benchmark-run.js";
import { harborAgentTimeoutOverride } from "../src/backends/harbor/agent-budget.js";
import { writeBenchmarkFixture } from "../test-support/benchmark-fixture.js";

test("compiled ordinary tasks retain source budgets and reserve export time, including explicit caps", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-agent-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await writeBenchmarkFixture(source);
  const loaded = await loadBenchmark(source);
  const compiled = await compileBenchmark(loaded, path.join(root, "state"));
  const task = path.join(compiled.tasks, "add-seven");
  const toml = parseTOML(await readFile(path.join(task, "task.toml"), "utf8"));
  const descriptorPath = path.join(task, ".hitch-benchmark.json");
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  assert.equal((loaded.tasks[0]!.harbor.agent as Record<string, unknown>).timeout_sec, 60);
  assert.equal((toml.agent as Record<string, unknown>).timeout_sec, 150);
  assert.equal(descriptor.agent_timeout_sec, 60);
  assert.equal(descriptor.agent_finalization_timeout_ms, 90_000);
  assert.deepEqual(await compileBenchmark(loaded, path.join(root, "state")), compiled);
  const dataset = { path: compiled.tasks, task_names: ["add-seven"] };
  assert.equal(await harborAgentTimeoutOverride(dataset, 0), null);
  assert.equal(await harborAgentTimeoutOverride(dataset, 5_000), 95);
  assert.equal(await harborAgentTimeoutOverride(dataset, 120_000), 150);
  assert.equal(await harborAgentTimeoutOverride({ path: compiled.tasks }, 5_001), 96);
  assert.equal(await harborAgentTimeoutOverride({ name: "legacy" }, 5_000), 35);
  await writeFile(descriptorPath, JSON.stringify({ ...descriptor, agent_finalization_timeout_ms: -1 }));
  await assert.rejects(harborAgentTimeoutOverride(dataset, 5_000), /invalid compiled/);
  await assert.rejects(compileBenchmark(loaded, path.join(root, "state")), /modified/);
});

test("ordinary bridge subtracts preparation, collects timeout evidence, and bounds stuck collection", () => {
  const result = spawnSync("python3", ["test-support/harbor_agent_budget_smoke.py"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("real managed CLI retires a timed-out process and exports evidence without resetting preparation budgets", () => {
  const result = spawnSync("python3", ["test-support/harbor_agent_budget_cli_smoke.py"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).passed, true);
});
