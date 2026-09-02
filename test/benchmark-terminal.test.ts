import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadBenchmark } from "../src/benchmarks/index.js";
import { parseBenchmarkToml } from "../src/benchmarks/toml.js";
import { writeBenchmarkFixture } from "../test-support/benchmark-fixture.js";

test("native terminal package preserves collection hooks, instructions and artifact grading without a sidecar", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-terminal-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeBenchmarkFixture(root);
  const task = path.join(root, "tasks/add-seven");
  const config = JSON.parse(await readFile(path.join(task, "task.hitch.json"), "utf8"));
  config.driver = { kind: "terminal", protocol_version: "1", config: {} };
  config.lifecycle = {};
  config.requirements = ["shell", "artifact-export", "separate-verifier"];
  config.submission.paths = ["/answer/Output File.json"];
  config.grading.kind = "harbor";
  await writeFile(path.join(task, "task.hitch.json"), JSON.stringify(config));
  await rm(path.join(task, "environment/docker-compose.yaml"));
  const toml = `schema_version = "1.4"
artifacts = ["/answer/Output File.json"]
[task]
description = """An unchanged
multiline upstream task"""
[agent]
timeout_sec = 28800.0
[environment]
cpus = 4
memory_mb = 8192
[verifier]
environment_mode = "separate"
timeout_sec = 300.0
[[verifier.collect]]
command = '''python -c "
print('collect before stop')
"'''
[verifier.environment]
network_mode = "no-network"
`;
  await writeFile(path.join(task, "task.toml"), toml);
  await writeFile(path.join(task, "environment/Input File.txt"), "ordinary data");
  await writeFile(path.join(task, "environment/Dockerfile"), `FROM python@sha256:${"a".repeat(64)}\nRUN python -c "\\\nfrom json import loads; \\\nprint(loads('1'))"\n`);
  const loaded = await loadBenchmark(root);
  assert.equal(loaded.tasks[0]!.config.driver.kind, "terminal");
  assert.deepEqual(loaded.tasks[0]!.tools, []);
  assert.deepEqual(loaded.tasks[0]!.harbor, parseBenchmarkToml(toml));
  assert.equal((loaded.tasks[0]!.harbor.agent as { timeout_sec: number }).timeout_sec, 28800);
  const old = loaded.lock.tasks[0]!.grader_digest;
  await writeFile(path.join(task, "tests/test.sh"), "echo 0 > /logs/verifier/reward.txt\n");
  assert.notEqual((await loadBenchmark(root)).lock.tasks[0]!.grader_digest, old);
  config.requirements = ["shell"];
  await writeFile(path.join(task, "task.hitch.json"), JSON.stringify(config));
  await assert.rejects(loadBenchmark(root), /isolation must be declared/);
});
