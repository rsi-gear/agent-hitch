import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectEval, listEvals, newEvalId, runEval, validateEvalRequest } from "../src/evals.js";
import { readJSON } from "../src/fs.js";
import { lockedHarnessRef } from "../src/harbor-backend.js";
import { forceRemove, writeFakeHarbor, writeFakeNpm } from "../test-support/helpers.js";
import type { EvalRequestInput } from "../src/evals.js";

function evalRequest(overrides: Partial<EvalRequestInput> = {}): EvalRequestInput {
  return { dataset: "demo@1.0", harness_ref: "pi@version:1.2.3", ...overrides };
}

test("eval requests require immutable container-portable harness revisions", async () => {
  await assert.rejects(
    validateEvalRequest(evalRequest({ harness_ref: "codex@installed" })),
    /immutable harness ref/,
  );
  await assert.rejects(
    validateEvalRequest(evalRequest({ harness_ref: "pi@git+file:///tmp/pi#abcdef1" })),
    /full lowercase 40- or 64-character commit OID/,
  );
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const local = await validateEvalRequest(evalRequest({ harness_ref: `pi@git+file:///tmp/pi#${commit}` }));
  assert.equal(local.harness_ref, `pi@git+file:///tmp/pi#${commit}`);
  await assert.rejects(
    validateEvalRequest(evalRequest({ harness_ref: `pi@git+file:///tmp/pi#${commit.toUpperCase()}` })),
    /full lowercase/,
  );
  await assert.rejects(validateEvalRequest(evalRequest({ harness_ref: "pi@git+file:///tmp/pi#HEAD" })), /hexadecimal ID/);
  const request = await validateEvalRequest(evalRequest());
  assert.equal(request.backend, "harbor");
  assert.equal(request.attempts, 1);
  assert.equal(request.timeout_ms, 15 * 60 * 1_000);
  assert.equal(lockedHarnessRef({
    harness_id: "pi",
    revision: { type: "commit", commit: "0123456789abcdef0123456789abcdef01234567" },
    source: { type: "git", url: "https://example.test/pi.git", registered: true },
  } as never), "pi@commit:0123456789abcdef0123456789abcdef01234567");
});

test("Harbor eval enables native permission bypass for Codex and OpenCode", async () => {
  const codex = await validateEvalRequest(evalRequest({
    harness_ref: "codex@version:0.92.0",
    agent_args: ["--reasoning-effort", "high"],
  }));
  assert.deepEqual(codex.agent_args, [
    "--dangerously-bypass-approvals-and-sandbox",
    "--reasoning-effort",
    "high",
  ]);

  const opencode = await validateEvalRequest(evalRequest({
    harness_ref: "opencode@version:1.18.15",
    agent_args: ["--dangerously-skip-permissions"],
  }));
  assert.deepEqual(opencode.agent_args, ["--dangerously-skip-permissions"]);

  const pi = await validateEvalRequest(evalRequest({ agent_args: ["--extra-flag"] }));
  assert.deepEqual(pi.agent_args, ["--extra-flag"]);
});

test("Harbor eval writes a custom Hitch agent job and normalizes rewards", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-"));
  t.after(() => forceRemove(root));
  const fakeNpm = await writeFakeNpm(root);
  const fakeHarbor = await writeFakeHarbor(root);
  const evalId = newEvalId();
  const env = {
    ...process.env,
    HITCH_NPM_PATH: fakeNpm,
    DEEPSEEK_API_KEY: "deepseek-must-not-be-written",
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
  const summary = result.summary as Record<string, unknown>;
  assert.equal(summary.n_trials, 2);
  assert.equal(summary.primary_reward, null);
  assert.equal(summary.n_invalid, 2);
  const backendSummary = result.backend_summary as Record<string, unknown>;
  assert.equal(backendSummary.primary_reward, 0.75);
  const trials = result.trials as Array<{ run_id: string; observation_status: string; invalid_reason: string }>;
  assert.equal(trials.length, 2);
  assert.ok(trials.every((trial) => /^run_[a-f0-9]{32}$/.test(trial.run_id)));
  assert.ok(trials.every((trial) => trial.observation_status === "invalid" && trial.invalid_reason === "trajectory_missing_or_corrupt"));
  for (const trial of trials) {
    const manifest = await readJSON<Record<string, unknown>>(path.join(root, "runs", trial.run_id, "manifest.json"));
    assert.equal((manifest.context as Record<string, unknown>).kind, "benchmark_task");
    assert.equal((manifest.parent as Record<string, unknown>).eval_id, evalId);
  }
  const directory = path.join(root, "evals", evalId);
  const config = await readJSON<Record<string, unknown>>(path.join(directory, "harbor", "job.json"));
  const agent = (config.agents as Record<string, unknown>[])[0] as Record<string, unknown>;
  const kwargs = agent.kwargs as Record<string, unknown>;
  assert.equal(agent.import_path, "hitch_harbor_agent:HitchHarborAgent");
  assert.equal(kwargs.harness_ref, "pi@version:1.2.3");
  assert.equal(kwargs.workdir, "/app");
  assert.equal((agent.env as Record<string, unknown>).DEEPSEEK_API_KEY, "${DEEPSEEK_API_KEY}");
  assert.equal((agent.env as Record<string, unknown>).OPENAI_API_KEY, "${OPENAI_API_KEY}");
  assert.doesNotMatch(await readFile(path.join(directory, "harbor", "job.json"), "utf8"), /(?:deepseek-)?must-not-be-written/);
  assert.deepEqual(config.datasets, [{ name: "demo", version: "1.0" }]);
  // New evals reference the shared controller runtime; they no longer contain
  // a complete runtime copy (spec §4.7).
  const runtimeRef = await readJSON<{ storage: string; runtime_id: string }>(path.join(directory, "runtime.ref.json"));
  assert.equal(runtimeRef.storage, "controller-runtime-ref-v1");
  assert.match(runtimeRef.runtime_id, /^sha256:[0-9a-f]{64}$/);
  await assert.rejects(stat(path.join(directory, "runtime", "bin", "hitch.js")));

  const listed = await listEvals({ root });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.eval_id, evalId);
  assert.equal(listed[0]?.primary_reward, null);
  const inspected = await inspectEval(evalId, { root });
  assert.equal((inspected.plan as { candidate: { revision_identity: string } }).candidate.revision_identity, (result.candidate as { revision_identity: string }).revision_identity);
  assert.equal(inspected.result?.status, "succeeded");
  assert.equal(inspected.runtime_storage, "controller-runtime-ref-v1");
});

