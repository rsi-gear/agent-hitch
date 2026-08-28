import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEvalProgress, inspectEval, listEvals, mergeEvalProgressTrial, newEvalId, replaceInvalidEvalProgressTrial, rerunEval, resolveLocalDatasetTaskIds, runEval, selectRerunTasks, selectRerunTrialSlots, validateEvalRequest } from "../src/evals/index.js";
import { importEvalTrialRuns } from "../src/evals/index.js";
import { readHarborBridgeError } from "../src/evals/harbor-bridge-error.js";
import { detectVerifierInfrastructureFailure } from "../src/evals/verifier-diagnostics.js";
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
  assert.equal(request.infrastructure_retries, 1);
  assert.equal(request.infrastructure_retry_backoff_ms, 1_000);
  assert.equal(request.timeout_ms, 15 * 60 * 1_000);
  await assert.rejects(
    validateEvalRequest(evalRequest({ infrastructure_retries: -1 })),
    /infrastructure_retries must be a non-negative integer/,
  );
  assert.equal(lockedHarnessRef({
    harness_id: "pi",
    revision: { type: "commit", commit: "0123456789abcdef0123456789abcdef01234567" },
    source: { type: "git", url: "https://example.test/pi.git", registered: true },
  } as never), "pi@commit:0123456789abcdef0123456789abcdef01234567");
});

test("verifier diagnostics distinguish masked bootstrap failures from executed tests", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-verifier-diagnostic-"));
  t.after(() => forceRemove(root));
  const verifier = path.join(root, "verifier");
  await mkdir(verifier, { recursive: true });
  await writeFile(path.join(verifier, "test-stdout.txt"), [
    "curl: (6) Could not resolve host: astral.sh",
    "/tests/test.sh: line 19: uvx: command not found",
  ].join("\n"), "utf8");

  const detected = await detectVerifierInfrastructureFailure(root, 0);
  assert.equal(detected?.code, "verifier_infrastructure_failure");
  assert.deepEqual(detected?.signals, ["dns_resolution_failed", "test_runner_missing"]);
  assert.equal(await detectVerifierInfrastructureFailure(root, 1), null);

  await writeFile(path.join(verifier, "ctrf.json"), "{}\n", "utf8");
  assert.equal(await detectVerifierInfrastructureFailure(root, 0), null);
  await writeFile(path.join(verifier, "ctrf.json"), "", "utf8");
  await writeFile(path.join(verifier, "test-stdout.txt"), [
    "============================= test session starts ==============================",
    "collected 1 item",
    "curl: (6) Could not resolve host: candidate.invalid",
    "============================== 1 failed in 0.1s ===============================",
  ].join("\n"), "utf8");
  assert.equal(await detectVerifierInfrastructureFailure(root, 0), null);

  await atomicWriteJSON(path.join(verifier, "infrastructure-error.json"), {
    schema_version: "1",
    code: "verifier_infrastructure_failure",
    signals: ["dns_resolution_failed", "test_runner_missing"],
    source_files: ["verifier/infrastructure-attempts/attempt-0002/test-stdout.txt"],
    attempts: [
      { attempt: 1, signals: ["dns_resolution_failed"], source_files: ["verifier/test-stdout.txt"] },
      { attempt: 2, signals: ["test_runner_missing"], source_files: ["verifier/test-stdout.txt"] },
    ],
    max_retries: 1,
    backoff_ms: 0,
  });
  const exhausted = await detectVerifierInfrastructureFailure(root, undefined);
  assert.equal(exhausted?.max_retries, 1);
  assert.equal(exhausted?.attempts?.length, 2);
});

test("eval progress is canonical, monotonic, and rejects conflicting trial identities", () => {
  const evalId = newEvalId();
  const progress = createEvalProgress({
    evalId,
    benchmarkId: "demo",
    benchmarkRevision: "1.0",
    plannedTasks: 2,
    plannedTrials: 2,
    startedAt: "2026-08-26T00:00:00.000Z",
  });
  assert.equal(progress.planned_tasks, 2);
  assert.equal(progress.planned_trials, 2);
  const second = mergeEvalProgressTrial(progress, {
    trial_id: "task-b__1",
    run_id: "run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    task_id: "task-b",
    attempt: 1,
    observation_status: "valid",
    reward: 1,
  }, "2026-08-26T00:00:01.000Z");
  const third = mergeEvalProgressTrial(second, {
    trial_id: "task-a__1",
    run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    task_id: "task-a",
    attempt: 1,
    observation_status: "invalid",
    invalid_reason: "infrastructure_failure",
  }, "2026-08-26T00:00:02.000Z");
  assert.equal(third.generation, 2);
  assert.deepEqual(third.trials.map((trial) => trial.task_id), ["task-a", "task-b"]);
  assert.deepEqual(third.summary, { settled_trials: 2, valid_trials: 1, invalid_trials: 1 });
  assert.throws(() => mergeEvalProgressTrial(third, {
    ...third.trials[0]!,
    run_id: "run_cccccccccccccccccccccccccccccccc",
  }), /trial identity conflict/);
});

