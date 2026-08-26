import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectEval, listEvals, newEvalId, runEval, validateEvalRequest } from "../src/evals/index.js";
import { importEvalTrialRuns } from "../src/evals/index.js";
import { atomicWriteJSON, readJSON } from "../src/foundation/index.js";
import { lockedHarnessRef } from "../src/backends/harbor/index.js";
import { prepareHarness, preparedArtifactDirectory, resolveHarness } from "../src/artifacts/index.js";
import { benchmarkTaskDigest, benchmarkVerifierIdentity } from "../src/runs/index.js";
import { TrajectoryProjector } from "../src/trajectories/projector.js";
import { TrajectoryWriter, canonicalTrajectoryFileRef, trajectoryRefV2 } from "../src/trajectories/store.js";
import { forceRemove, writeFakeDeepseekNpm, writeFakeHarbor, writeFakeNpm } from "../test-support/helpers.js";
import type { EvalRequestInput } from "../src/evals/index.js";

const hitchExecutable = fileURLToPath(new URL("../bin/hitch.js", import.meta.url));

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
  const piArtifact = kwargs.harness_artifact as { harness_id: string; artifact_id: string };
  assert.equal(piArtifact.harness_id, "pi");
  assert.match(piArtifact.artifact_id, /^sha256:[0-9a-f]{64}$/);
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

test("every project-installed version harness is host-prepared and handed to Harbor", async (t) => {
  const harnesses = [
    { id: "codex", version: "0.92.0", packageName: "@openai/codex", binName: "codex" },
    { id: "claude", version: "2.1.25", packageName: "@anthropic-ai/claude-code", binName: "claude" },
    { id: "pi", version: "1.2.3", packageName: "@earendil-works/pi-coding-agent", binName: "pi" },
    { id: "opencode", version: "1.18.15", packageName: "opencode-ai", binName: "opencode" },
  ];
  for (const harness of harnesses) {
    const root = await mkdtemp(path.join(tmpdir(), `hitch-eval-${harness.id}-artifact-`));
    t.after(() => forceRemove(root));
    const fakeNpm = await writeFakeNpm(root, {
      version: harness.version,
      packageName: harness.packageName,
      binName: harness.binName,
    });
    const fakeHarbor = await writeFakeHarbor(root);
    const evalId = newEvalId();
    const result = await runEval({
      evalId,
      root,
      harborExecutable: fakeHarbor,
      env: { ...process.env, HITCH_NPM_PATH: fakeNpm },
      request: {
        dataset: "demo@1.0",
        harness_ref: `${harness.id}@version:${harness.version}`,
        timeout_ms: 5_000,
      },
    });
    assert.equal(result.status, "succeeded", `${harness.id} eval failed`);
    const prepared = result.prepared_artifact as { artifact_id: string; harness_id: string };
    assert.equal(prepared.harness_id, harness.id);
    assert.ok((await stat(preparedArtifactDirectory(root, prepared.artifact_id))).isDirectory());
    const config = await readJSON<Record<string, unknown>>(path.join(root, "evals", evalId, "harbor", "job.json"));
    const agent = (config.agents as Record<string, unknown>[])[0] as Record<string, unknown>;
    const handoff = (agent.kwargs as { harness_artifact: { artifact_id: string; harness_id: string } }).harness_artifact;
    assert.equal(handoff.harness_id, harness.id);
    assert.equal(handoff.artifact_id, prepared.artifact_id);
  }
});

