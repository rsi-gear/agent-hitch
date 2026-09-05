import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportStandardBenchmarkDataset, runBenchmarkEval, validateEvalRequest } from "../src/evals/index.js";
import { harborAgentTimeoutOverride } from "../src/backends/harbor/agent-budget.js";
import { parseEvalRequest } from "../src/cli/arguments.js";
import { writeBenchmarkFixture } from "../test-support/benchmark-fixture.js";

test("standard dataset admission preserves task budgets and explicit caller caps", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-standard-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), dataset = path.join(root, "dataset");
  await writeBenchmarkFixture(source);
  const taskFile = path.join(source, "tasks/add-seven/task.toml");
  await writeFile(taskFile, (await readFile(taskFile, "utf8")).replace("timeout_sec = 60", "timeout_sec = 3600"));
  await exportStandardBenchmarkDataset(source, dataset);
  const request = parseEvalRequest(["--dataset", dataset, "--harness", "codex@version:0.145.0"]);
  const normalized = await validateEvalRequest(request);
  assert.equal(normalized.timeout_ms, 0);
  assert.equal(await harborAgentTimeoutOverride({ path: dataset }, normalized.timeout_ms), null);
  assert.match(await readFile(path.join(dataset, "add-seven/task.toml"), "utf8"), /timeout_sec = 3690/);
  const capped = await validateEvalRequest({ ...request, timeout_ms: 120_000 });
  assert.equal(capped.timeout_ms, 120_000);
  assert.equal(await harborAgentTimeoutOverride({ path: dataset }, capped.timeout_ms), 210);
  assert.equal((await validateEvalRequest({ ...request, timeout_ms: 0 })).timeout_ms, 0);
  assert.equal((await validateEvalRequest({ ...request, dataset: "legacy@1.0" })).timeout_ms, 900_000);
  assert.equal((await validateEvalRequest({ ...request, dataset: path.join(source, "tasks") })).timeout_ms, 900_000);
});

test("both benchmark entry points enforce model-call and image harness requirements", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-standard-candidate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modelCall = `model-call@git+file:///sources/hitch#${"a".repeat(40)}`;
  for (const kind of ["model-call", "terminal"] as const) {
    const source = path.join(root, kind), dataset = path.join(root, `${kind}-dataset`);
    await writeCandidateFixture(source, kind);
    await exportStandardBenchmarkDataset(source, dataset);
    const rejected = kind === "model-call"
      ? [{ harness_ref: "codex@version:0.145.0" }, { harness_ref: modelCall, agent_args: ["--extra"] }]
      : [{ harness_ref: "opencode@version:1.2.3" }];
    const error = kind === "model-call" ? /no-tools tasks require/ : /native-image agent tasks/;
    for (const request of rejected) {
      await assert.rejects(validateEvalRequest({ ...request, dataset }), error);
      await assert.rejects(runBenchmarkEval({ root, benchmark: source, request }), error);
    }
    const allowed = await validateEvalRequest({ dataset, harness_ref: kind === "model-call" ? modelCall : "codex@version:0.145.0" });
    assert.equal(allowed.timeout_ms, 0);
    if (kind === "model-call") assert.deepEqual(allowed.agent_args, []);
  }
});

async function writeCandidateFixture(source: string, kind: "model-call" | "terminal"): Promise<void> {
  await writeBenchmarkFixture(source);
  const task = path.join(source, "tasks/add-seven");
  const requirements = kind === "model-call"
    ? ["model-call@1", "native-image-input", "no-tools", "artifact-export", "separate-verifier"]
    : ["shell", "native-image-input", "artifact-export", "separate-verifier"];
  const config = JSON.parse(await readFile(path.join(task, "task.hitch.json"), "utf8"));
  config.driver = { kind, protocol_version: "1", config: kind === "model-call" ? { input: "tasks/add-seven/environment/input.json" } : {} };
  config.requirements = requirements;
  config.lifecycle = {};
  config.submission = { kind: "artifacts", paths: ["/hitch-evidence/final-response.json"], max_bytes: 1024, final_response: "/hitch-evidence/final-response.json" };
  await writeFile(path.join(task, "task.hitch.json"), JSON.stringify(config));
  const profileFile = path.join(source, "profiles/default.json");
  const profile = JSON.parse(await readFile(profileFile, "utf8"));
  profile.tool_policy.allowed = requirements;
  await writeFile(profileFile, JSON.stringify(profile));
  await writeFile(path.join(task, "environment/input.json"), JSON.stringify({ schema_version: "1", messages: [{ role: "user", content: [{ type: "input_text", text: "Answer seven." }] }] }));
  await rm(path.join(task, "environment/docker-compose.yaml"));
  await writeFile(path.join(task, "task.toml"), 'schema_version = "1.4"\nartifacts = ["/hitch-evidence/final-response.json"]\n[agent]\ntimeout_sec = 3600\n[environment]\ncpus = 1\nmemory_mb = 1024\n[verifier]\ntimeout_sec = 30\nenvironment_mode = "separate"\n[verifier.environment]\ncpus = 1\nmemory_mb = 512\n');
}