test("eval rerun selects only invalid tasks and replaces no valid reward", () => {
  const evalId = newEvalId();
  let progress = createEvalProgress({
    evalId,
    benchmarkId: "demo",
    benchmarkRevision: "1.0",
    plannedTasks: 3,
    plannedTrials: 3,
    startedAt: "2026-08-27T00:00:00.000Z",
  });
  progress = mergeEvalProgressTrial(progress, {
    trial_id: "task-a__1",
    run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    task_id: "task-a",
    attempt: 1,
    observation_status: "valid",
    reward: 0,
  });
  progress = mergeEvalProgressTrial(progress, {
    trial_id: "task-b__1",
    run_id: "run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    task_id: "task-b",
    attempt: 1,
    observation_status: "invalid",
    invalid_reason: "infrastructure_failure",
  });
  assert.deepEqual(selectRerunTasks(["task-a", "task-b", "task-c"], progress, { mode: "invalid" }), ["task-b", "task-c"]);
  assert.deepEqual(selectRerunTasks(["task-a", "task-b", "task-c"], progress, { mode: "tasks", taskNames: ["task-c", "task-b", "task-b"] }), ["task-b", "task-c"]);
  assert.throws(
    () => selectRerunTasks(["task-a", "task-b", "task-c"], progress, { mode: "tasks", taskNames: ["task-a"] }),
    (error: unknown) => (error as { code?: string }).code === "eval_task_already_valid",
  );
  const repaired = replaceInvalidEvalProgressTrial(progress, {
    trial_id: "task-b__rerun-1",
    run_id: "run_cccccccccccccccccccccccccccccccc",
    task_id: "task-b",
    attempt: 1,
    observation_status: "valid",
    reward: 0.75,
  });
  assert.equal(repaired.trials.find((trial) => trial.task_id === "task-a")?.reward, 0);
  assert.equal(repaired.trials.find((trial) => trial.task_id === "task-a")?.run_id, "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(repaired.trials.find((trial) => trial.task_id === "task-b")?.reward, 0.75);
  assert.deepEqual(selectRerunTasks(["task-a", "task-b", "task-c"], repaired, { mode: "invalid" }), ["task-c"]);
});

test("eval rerun never turns a verifier fault into another candidate execution", () => {
  const evalId = newEvalId();
  let progress = createEvalProgress({
    evalId,
    benchmarkId: "demo",
    benchmarkRevision: "1.0",
    plannedTasks: 1,
    plannedTrials: 1,
    startedAt: "2026-08-27T00:00:00.000Z",
  });
  progress = mergeEvalProgressTrial(progress, {
    trial_id: "task-a__1",
    run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    task_id: "task-a",
    attempt: 1,
    observation_status: "invalid",
    invalid_reason: "verifier_infrastructure_failure",
  });
  assert.throws(
    () => selectRerunTrialSlots(["task-a"], 1, progress, { mode: "invalid" }),
    (error: unknown) => (error as { code?: string }).code === "eval_verifier_only_rerun_unavailable",
  );
});

test("multi-attempt rerun selection uses logical task/attempt slots", () => {
  const evalId = newEvalId();
  let progress = createEvalProgress({
    evalId,
    benchmarkId: "demo",
    benchmarkRevision: "1.0",
    plannedTasks: 2,
    plannedTrials: 6,
    startedAt: "2026-08-27T00:00:00.000Z",
  });
  const refs = [
    { trial_id: "task-a__random-a1", run_id: "run_11111111111111111111111111111111", task_id: "task-a", attempt: 1, observation_status: "valid", reward: 1 },
    { trial_id: "task-a__random-a2", run_id: "run_22222222222222222222222222222222", task_id: "task-a", attempt: 2, observation_status: "invalid", invalid_reason: "infrastructure_failure" },
    { trial_id: "task-b__random-b1", run_id: "run_33333333333333333333333333333333", task_id: "task-b", attempt: 1, observation_status: "valid", reward: 1 },
    { trial_id: "task-b__random-b2", run_id: "run_44444444444444444444444444444444", task_id: "task-b", attempt: 2, observation_status: "valid", reward: 0.5 },
    { trial_id: "task-b__random-b3", run_id: "run_55555555555555555555555555555555", task_id: "task-b", attempt: 3, observation_status: "valid", reward: 0.75 },
  ] as const;
  for (const ref of refs) progress = mergeEvalProgressTrial(progress, ref);
  assert.deepEqual(selectRerunTrialSlots(["task-a", "task-b"], 3, progress, { mode: "invalid" }), [
    { task_id: "task-a", attempt: 2 },
    { task_id: "task-a", attempt: 3 },
  ]);
  assert.deepEqual(selectRerunTrialSlots(["task-a", "task-b"], 3, progress, { mode: "tasks", taskNames: ["task-a"] }), [
    { task_id: "task-a", attempt: 2 },
    { task_id: "task-a", attempt: 3 },
  ]);
  assert.throws(() => mergeEvalProgressTrial(progress, {
    trial_id: "task-a__duplicate-slot",
    run_id: "run_66666666666666666666666666666666",
    task_id: "task-a",
    attempt: 1,
    observation_status: "valid",
    reward: 0,
  }), /logical trial conflict/);
});

test("legacy multi-attempt plans fail before Harbor execution", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-legacy-multi-rerun-"));
  t.after(() => forceRemove(root));
  const evalId = newEvalId();
  const evalDirectory = path.join(root, "evals", evalId);
  await mkdir(evalDirectory, { recursive: true });
  const request = await validateEvalRequest(evalRequest({ attempts: 2 }));
  await atomicWriteJSON(path.join(evalDirectory, "request.json"), request);
  await atomicWriteJSON(path.join(evalDirectory, "plan.json"), {
    schema_version: "1",
    eval_id: evalId,
    dataset: request.dataset,
    benchmark_id: request.benchmark_id,
    benchmark_revision: request.benchmark_revision,
    attempts: 2,
    tasks: ["task-a"],
  });
  await assert.rejects(rerunEval({
    evalId,
    root,
    selector: { mode: "invalid" },
    harborExecutable: path.join(root, "must-not-run"),
  }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "eval_rerun_legacy_attempt_identity");
    return true;
  });
});

test("local eval datasets expose a deterministic immutable task plan", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-local-dataset-plan-"));
  t.after(() => forceRemove(root));
  const dataset = path.join(root, "dataset");
  await mkdir(path.join(dataset, "task-b"), { recursive: true });
  await mkdir(path.join(dataset, "task-a"), { recursive: true });
  await mkdir(path.join(dataset, "ignored"), { recursive: true });
  await writeFile(path.join(dataset, "task-b", "task.toml"), "", "utf8");
  await writeFile(path.join(dataset, "task-a", "task.toml"), "", "utf8");
  assert.deepEqual(await resolveLocalDatasetTaskIds(dataset), ["task-a", "task-b"]);
  assert.equal(await resolveLocalDatasetTaskIds("demo@1.0"), null);

  const singleTask = path.join(root, "single-task");
  await mkdir(singleTask);
  await writeFile(path.join(singleTask, "task.toml"), "", "utf8");
  assert.deepEqual(await resolveLocalDatasetTaskIds(singleTask), ["single-task"]);
});

