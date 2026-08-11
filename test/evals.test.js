import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectEval, listEvals, newEvalId, runEval, validateEvalRequest } from "../src/evals.js";
import { readJSON } from "../src/fs.js";
import { lockedHarnessRef } from "../src/harbor-backend.js";
import { writeFakeHarbor, writeFakeNpm } from "../test-support/helpers.js";

test("eval requests require immutable container-portable harness revisions", async () => {
  await assert.rejects(
    validateEvalRequest({ dataset: "demo", harness_ref: "codex@installed" }),
    /immutable harness ref/,
  );
  await assert.rejects(
    validateEvalRequest({ dataset: "demo", harness_ref: "pi@git+file:///tmp/pi#abcdef1" }),
    /does not yet support local git\+file/,
  );
  const request = await validateEvalRequest({ dataset: "demo@1.0", harness_ref: "pi@version:1.2.3" });
  assert.equal(request.backend, "harbor");
  assert.equal(request.attempts, 1);
  assert.equal(request.timeout_ms, 15 * 60 * 1_000);
  assert.equal(lockedHarnessRef({
    harness_id: "pi",
    revision: { type: "commit", commit: "0123456789abcdef0123456789abcdef01234567" },
  }), "pi@commit:0123456789abcdef0123456789abcdef01234567");
});

test("Harbor eval writes a custom Hitch agent job and normalizes rewards", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeNpm = await writeFakeNpm(root);
  const fakeHarbor = await writeFakeHarbor(root);
  const evalId = newEvalId();
  const env = {
    ...process.env,
    HITCH_NPM_PATH: fakeNpm,
    OPENAI_API_KEY: "must-not-be-written",
  };
  const result = await runEval({
    evalId,
    root,
    harborExecutable: fakeHarbor,
    env,
    request: {
      dataset: "demo@1.0",
      harness_ref: "pi@version:1.2.3",
      model: "openai/test-model",
      attempts: 2,
      max_concurrent: 2,
      timeout_ms: 5_000,
    },
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.summary.n_trials, 2);
  assert.equal(result.summary.primary_reward, 0.75);
  assert.deepEqual(result.summary.rewards.reward, { count: 2, mean: 0.75, min: 0.5, max: 1 });
  const directory = path.join(root, "evals", evalId);
  const config = await readJSON(path.join(directory, "harbor", "job.json"));
  assert.equal(config.agents[0].import_path, "hitch_harbor_agent:HitchHarborAgent");
  assert.equal(config.agents[0].kwargs.harness_ref, "pi@version:1.2.3");
  assert.equal(config.agents[0].kwargs.workdir, "/app");
  assert.equal(config.agents[0].env.OPENAI_API_KEY, "${OPENAI_API_KEY}");
  assert.doesNotMatch(await readFile(path.join(directory, "harbor", "job.json"), "utf8"), /must-not-be-written/);
  assert.deepEqual(config.datasets, [{ name: "demo", version: "1.0" }]);
  assert.equal((await stat(path.join(directory, "runtime", "bin", "hitch.js"))).isFile(), true);

  const listed = await listEvals({ root });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].eval_id, evalId);
  assert.equal(listed[0].primary_reward, 0.75);
  const inspected = await inspectEval(evalId, { root });
  assert.equal(inspected.plan.candidate.revision_identity, result.candidate.revision_identity);
  assert.equal(inspected.result.status, "succeeded");
});

test("Harbor bridge source is valid Python", () => {
  const source = path.resolve("integrations/harbor/hitch_harbor_agent.py");
  const result = spawnSync("python3", ["-c", "import pathlib; compile(pathlib.Path(__import__('sys').argv[1]).read_text(), __import__('sys').argv[1], 'exec')", source], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});