test("DeepSeek eval prepares one host artifact and pins it for every Harbor trial", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-dsh-artifact-"));
  t.after(() => forceRemove(root));
  const fakeNpm = await writeFakeDeepseekNpm(root);
  const fakeHarbor = await writeFakeHarbor(root);
  const evalId = newEvalId();
  const result = await runEval({
    evalId,
    root,
    harborExecutable: fakeHarbor,
    env: { ...process.env, HITCH_NPM_PATH: fakeNpm },
    request: {
      dataset: "demo@1.0",
      harness_ref: "deepseek@version:0.1.0-rc.7",
      model: "deepseek/deepseek-v4-flash",
      attempts: 3,
      max_concurrent: 3,
      timeout_ms: 5_000,
    },
  });

  assert.equal(result.status, "succeeded");
  const prepared = result.prepared_artifact as {
    artifact_id: string;
    harness_id: string;
    revision_identity: string;
  };
  assert.match(prepared.artifact_id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(prepared.harness_id, "deepseek");
  const config = await readJSON<Record<string, unknown>>(path.join(root, "evals", evalId, "harbor", "job.json"));
  const agent = (config.agents as Record<string, unknown>[])[0] as Record<string, unknown>;
  const handoff = ((agent.kwargs as Record<string, unknown>).harness_artifact) as Record<string, string>;
  assert.equal(handoff.artifact_id, prepared.artifact_id);
  assert.equal(handoff.revision_identity, prepared.revision_identity);
  assert.equal(handoff.directory, preparedArtifactDirectory(root, prepared.artifact_id));
  const invocations = (await readFile(path.join(root, "fake-dsh-npm.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(invocations.filter((args) => args[0] === "pack").length, 1);
  assert.equal(invocations.filter((args) => args[0] === "install" && args.includes("--global")).length, 1);
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

test("Harbor bridge uploads and directly uses a compatible host-prepared harness artifact", async (t) => {
  const state = await mkdtemp(path.join(tmpdir(), "hitch-bridge-artifact-"));
  const { ensureControllerRuntime } = await import("../src/controller-runtime/store.js");
  const use = await ensureControllerRuntime({ root: state });
  const fakeNpm = await writeFakeNpm(state);
  const resolved = await resolveHarness("pi@version:1.2.3", {
    root: state,
    env: { ...process.env, HITCH_NPM_PATH: fakeNpm },
  });
  const artifact = await prepareHarness(resolved, {
    root: state,
    env: { ...process.env, HITCH_NPM_PATH: fakeNpm },
  });
  t.after(() => forceRemove(state));
  const smoke = path.resolve("test-support", "bridge_smoke.py");
  const bridge = path.resolve("integrations", "harbor", "hitch_harbor_agent.py");
  const logs = path.join(state, "logs");
  const result = spawnSync("python3", [
    smoke,
    bridge,
    use.directory,
    logs,
    "--artifact",
    preparedArtifactDirectory(state, artifact.artifact_id),
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, `bridge artifact smoke failed:\n${result.stderr || result.stdout}`);
  assert.match(result.stdout, /bridge smoke OK/);

  const fallbackLogs = path.join(state, "fallback-logs");
  const fallback = spawnSync("python3", [
    smoke,
    bridge,
    use.directory,
    fallbackLogs,
    "--artifact",
    preparedArtifactDirectory(state, artifact.artifact_id),
    "--incompatible",
  ], { encoding: "utf8" });
  assert.equal(fallback.status, 0, `bridge artifact fallback smoke failed:\n${fallback.stderr || fallback.stdout}`);
  assert.match(fallback.stdout, /bridge smoke OK/);
});

test("failed Harbor bundle imports retain canonical staging evidence", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-import-failure-"));
  t.after(() => forceRemove(root));
  const evalId = newEvalId();
  const evalDirectory = path.join(root, "evals", evalId);
  const trialId = "regex-log__YNRyNX7";
  const bundle = path.join(evalDirectory, "harbor", "job", trialId, "agent", "hitch-run-bundle");
  await mkdir(bundle, { recursive: true });
  await writeFile(path.join(bundle, "manifest.json"), "{}\n", "utf8");

  const refs = await importEvalTrialRuns({
    root,
    evalId,
    evalDirectory,
    request: {
      harness_ref: "pi@version:1.2.3",
      model: "deepseek/deepseek-v4-flash",
      timeout_ms: 5_000,
      agent_args: [],
    } as never,
    resolvedRevision: {
      harness_id: "pi",
      identity: `sha256:${"a".repeat(64)}`,
    } as never,
    benchmarkId: "benchmark",
    benchmarkRevision: `sha256:${"b".repeat(64)}`,
    rawResult: {
      trial_results: [{ task_name: "regex-log", trial_name: trialId }],
    },
  });

  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.task_id, "regex-log");
  assert.equal(refs[0]?.attempt, 1);
  assert.ok((await stat(bundle)).isDirectory(), "failed staging bundle should remain available");
  assert.ok((await stat(path.join(path.dirname(bundle), "hitch-run-import-error.json"))).isFile());
});

test("Harbor importer uses lock task id when result task_name is display-qualified", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-task-identity-"));
  t.after(() => forceRemove(root));
  const evalId = newEvalId();
  const trialId = "regex-log__YNRyNX7";
  const runId = "run_44444444444444444444444444444444";
  const exportedBundle = path.join(root, "exported-run-bundle");
  await writeExportedEvalRunBundle({
    bundle: exportedBundle,
    runId,
    evalId,
    trialId,
    taskId: "regex-log",
    benchmarkId: "demo",
    benchmarkRevision: "1.0",
  });
  const harbor = await writeTaskIdentityFakeHarbor(root, {
    bundle: exportedBundle,
    trialId,
    canonicalTaskId: "regex-log",
    displayTaskName: "terminal-bench/regex-log",
  });
  const npm = await writeFakeNpm(root);

  const result = await runEval({
    evalId,
    root,
    harborExecutable: harbor,
    env: { ...process.env, HITCH_NPM_PATH: npm },
    request: {
      dataset: "demo@1.0",
      harness_ref: "pi@version:1.2.3",
      model: "openai/test-model",
      timeout_ms: 5_000,
    },
  });

  const trials = result.trials as Array<{
    task_id: string;
    run_id: string;
    observation_status: string;
    reward?: number;
  }>;
  assert.equal(trials.length, 1);
  assert.equal(trials[0]?.task_id, "regex-log");
  assert.equal(trials[0]?.observation_status, "valid");
  assert.equal(trials[0]?.run_id, runId);
  assert.equal(trials[0]?.reward, 1);
  const summary = result.summary as Record<string, unknown>;
  assert.equal(summary.n_completed, 1);
  assert.equal(summary.n_invalid, 0);
  assert.equal(summary.primary_reward, 1);

  const published = path.join(root, "runs", runId);
  assert.ok((await stat(published)).isDirectory());
  const manifest = await readJSON<{ context: { task_id: string } }>(path.join(published, "manifest.json"));
  assert.equal(manifest.context.task_id, "regex-log");
  const importError = path.join(root, "evals", evalId, "harbor", "job", trialId, "agent", "hitch-run-import-error.json");
  await assert.rejects(stat(importError), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

  const inspect = spawnSync(process.execPath, [
    hitchExecutable,
    "--root", root,
    "trajectory", "inspect", runId,
    "--json",
  ], { encoding: "utf8" });
  assert.equal(inspect.status, 0, inspect.stderr || undefined);
  const inspected = JSON.parse(inspect.stdout) as { run_id: string; events: unknown[] };
  assert.equal(inspected.run_id, runId);
  assert.ok(inspected.events.length > 0);
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

async function writeExportedEvalRunBundle(options: {
  bundle: string;
  runId: string;
  evalId: string;
  trialId: string;
  taskId: string;
  benchmarkId: string;
  benchmarkRevision: string;
}): Promise<void> {
  await mkdir(options.bundle, { recursive: true });
  const projector = new TrajectoryProjector({
    runId: options.runId,
    cwd: "/app",
    prompt: "complete the task",
    model: "openai/test-model",
    fidelity: "normalized",
  });
  projector.feed({ type: "message.completed", text: "done" });
  const projected = projector.finalize("succeeded");
  const writer = await TrajectoryWriter.open({
    runDirectory: options.bundle,
    cwd: "/app",
    sessionId: projected.header.id,
    fidelity: "normalized",
    header: projected.header,
  });
  for (const event of projected.events) writer.append(event);
  const trajectory = await writer.close();
  const canonicalFile = await canonicalTrajectoryFileRef(options.bundle, trajectory);
  await atomicWriteJSON(path.join(options.bundle, "trajectory.ref.json"), trajectoryRefV2({
    runId: options.runId,
    fidelity: "normalized",
    files: [canonicalFile],
  }));
  await atomicWriteJSON(path.join(options.bundle, "request.json"), { cwd: "/app" });
  await atomicWriteJSON(path.join(options.bundle, "resolution.json"), { schema_version: "1" });
  await atomicWriteJSON(path.join(options.bundle, "result.json"), {
    schema_version: "1",
    run_id: options.runId,
    status: "succeeded",
    exit_code: 0,
  });
  await writeFile(path.join(options.bundle, "events.jsonl"), `${JSON.stringify({ type: "run.completed" })}\n`, "utf8");
  const now = new Date().toISOString();
  await atomicWriteJSON(path.join(options.bundle, "manifest.json"), {
    schema_version: "1",
    run_id: options.runId,
    context: {
      kind: "benchmark_task",
      benchmark_id: options.benchmarkId,
      benchmark_revision: options.benchmarkRevision,
      task_id: options.taskId,
      task_digest: benchmarkTaskDigest(options.benchmarkId, options.benchmarkRevision, options.taskId),
      verifier_identity: benchmarkVerifierIdentity(options.benchmarkId, options.benchmarkRevision),
    },
    parent: { kind: "eval", eval_id: options.evalId, trial_id: options.trialId, attempt: 1 },
    status: "succeeded",
    harness: {
      harness_id: "pi",
      requested_ref: "pi@version:1.2.3",
      revision_identity: `sha256:${"a".repeat(64)}`,
    },
    model: {
      provider: "openai",
      requested_id: "openai/test-model",
      effective_id: "openai/test-model",
      identity_resolved: false,
    },
    protocol: { timeout_ms: 5_000, workspace_mode: "shared" },
    request_ref: "request.json",
    resolution_ref: "resolution.json",
    result_ref: "result.json",
    trajectory_ref: "trajectory.ref.json",
    created_at: now,
    completed_at: now,
    sealed: false,
  });
}

async function writeTaskIdentityFakeHarbor(directory: string, options: {
  bundle: string;
  trialId: string;
  canonicalTaskId: string;
  displayTaskName: string;
}): Promise<string> {
  const executable = path.join(directory, "fake-harbor-task-identity");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("harbor 0.21.0\\n");
  process.exit(0);
}
const configIndex = args.indexOf("--config");
if (args[0] !== "run" || configIndex < 0 || !args.includes("--yes")) process.exit(2);
const config = JSON.parse(fs.readFileSync(args[configIndex + 1], "utf8"));
const output = path.join(config.jobs_dir, config.job_name);
const trialDirectory = path.join(output, ${JSON.stringify(options.trialId)});
const agentDirectory = path.join(trialDirectory, "agent");
fs.mkdirSync(agentDirectory, {recursive:true});
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({
  n_total_trials: 1,
  stats: {n_completed_trials: 1, n_errored_trials: 0, n_cancelled_trials: 0}
}));
fs.writeFileSync(path.join(trialDirectory, "lock.json"), JSON.stringify({
  task: {name: ${JSON.stringify(options.canonicalTaskId)}}
}));
fs.writeFileSync(path.join(trialDirectory, "result.json"), JSON.stringify({
  task_name: ${JSON.stringify(options.displayTaskName)},
  trial_name: ${JSON.stringify(options.trialId)},
  verifier_result: {rewards: {reward: 1}}
}));
fs.cpSync(${JSON.stringify(options.bundle)}, path.join(agentDirectory, "hitch-run-bundle"), {recursive:true});
process.stdout.write("Results written\\n");
`;
  await writeFile(executable, source, { mode: 0o755 });
  return executable;
}