test("runEval refuses to reuse an explicitly reserved eval id", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-id-conflict-"));
  t.after(() => forceRemove(root));
  const evalId = newEvalId();
  await mkdir(path.join(root, "evals", evalId), { recursive: true });
  await assert.rejects(runEval({ evalId, root, request: evalRequest() }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "eval_id_conflict");
    return true;
  });
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

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "eval_has_invalid_tasks");
  const summary = result.summary as Record<string, unknown>;
  assert.equal(summary.n_trials, 4);
  assert.equal(summary.primary_reward, null);
  assert.equal(summary.n_invalid, 4);
  const backendRuns = result.backend_runs as Array<{ attempt: number; backend_summary: Record<string, unknown> }>;
  assert.deepEqual(backendRuns.map(({ attempt }) => attempt), [1, 2]);
  const backendSummary = backendRuns[0]!.backend_summary;
  assert.equal(backendSummary.primary_reward, 0.75);
  const trials = result.trials as Array<{ run_id: string; observation_status: string; invalid_reason: string }>;
  assert.equal(trials.length, 4);
  assert.ok(trials.every((trial) => /^run_[a-f0-9]{32}$/.test(trial.run_id)));
  assert.ok(trials.every((trial) => trial.observation_status === "invalid" && trial.invalid_reason === "trajectory_missing_or_corrupt"));
  for (const trial of trials) {
    const manifest = await readJSON<Record<string, unknown>>(path.join(root, "runs", trial.run_id, "manifest.json"));
    assert.equal((manifest.context as Record<string, unknown>).kind, "benchmark_task");
    assert.equal((manifest.parent as Record<string, unknown>).eval_id, evalId);
  }
  const directory = path.join(root, "evals", evalId);
  const config = await readJSON<Record<string, unknown>>(path.join(directory, "harbor", "attempt-0001", "job.json"));
  const agent = (config.agents as Record<string, unknown>[])[0] as Record<string, unknown>;
  const kwargs = agent.kwargs as Record<string, unknown>;
  assert.equal(agent.import_path, "hitch_harbor_agent:HitchHarborAgent");
  assert.equal(kwargs.harness_ref, "pi@version:1.2.3");
  assert.equal(kwargs.workdir, undefined, "Harbor must preserve the task/image WORKDIR");
  assert.equal(kwargs.harness_artifact_cache_dir, path.join(root, "store", "harbor-artifacts"));
  assert.ok((await stat(kwargs.harness_artifact_cache_dir as string)).isDirectory());
  const piArtifact = kwargs.harness_artifact as { harness_id: string; artifact_id: string; node_version: string };
  assert.equal(piArtifact.harness_id, "pi");
  assert.match(piArtifact.artifact_id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(piArtifact.node_version, process.version);
  assert.equal((agent.env as Record<string, unknown>).DEEPSEEK_API_KEY, "${DEEPSEEK_API_KEY}");
  assert.equal((agent.env as Record<string, unknown>).OPENAI_API_KEY, "${OPENAI_API_KEY}");
  assert.deepEqual(config.verifier, {
    import_path: "hitch_harbor_verifier:HitchRetryingVerifier",
    kwargs: {
      infrastructure_retries: 1,
      infrastructure_retry_backoff_ms: 1_000,
    },
  });
  assert.doesNotMatch(await readFile(path.join(directory, "harbor", "attempt-0001", "job.json"), "utf8"), /(?:deepseek-)?must-not-be-written/);
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
  assert.equal(inspected.result?.status, "failed");
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
    assert.equal(result.status, "failed", `${harness.id} eval unexpectedly succeeded without valid evidence`);
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

  assert.equal(result.status, "failed");
  const prepared = result.prepared_artifact as {
    artifact_id: string;
    harness_id: string;
    revision_identity: string;
  };
  assert.match(prepared.artifact_id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(prepared.harness_id, "deepseek");
  const config = await readJSON<Record<string, unknown>>(path.join(root, "evals", evalId, "harbor", "attempt-0001", "job.json"));
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
  for (const source of [
    path.resolve("integrations/harbor/hitch_harbor_agent.py"),
    path.resolve("integrations/harbor/hitch_harbor_verifier.py"),
  ]) {
    const result = spawnSync("python3", ["-c", "import pathlib; compile(pathlib.Path(__import__('sys').argv[1]).read_text(), __import__('sys').argv[1], 'exec')", source], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || undefined);
  }
});