test("Harbor bridge source is valid Python", () => {
  const source = path.resolve("integrations/harbor/hitch_harbor_agent.py");
  const result = spawnSync("python3", ["-c", "import pathlib; compile(pathlib.Path(__import__('sys').argv[1]).read_text(), __import__('sys').argv[1], 'exec')", source], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || undefined);
});

test("Harbor bridge reads the manifest entrypoint and validates it against the file set", async () => {
  // The bridge must not hardcode the TypeScript build layout: it reads the
  // manifest, requires schema v2 with a node launcher, and refuses entrypoints
  // that are absolute, traverse, contain control characters, or are not
  // declared files (spec §4.3).
  const source = await readFile("integrations/harbor/hitch_harbor_agent.py", "utf8");
  assert.match(source, /CONTROLLER_RUNTIME_MANIFEST_VERSION = "2"/);
  assert.match(source, /upload_dir\(payload_dir, "\/opt\/hitch"\)/);
  assert.match(source, /_validate_entrypoint/);
  assert.doesNotMatch(source, /node \/opt\/hitch\/bin\/hitch\.js/);
  assert.doesNotMatch(source, /dist\/bin\/hitch\.js/);
  assert.match(source, /entrypoint not in declared/);
  // Shell-quoting of the full remote path, not just the entrypoint string.
  assert.match(source, /shlex\.quote\(f"\/opt\/hitch\/\{entrypoint\}"\)/);
  assert.match(source, /control characters/);
  // The bridge re-verifies the canonical digest and payload hashes before
  // uploading (TOCTOU closure) and rejects a job-pinned runtime id mismatch.
  assert.match(source, /_verify_manifest_identity/);
  assert.match(source, /_verify_payload/);
  assert.match(source, /runtime id mismatch/);
});

test("Harbor bridge setup() and run() behave against a real bundle", async (t) => {
  // Behavioral smoke test: drive setup() and run() with a fake Harbor
  // environment against an actual controller runtime bundle and assert the
  // upload source, the manifest-declared remote entrypoint, the three CLI
  // invocations, and the recorded runtime id.
  const state = await mkdtemp(path.join(tmpdir(), "hitch-bridge-smoke-"));
  const { ensureControllerRuntime } = await import("../src/controller-runtime/store.js");
  const use = await ensureControllerRuntime({ root: state });
  t.after(() => forceRemove(state));
  const smoke = path.resolve("test-support", "bridge_smoke.py");
  const bridge = path.resolve("integrations", "harbor", "hitch_harbor_agent.py");
  const logs = path.join(state, "logs");
  const result = spawnSync("python3", [smoke, bridge, use.directory, logs], { encoding: "utf8" });
  assert.equal(result.status, 0, `bridge smoke failed:\n${result.stderr || result.stdout}`);
  assert.match(result.stdout, /bridge smoke OK/);
});

test("Harbor bridge rejects a job-pinned controller_runtime_id mismatch before uploading", async (t) => {
  // The bridge must compare the job-pinned controller_runtime_id with the
  // manifest's runtime_id and refuse to upload when they differ (spec §4.6).
  const state = await mkdtemp(path.join(tmpdir(), "hitch-bridge-mismatch-"));
  const { ensureControllerRuntime } = await import("../src/controller-runtime/store.js");
  const use = await ensureControllerRuntime({ root: state });
  t.after(() => forceRemove(state));
  const smoke = path.resolve("test-support", "bridge_smoke.py");
  const bridge = path.resolve("integrations", "harbor", "hitch_harbor_agent.py");
  const logs = path.join(state, "logs");
  const result = spawnSync("python3", [smoke, bridge, use.directory, logs, "--expect-mismatch"], { encoding: "utf8" });
  assert.equal(result.status, 0, `bridge mismatch smoke failed:\n${result.stderr || result.stdout}`);
  assert.match(result.stdout, /bridge negative OK/);
});