test("Harbor verifier retries only its test phase and preserves real zero rewards", () => {
  const smoke = path.resolve("test-support", "verifier_retry_smoke.py");
  const verifier = path.resolve("integrations", "harbor", "hitch_harbor_verifier.py");
  const result = spawnSync("python3", [smoke, verifier], { encoding: "utf8" });
  assert.equal(result.status, 0, `verifier retry smoke failed:\n${result.stderr || result.stdout}`);
  assert.match(result.stdout, /verifier retry smoke OK/);
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

test("Harbor bridge inherits an image WORKDIR=/workspace and rejects missing workdirs before startup", async (t) => {
  // Behavioral smoke test: drive setup() and run() with a fake Harbor
  // environment whose image cwd is /workspace against an actual controller
  // runtime bundle and assert the resolved cwd reaches the Hitch run.
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

test("Harbor bridge classifies persisted-result failures without masking process evidence", async (t) => {
  const state = await mkdtemp(path.join(tmpdir(), "hitch-bridge-result-matrix-"));
  const { ensureControllerRuntime } = await import("../src/controller-runtime/store.js");
  const use = await ensureControllerRuntime({ root: state });
  t.after(() => forceRemove(state));
  const smoke = path.resolve("test-support", "bridge_smoke.py");
  const bridge = path.resolve("integrations", "harbor", "hitch_harbor_agent.py");
  const logs = path.join(state, "logs");
  const result = spawnSync("python3", [smoke, bridge, use.directory, logs, "--result-matrix"], { encoding: "utf8" });
  assert.equal(result.status, 0, `bridge result matrix failed:\n${result.stderr || result.stdout}`);
  assert.match(result.stdout, /bridge result matrix OK/);
});

test("Harbor bridge diagnostic reader promotes OCI stdout when the legacy message says no output", async (t) => {
  const trialDirectory = await mkdtemp(path.join(tmpdir(), "hitch-bridge-stdout-diagnostic-"));
  t.after(() => forceRemove(trialDirectory));
  await mkdir(path.join(trialDirectory, "agent"), { recursive: true });
  await atomicWriteJSON(path.join(trialDirectory, "agent", "hitch-bridge-error.json"), {
    schema_version: "1",
    code: "hitch_process_failed",
    message: "Hitch agent run failed with code 126: no diagnostic output",
    process: {
      return_code: 126,
      stdout_tail: 'chdir to cwd ("/app") failed: no such file or directory',
      stderr_tail: "",
    },
  });

  const diagnostic = await readHarborBridgeError(trialDirectory);
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /chdir to cwd \("\/app"\) failed/);
  assert.doesNotMatch(diagnostic.message, /no diagnostic output/);
});

test("Harbor bridge uploads compatible artifacts and host-caches one target-platform build across concurrent trials", async (t) => {
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

test("Harbor diagnostic runs retain a validated bridge error without trusting its identity", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-bridge-diagnostic-"));
  t.after(() => forceRemove(root));
  const evalId = newEvalId();
  const evalDirectory = path.join(root, "evals", evalId);
  const trialId = "canonical-task__random";
  const trialDirectory = path.join(evalDirectory, "harbor", "job", trialId);
  const agentDirectory = path.join(trialDirectory, "agent");
  await mkdir(agentDirectory, { recursive: true });
  await atomicWriteJSON(path.join(trialDirectory, "lock.json"), {
    schema_version: 2,
    task: { name: "canonical-task" },
  });
  await atomicWriteJSON(path.join(agentDirectory, "hitch-bridge-error.json"), {
    schema_version: "1",
    code: "hitch_result_missing",
    message: "Hitch result file is missing",
    eval_id: "eval_forged",
    trial_id: "forged-trial",
    task_id: "forged-task",
    assigned_run_id: "run_ffffffffffffffffffffffffffffffff",
  });

  const refs = await importEvalTrialRuns({
    root,
    evalId,
    evalDirectory,
    request: {
      harness_ref: "pi@version:1.2.3",
      model: "openai/test-model",
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
      trial_results: [{
        task_name: "terminal-bench/display-task",
        trial_name: trialId,
        exception_info: { exception_type: "HitchBridgeError" },
      }],
    },
  });

  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.task_id, "canonical-task");
  assert.equal(refs[0]?.observation_status, "invalid");
  assert.equal(refs[0]?.invalid_reason, "infrastructure_failure");
  const runDirectory = path.join(root, "runs", refs[0]!.run_id);
  const result = await readJSON<{ run_id: string; error: { code: string; message: string } }>(path.join(runDirectory, "result.json"));
  assert.equal(result.run_id, refs[0]?.run_id);
  assert.deepEqual(result.error, {
    code: "hitch_result_missing",
    message: "Hitch result file is missing",
  });
  const manifest = await readJSON<{
    context: { task_id: string };
    parent: { eval_id: string; trial_id: string };
    diagnostics: { harbor_bridge_error_ref: string };
  }>(path.join(runDirectory, "manifest.json"));
  assert.equal(manifest.context.task_id, "canonical-task");
  assert.equal(manifest.parent.eval_id, evalId);
  assert.equal(manifest.parent.trial_id, trialId);
  assert.equal(manifest.diagnostics.harbor_bridge_error_ref, "diagnostics/harbor-bridge-error.json");
  const diagnostic = await readJSON<{ code: string; eval_id: string }>(
    path.join(runDirectory, "diagnostics", "harbor-bridge-error.json"),
  );
  assert.equal(diagnostic.code, "hitch_result_missing");
  assert.equal(diagnostic.eval_id, "eval_forged", "artifact identity is evidence only");
});

test("Harbor diagnostic runs safely ignore an invalid bridge error artifact", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-invalid-bridge-diagnostic-"));
  t.after(() => forceRemove(root));
  const evalId = newEvalId();
  const evalDirectory = path.join(root, "evals", evalId);
  const trialId = "safe-task__random";
  const trialDirectory = path.join(evalDirectory, "harbor", "job", trialId);
  const agentDirectory = path.join(trialDirectory, "agent");
  await mkdir(agentDirectory, { recursive: true });
  await atomicWriteJSON(path.join(trialDirectory, "lock.json"), {
    schema_version: 2,
    task: { name: "safe-task" },
  });
  await atomicWriteJSON(path.join(agentDirectory, "hitch-bridge-error.json"), {
    schema_version: "1",
    code: "attacker_controlled_code",
    message: "do not trust this",
  });

  const refs = await importEvalTrialRuns({
    root,
    evalId,
    evalDirectory,
    request: {
      harness_ref: "pi@version:1.2.3",
      model: "openai/test-model",
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
      trial_results: [{
        task_name: "safe-task",
        trial_name: trialId,
        exception_info: { exception_type: "InfraError" },
      }],
    },
  });

  const runDirectory = path.join(root, "runs", refs[0]!.run_id);
  const result = await readJSON<{ error: { code: string } }>(path.join(runDirectory, "result.json"));
  assert.equal(result.error.code, "infrastructure_failure");
  await assert.rejects(
    stat(path.join(runDirectory, "diagnostics", "harbor-bridge-error.json")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
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

test("Harbor eval publishes a completed trial before the aggregate benchmark result", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-incremental-"));
  t.after(() => forceRemove(root));
  const evalId = newEvalId();
  const dataset = path.join(root, "dataset");
  for (const taskId of ["task-one", "task-two"]) {
    await mkdir(path.join(dataset, taskId), { recursive: true });
    await writeFile(path.join(dataset, taskId, "task.toml"), "", "utf8");
  }
  const normalized = await validateEvalRequest(evalRequest({ dataset }));
  const first = {
    trialId: "task-one__1",
    taskId: "task-one",
    runId: "run_11111111111111111111111111111111",
    bundle: path.join(root, "first-run-bundle"),
  };
  const second = {
    trialId: "task-two__1",
    taskId: "task-two",
    runId: "run_22222222222222222222222222222222",
    bundle: path.join(root, "second-run-bundle"),
  };
  for (const trial of [first, second]) {
    await writeExportedEvalRunBundle({
      bundle: trial.bundle,
      runId: trial.runId,
      evalId,
      trialId: trial.trialId,
      taskId: trial.taskId,
      benchmarkId: normalized.benchmark_id,
      benchmarkRevision: normalized.benchmark_revision,
    });
  }
  const harbor = await writeIncrementalFakeHarbor(root, { first, second });
  const npm = await writeFakeNpm(root);
  const running = runEval({
    evalId,
    root,
    harborExecutable: harbor,
    env: { ...process.env, HITCH_NPM_PATH: npm },
    request: {
      dataset,
      harness_ref: "pi@version:1.2.3",
      model: "openai/test-model",
      timeout_ms: 5_000,
    },
  });

  const evalDirectory = path.join(root, "evals", evalId);
  type ObservedProgress = {
    status: string;
    generation: number;
    planned_tasks: number | null;
    planned_trials: number | null;
    trials: Array<{ run_id: string }>;
  };
  let observed: ObservedProgress | null = null;
  for (let index = 0; index < 200; index += 1) {
    observed = await readJSON<ObservedProgress | null>(path.join(evalDirectory, "progress.json"), null).catch(() => null);
    if (observed?.trials.length === 1) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(observed?.status, "running");
  assert.equal(observed?.generation, 1);
  assert.equal(observed?.planned_tasks, 2);
  assert.equal(observed?.planned_trials, 2);
  assert.deepEqual(observed?.trials.map((trial) => trial.run_id), [first.runId]);
  await assert.rejects(stat(path.join(evalDirectory, "result.json")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

  const result = await running;
  assert.equal(result.status, "succeeded");
  const finalProgress = await readJSON<ObservedProgress>(path.join(evalDirectory, "progress.json"));
  assert.equal(finalProgress.generation, 2);
  assert.equal(finalProgress.planned_tasks, 2);
  assert.equal(finalProgress.planned_trials, 2);
  assert.deepEqual(finalProgress.trials.map((trial) => trial.run_id), [first.runId, second.runId]);
});

test("Harbor eval retries a masked verifier bootstrap failure without rerunning the candidate", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-verifier-retry-"));
  t.after(() => forceRemove(root));
  const evalId = newEvalId();
  const dataset = path.join(root, "dataset");
  const taskId = "task-infra";
  await mkdir(path.join(dataset, taskId), { recursive: true });
  await writeFile(path.join(dataset, taskId, "task.toml"), "", "utf8");
  const normalized = await validateEvalRequest(evalRequest({ dataset }));
  const trial = {
    trialId: "task-infra__single-candidate-run",
    taskId,
    runId: "run_77777777777777777777777777777777",
    bundle: path.join(root, "single-run-bundle"),
  };
  await writeExportedEvalRunBundle({
    bundle: trial.bundle,
    runId: trial.runId,
    evalId,
    trialId: trial.trialId,
    taskId,
    benchmarkId: normalized.benchmark_id,
    benchmarkRevision: normalized.benchmark_revision,
  });
  const harbor = await writeVerifierRetryFakeHarbor(root, trial);
  const npm = await writeFakeNpm(root);
  const result = await runEval({
    evalId,
    root,
    harborExecutable: harbor,
    env: { ...process.env, HITCH_NPM_PATH: npm },
    request: {
      dataset,
      harness_ref: "pi@version:1.2.3",
      model: "openai/test-model",
      timeout_ms: 5_000,
      infrastructure_retries: 1,
      infrastructure_retry_backoff_ms: 0,
    },
  });

  assert.equal(result.status, "succeeded");
  assert.equal((result.summary as { primary_reward: number }).primary_reward, 1);
  const finalTrials = result.trials as Array<{ run_id: string; observation_status: string; reward?: number }>;
  assert.deepEqual(finalTrials, [{
    trial_id: trial.trialId,
    run_id: trial.runId,
    task_id: taskId,
    attempt: 1,
    observation_status: "valid",
    reward: 1,
    verifier_result_ref: "verifier/result.json",
  }]);
  assert.equal(result.infrastructure_retry_runs, undefined);
  assert.deepEqual(result.infrastructure_retry_policy, {
    max_retries: 1,
    backoff_ms: 0,
    verifier_execution: "same_trial_verifier_only",
    candidate_rerun_on_verifier_failure: false,
  });
  const history = await readJSON<{ status: string; candidate_rerun: boolean; attempts: Array<{ signals: string[] }> }>(
    path.join(root, "runs", trial.runId, "verifier", "infrastructure-retry-history.json"),
  );
  assert.equal(history.status, "recovered");
  assert.equal(history.candidate_rerun, false);
  assert.deepEqual(history.attempts[0]?.signals, ["dns_resolution_failed", "test_runner_missing"]);
  assert.equal(await readFile(path.join(root, "fake-harbor-verifier-retry.count"), "utf8"), "1");
  await assert.rejects(
    stat(path.join(root, "evals", evalId, "infrastructure-retries")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});

test("exhausted verifier-only retries fail explicitly without starting another candidate trial", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-verifier-exhausted-"));
  t.after(() => forceRemove(root));
  const evalId = newEvalId();
  const dataset = path.join(root, "dataset");
  const taskId = "task-infra";
  await mkdir(path.join(dataset, taskId), { recursive: true });
  await writeFile(path.join(dataset, taskId, "task.toml"), "", "utf8");
  const normalized = await validateEvalRequest(evalRequest({ dataset }));
  const trial = {
    trialId: "task-infra__exhausted",
    taskId,
    runId: "run_88888888888888888888888888888888",
    bundle: path.join(root, "exhausted-run-bundle"),
  };
  await writeExportedEvalRunBundle({
    bundle: trial.bundle,
    runId: trial.runId,
    evalId,
    trialId: trial.trialId,
    taskId,
    benchmarkId: normalized.benchmark_id,
    benchmarkRevision: normalized.benchmark_revision,
  });
  const harbor = await writeVerifierExhaustedFakeHarbor(root, trial);
  const npm = await writeFakeNpm(root);
  const result = await runEval({
    evalId,
    root,
    harborExecutable: harbor,
    env: { ...process.env, HITCH_NPM_PATH: npm },
    request: {
      dataset,
      harness_ref: "pi@version:1.2.3",
      model: "openai/test-model",
      timeout_ms: 5_000,
      infrastructure_retries: 1,
      infrastructure_retry_backoff_ms: 0,
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "eval_infrastructure_retries_exhausted");
  assert.equal((result.trials as Array<{ invalid_reason: string }>)[0]?.invalid_reason, "verifier_infrastructure_failure");
  assert.equal(await readFile(path.join(root, "fake-harbor-verifier-exhausted.count"), "utf8"), "1");
  await assert.rejects(
    stat(path.join(root, "evals", evalId, "infrastructure-retries")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  const diagnostic = await readJSON<{ attempts: unknown[]; max_retries: number }>(
    path.join(root, "runs", trial.runId, "verifier", "infrastructure-error.json"),
  );
  assert.equal(diagnostic.attempts.length, 2);
  assert.equal(diagnostic.max_retries, 1);
});

test("Harbor eval publishes a diagnostic trial after the bundle readiness grace", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-diagnostic-progress-"));
  t.after(() => forceRemove(root));
  const evalId = newEvalId();
  const dataset = path.join(root, "dataset");
  await mkdir(path.join(dataset, "task-timeout"), { recursive: true });
  await writeFile(path.join(dataset, "task-timeout", "task.toml"), "", "utf8");
  const harbor = await writeMissingBundleFakeHarbor(root);
  const npm = await writeFakeNpm(root);
  const running = runEval({
    evalId,
    root,
    harborExecutable: harbor,
    env: { ...process.env, HITCH_NPM_PATH: npm },
    trialBundleGraceMs: 100,
    request: {
      dataset,
      harness_ref: "pi@version:1.2.3",
      model: "openai/test-model",
      timeout_ms: 5_000,
      infrastructure_retries: 0,
    },
  });

  const evalDirectory = path.join(root, "evals", evalId);
  type DiagnosticProgress = {
    planned_tasks: number | null;
    planned_trials: number | null;
    trials: Array<{ task_id: string; observation_status: string; invalid_reason?: string }>;
  };
  let observed: DiagnosticProgress | null = null;
  for (let index = 0; index < 200; index += 1) {
    observed = await readJSON<DiagnosticProgress | null>(path.join(evalDirectory, "progress.json"), null).catch(() => null);
    if (observed?.trials.length === 1) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(observed?.planned_tasks, 1);
  assert.equal(observed?.planned_trials, 1);
  assert.deepEqual(observed?.trials.map(({ task_id, observation_status, invalid_reason }) => ({
    task_id,
    observation_status,
    invalid_reason,
  })), [{
    task_id: "task-timeout",
    observation_status: "invalid",
    invalid_reason: "infrastructure_failure",
  }]);
  await assert.rejects(stat(path.join(evalDirectory, "result.json")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

  const result = await running;
  assert.equal(result.status, "failed");
  assert.equal((result.trials as Array<{ observation_status: string }>)[0]?.observation_status, "invalid");
});

test("eval rerun executes only invalid tasks and preserves valid rewards", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-rerun-"));
  t.after(() => forceRemove(root));
  const evalId = newEvalId();
  const dataset = path.join(root, "dataset");
  for (const taskId of ["task-a", "task-b"]) {
    await mkdir(path.join(dataset, taskId), { recursive: true });
    await writeFile(path.join(dataset, taskId, "task.toml"), "", "utf8");
  }
  const normalized = await validateEvalRequest(evalRequest({ dataset }));
  const taskA = {
    trialId: "task-a__1",
    taskId: "task-a",
    runId: "run_33333333333333333333333333333333",
    bundle: path.join(root, "task-a-bundle"),
  };
  const taskB = {
    trialId: "task-b__1",
    taskId: "task-b",
    runId: "run_44444444444444444444444444444444",
    bundle: path.join(root, "task-b-bundle"),
  };
  for (const trial of [taskA, taskB]) {
    await writeExportedEvalRunBundle({
      bundle: trial.bundle,
      runId: trial.runId,
      evalId,
      trialId: trial.trialId,
      taskId: trial.taskId,
      benchmarkId: normalized.benchmark_id,
      benchmarkRevision: normalized.benchmark_revision,
    });
  }
  const harbor = await writeTaskRerunFakeHarbor(root, { taskA, taskB });
  const npm = await writeFakeNpm(root);
  const env = { ...process.env, HITCH_NPM_PATH: npm };
  const initial = await runEval({
    evalId,
    root,
    harborExecutable: harbor,
    env,
    request: { dataset, harness_ref: "pi@version:1.2.3", model: "openai/test-model", timeout_ms: 5_000, infrastructure_retries: 0 },
  });
  const initialTrials = initial.trials as Array<{ task_id: string; run_id: string; reward?: number; observation_status: string }>;
  assert.equal(initialTrials.find((trial) => trial.task_id === "task-a")?.observation_status, "valid");
  assert.equal(initialTrials.find((trial) => trial.task_id === "task-b")?.observation_status, "invalid");

  const rerun = await rerunEval({
    evalId,
    root,
    selector: { mode: "invalid" },
    harborExecutable: harbor,
    env,
  });
  assert.deepEqual(rerun.selected_tasks, ["task-b"]);
  assert.deepEqual(rerun.repaired_tasks, ["task-b"]);
  assert.deepEqual(rerun.remaining_invalid_tasks, []);
  assert.equal(rerun.eval_status, "succeeded");
  const result = await readJSON<Record<string, unknown>>(path.join(root, "evals", evalId, "result.json"));
  const trials = result.trials as Array<{ task_id: string; run_id: string; reward: number; observation_status: string }>;
  assert.equal(trials.find((trial) => trial.task_id === "task-a")?.run_id, taskA.runId);
  assert.equal(trials.find((trial) => trial.task_id === "task-a")?.reward, 0.25);
  assert.equal(trials.find((trial) => trial.task_id === "task-b")?.run_id, taskB.runId);
  assert.equal(trials.find((trial) => trial.task_id === "task-b")?.reward, 0.75);
  const rerunConfig = await readJSON<Record<string, unknown>>(path.join(root, "evals", evalId, "reruns", rerun.rerun_id, "harbor", "job.json"));
  assert.deepEqual(rerunConfig.datasets, [{ path: dataset, task_names: ["task-b"] }]);
});

test("multi-attempt rerun repairs only invalid logical slots", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-multi-rerun-"));
  t.after(() => forceRemove(root));
  const evalId = newEvalId();
  const dataset = path.join(root, "dataset");
  for (const taskId of ["task-a", "task-b"]) {
    await mkdir(path.join(dataset, taskId), { recursive: true });
    await writeFile(path.join(dataset, taskId, "task.toml"), "", "utf8");
  }
  const normalized = await validateEvalRequest(evalRequest({ dataset, attempts: 2 }));
  const trials = {
    a1: { trialId: "task-a__random-a1", taskId: "task-a", runId: "run_11111111111111111111111111111111", attempt: 1, bundle: path.join(root, "a1") },
    b1: { trialId: "task-b__random-b1", taskId: "task-b", runId: "run_22222222222222222222222222222222", attempt: 1, bundle: path.join(root, "b1") },
    a2Invalid: { trialId: "task-a__random-a2-invalid", taskId: "task-a", attempt: 2 },
    b2: { trialId: "task-b__random-b2", taskId: "task-b", runId: "run_33333333333333333333333333333333", attempt: 2, bundle: path.join(root, "b2") },
    a2Repair: { trialId: "task-a__random-a2-repair", taskId: "task-a", runId: "run_44444444444444444444444444444444", attempt: 2, bundle: path.join(root, "a2-repair") },
  };
  for (const trial of [trials.a1, trials.b1, trials.b2, trials.a2Repair]) {
    await writeExportedEvalRunBundle({
      ...trial,
      evalId,
      benchmarkId: normalized.benchmark_id,
      benchmarkRevision: normalized.benchmark_revision,
    });
  }
  const harbor = await writeMultiAttemptRerunFakeHarbor(root, trials);
  const npm = await writeFakeNpm(root);
  const env = { ...process.env, HITCH_NPM_PATH: npm };
  const initial = await runEval({
    evalId,
    root,
    harborExecutable: harbor,
    env,
    trialBundleGraceMs: 0,
    request: {
      dataset,
      harness_ref: "pi@version:1.2.3",
      model: "openai/test-model",
      attempts: 2,
      timeout_ms: 5_000,
      infrastructure_retries: 0,
    },
  });
  assert.equal(initial.status, "failed");
  const plan = await readJSON<{ attempt_execution: string }>(path.join(root, "evals", evalId, "plan.json"));
  assert.equal(plan.attempt_execution, "harbor-attempt-shards-v1");

  const rerun = await rerunEval({
    evalId,
    root,
    selector: { mode: "invalid" },
    harborExecutable: harbor,
    env,
    trialBundleGraceMs: 0,
  });
  assert.deepEqual(rerun.selected_tasks, ["task-a"]);
  assert.deepEqual(rerun.selected_trials, [{ task_id: "task-a", attempt: 2 }]);
  assert.deepEqual(rerun.repaired_trials, [{ task_id: "task-a", attempt: 2 }]);
  assert.deepEqual(rerun.remaining_invalid_trials, []);
  assert.equal(rerun.eval_status, "succeeded");

  const result = await readJSON<{ trials: Array<{ task_id: string; attempt: number; run_id: string }> }>(
    path.join(root, "evals", evalId, "result.json"),
  );
  const bySlot = new Map(result.trials.map((trial) => [`${trial.task_id}#${trial.attempt}`, trial.run_id]));
  assert.equal(bySlot.get("task-a#1"), trials.a1.runId);
  assert.equal(bySlot.get("task-b#1"), trials.b1.runId);
  assert.equal(bySlot.get("task-b#2"), trials.b2.runId);
  assert.equal(bySlot.get("task-a#2"), trials.a2Repair.runId);
  const rerunConfig = await readJSON<Record<string, unknown>>(
    path.join(root, "evals", evalId, "reruns", rerun.rerun_id, "harbor", "attempt-0002", "job.json"),
  );
  assert.equal(rerunConfig.n_attempts, 1);
  assert.equal(((rerunConfig.agents as Array<{ kwargs: Record<string, unknown> }>)[0]!.kwargs).logical_attempt, 2);
  assert.deepEqual(rerunConfig.datasets, [{ path: dataset, task_names: ["task-a"] }]);
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
  attempt?: number;
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
    parent: { kind: "eval", eval_id: options.evalId, trial_id: options.trialId, attempt: options.attempt ?? 1 },
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
  await atomicWriteJSON(path.join(options.bundle, "bundle.complete.json"), {
    schema_version: "1",
    run_id: options.runId,
    eval_id: options.evalId,
    trial_id: options.trialId,
    completed_at: now,
  });
}

async function writeIncrementalFakeHarbor(directory: string, options: {
  first: { bundle: string; trialId: string; taskId: string };
  second: { bundle: string; trialId: string; taskId: string };
}): Promise<string> {
  const executable = path.join(directory, "fake-harbor-incremental");
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
function publish(trial, reward) {
  const trialDirectory = path.join(output, trial.trialId);
  const agentDirectory = path.join(trialDirectory, "agent");
  fs.mkdirSync(agentDirectory, {recursive:true});
  fs.writeFileSync(path.join(trialDirectory, "lock.json"), JSON.stringify({task:{name:trial.taskId}}));
  fs.cpSync(trial.bundle, path.join(agentDirectory, "hitch-run-bundle"), {recursive:true});
  fs.writeFileSync(path.join(trialDirectory, "result.json"), JSON.stringify({
    task_name: trial.taskId,
    trial_name: trial.trialId,
    verifier_result: {rewards:{reward}}
  }));
}
const first = ${JSON.stringify(options.first)};
const second = ${JSON.stringify(options.second)};
publish(first, 1);
setTimeout(() => {
  publish(second, 0.5);
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({
    n_total_trials: 2,
    stats: {n_completed_trials:2,n_errored_trials:0,n_cancelled_trials:0}
  }));
  process.stdout.write("Results written\\n");
}, 1000);
`;
  await writeFile(executable, source, { mode: 0o755 });
  return executable;
}

async function writeVerifierRetryFakeHarbor(directory: string, trial: {
  bundle: string;
  trialId: string;
  taskId: string;
}): Promise<string> {
  const executable = path.join(directory, "fake-harbor-verifier-retry");
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
if (config.verifier?.import_path !== "hitch_harbor_verifier:HitchRetryingVerifier") process.exit(3);
if (config.verifier?.kwargs?.infrastructure_retries !== 1) process.exit(4);
if (config.verifier?.kwargs?.infrastructure_retry_backoff_ms !== 0) process.exit(5);
const output = path.join(config.jobs_dir, config.job_name);
const trial = ${JSON.stringify(trial)};
const countPath = ${JSON.stringify(path.join(directory, "fake-harbor-verifier-retry.count"))};
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0;
fs.writeFileSync(countPath, String(count + 1));
if (count !== 0) process.exit(6);
const trialDirectory = path.join(output, trial.trialId);
fs.mkdirSync(path.join(trialDirectory, "agent"), {recursive:true});
fs.mkdirSync(path.join(trialDirectory, "verifier"), {recursive:true});
fs.writeFileSync(path.join(trialDirectory, "lock.json"), JSON.stringify({task:{name:trial.taskId}}));
fs.cpSync(trial.bundle, path.join(trialDirectory, "agent", "hitch-run-bundle"), {recursive:true});
fs.writeFileSync(path.join(trialDirectory, "verifier", "reward.txt"), "1");
fs.writeFileSync(path.join(trialDirectory, "verifier", "test-stdout.txt"), "1 passed in 0.01s\\n");
fs.writeFileSync(path.join(trialDirectory, "verifier", "ctrf.json"), "{}\\n");
fs.writeFileSync(path.join(trialDirectory, "verifier", "infrastructure-retry-history.json"), JSON.stringify({
  schema_version: "1",
  code: "verifier_infrastructure_retry_history",
  status: "recovered",
  max_retries: 1,
  backoff_ms: 0,
  candidate_rerun: false,
  attempts: [{attempt:1,signals:["dns_resolution_failed","test_runner_missing"],source_files:["verifier/test-stdout.txt"]}]
}));
fs.writeFileSync(path.join(trialDirectory, "result.json"), JSON.stringify({
  task_name: trial.taskId,
  trial_name: trial.trialId,
  verifier_result: {rewards:{reward:1}}
}));
fs.mkdirSync(output, {recursive:true});
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({
  n_total_trials: 1,
  stats: {n_completed_trials:1,n_errored_trials:0,n_cancelled_trials:0}
}));
process.stdout.write("Results written\\n");
`;
  await writeFile(executable, source, { mode: 0o755 });
  return executable;
}

async function writeVerifierExhaustedFakeHarbor(directory: string, trial: {
  bundle: string;
  trialId: string;
  taskId: string;
}): Promise<string> {
  const executable = path.join(directory, "fake-harbor-verifier-exhausted");
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
if (config.verifier?.import_path !== "hitch_harbor_verifier:HitchRetryingVerifier") process.exit(3);
const countPath = ${JSON.stringify(path.join(directory, "fake-harbor-verifier-exhausted.count"))};
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0;
fs.writeFileSync(countPath, String(count + 1));
if (count !== 0) process.exit(4);
const trial = ${JSON.stringify(trial)};
const output = path.join(config.jobs_dir, config.job_name);
const trialDirectory = path.join(output, trial.trialId);
fs.mkdirSync(path.join(trialDirectory, "agent"), {recursive:true});
fs.mkdirSync(path.join(trialDirectory, "verifier"), {recursive:true});
fs.writeFileSync(path.join(trialDirectory, "lock.json"), JSON.stringify({task:{name:trial.taskId}}));
fs.cpSync(trial.bundle, path.join(trialDirectory, "agent", "hitch-run-bundle"), {recursive:true});
const attempts = [1, 2].map(attempt => ({
  attempt,
  signals: ["dns_resolution_failed", "test_runner_missing"],
  source_files: ["verifier/test-stdout.txt"]
}));
fs.writeFileSync(path.join(trialDirectory, "verifier", "infrastructure-error.json"), JSON.stringify({
  schema_version: "1",
  code: "verifier_infrastructure_failure",
  signals: ["dns_resolution_failed", "test_runner_missing"],
  source_files: ["verifier/test-stdout.txt"],
  attempts,
  max_retries: 1,
  backoff_ms: 0
}));
fs.writeFileSync(path.join(trialDirectory, "verifier", "infrastructure-retry-history.json"), JSON.stringify({
  schema_version: "1",
  code: "verifier_infrastructure_retry_history",
  status: "exhausted",
  candidate_rerun: false,
  attempts,
  max_retries: 1,
  backoff_ms: 0
}));
fs.writeFileSync(path.join(trialDirectory, "result.json"), JSON.stringify({
  task_name: trial.taskId,
  trial_name: trial.trialId,
  exception_info: "VerifierInfrastructureError: verifier infrastructure retries exhausted"
}));
fs.mkdirSync(output, {recursive:true});
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({
  n_total_trials: 1,
  stats: {n_completed_trials:0,n_errored_trials:1,n_cancelled_trials:0}
}));
process.stdout.write("Results written\\n");
`;
  await writeFile(executable, source, { mode: 0o755 });
  return executable;
}

async function writeMissingBundleFakeHarbor(directory: string): Promise<string> {
  const executable = path.join(directory, "fake-harbor-missing-bundle");
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
const trialDirectory = path.join(output, "task-timeout__1");
fs.mkdirSync(trialDirectory, {recursive:true});
fs.writeFileSync(path.join(trialDirectory, "lock.json"), JSON.stringify({task:{name:"task-timeout"}}));
fs.writeFileSync(path.join(trialDirectory, "result.json"), JSON.stringify({
  task_name: "task-timeout",
  trial_name: "task-timeout__1",
  exception_info: {exception_type:"AgentTimeoutError"},
  verifier_result: {rewards:{reward:0}}
}));
setTimeout(() => {
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({
    n_total_trials: 1,
    stats: {n_completed_trials:0,n_errored_trials:1,n_cancelled_trials:0}
  }));
  process.stdout.write("Results written\\n");
}, 1000);
`;
  await writeFile(executable, source, { mode: 0o755 });
  return executable;
}

async function writeTaskRerunFakeHarbor(directory: string, options: {
  taskA: { bundle: string; trialId: string; taskId: string };
  taskB: { bundle: string; trialId: string; taskId: string };
}): Promise<string> {
  const executable = path.join(directory, "fake-harbor-rerun");
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
const taskA = ${JSON.stringify(options.taskA)};
const taskB = ${JSON.stringify(options.taskB)};
const selected = config.datasets[0].task_names;
function publish(trial, reward, withBundle) {
  const trialDirectory = path.join(output, trial.trialId);
  fs.mkdirSync(path.join(trialDirectory, "agent"), {recursive:true});
  fs.writeFileSync(path.join(trialDirectory, "lock.json"), JSON.stringify({task:{name:trial.taskId}}));
  if (withBundle) fs.cpSync(trial.bundle, path.join(trialDirectory, "agent", "hitch-run-bundle"), {recursive:true});
  fs.writeFileSync(path.join(trialDirectory, "result.json"), JSON.stringify({
    task_name: trial.taskId,
    trial_name: trial.trialId,
    ...(withBundle ? {} : {exception_info:{exception_type:"InfraError"}}),
    verifier_result: {rewards:{reward}}
  }));
}
if (Array.isArray(selected)) {
  if (JSON.stringify(selected) !== JSON.stringify(["task-b"])) process.exit(4);
  publish(taskB, 0.75, true);
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({
    n_total_trials: 1,
    stats: {n_completed_trials:1,n_errored_trials:0,n_cancelled_trials:0}
  }));
} else {
  publish(taskA, 0.25, true);
  publish(taskB, 0, false);
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({
    n_total_trials: 2,
    stats: {n_completed_trials:1,n_errored_trials:1,n_cancelled_trials:0}
  }));
}
process.stdout.write("Results written\\n");
`;
  await writeFile(executable, source, { mode: 0o755 });
  return executable;
}

async function writeMultiAttemptRerunFakeHarbor(directory: string, options: {
  a1: { bundle: string; trialId: string; taskId: string };
  b1: { bundle: string; trialId: string; taskId: string };
  a2Invalid: { trialId: string; taskId: string };
  b2: { bundle: string; trialId: string; taskId: string };
  a2Repair: { bundle: string; trialId: string; taskId: string };
}): Promise<string> {
  const executable = path.join(directory, "fake-harbor-multi-rerun");
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
const logicalAttempt = config.agents[0].kwargs.logical_attempt;
const selected = config.datasets[0].task_names;
const fixtures = ${JSON.stringify(options)};
let trials;
if (Array.isArray(selected)) {
  if (logicalAttempt !== 2 || JSON.stringify(selected) !== JSON.stringify(["task-a"])) process.exit(4);
  trials = [fixtures.a2Repair];
} else if (logicalAttempt === 1) {
  trials = [fixtures.a1, fixtures.b1];
} else if (logicalAttempt === 2) {
  trials = [fixtures.a2Invalid, fixtures.b2];
} else {
  process.exit(5);
}
for (const trial of trials) {
  const trialDirectory = path.join(output, trial.trialId);
  fs.mkdirSync(path.join(trialDirectory, "agent"), {recursive:true});
  fs.writeFileSync(path.join(trialDirectory, "lock.json"), JSON.stringify({task:{name:trial.taskId}}));
  if (trial.bundle) fs.cpSync(trial.bundle, path.join(trialDirectory, "agent", "hitch-run-bundle"), {recursive:true});
  fs.writeFileSync(path.join(trialDirectory, "result.json"), JSON.stringify({
    task_name: trial.taskId,
    trial_name: trial.trialId,
    ...(trial.bundle ? {} : {exception_info:{exception_type:"InfraError"}}),
    verifier_result: {rewards:{reward:trial.bundle ? 1 : 0}}
  }));
}
fs.mkdirSync(output, {recursive:true});
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({
  n_total_trials: trials.length,
  stats: {
    n_completed_trials: trials.filter((trial) => trial.bundle).length,
    n_errored_trials: trials.filter((trial) => !trial.bundle).length,
    n_cancelled_trials: 0
  }
}));
process.stdout.write("Results written\\n");
`;
  await writeFile(executable, source, { mode: 0o755 });
  return executable;
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
