import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFakeDocker, writeFakeHarbor, writeFakeNpm, writeFakePython, forceRemove } from "../test-support/helpers.js";
import { packageVersion } from "../src/foundation/index.js";
import { parseDaemonResourcePolicy } from "../src/cli/commands/daemon.js";
import { buildDaemonEvalSubmission, parseEvalExecutionOptions } from "../src/cli/commands/eval.js";

const executable = fileURLToPath(new URL("../bin/hitch.js", import.meta.url));

test("CLI help is available without daemon or agent setup", () => {
  const result = spawnSync(process.execPath, [executable, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Hitch — content-addressed version control/);
});

test("CLI version matches the package version", () => {
  const version = packageVersion();
  const result = spawnSync(process.execPath, [executable, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `hitch ${version}\n`);
});

test("CLI advertises bounded trajectory capabilities", () => {
  const result = spawnSync(process.execPath, [executable, "capabilities", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || undefined);
  assert.deepEqual(JSON.parse(result.stdout), {
    schema_version: "1",
    trajectory_analysis: "1",
    trajectory_events_page: "1",
    verifier_evidence: "1",
  });
});

test("CLI preserves typed exit code for invalid commands", () => {
  const result = spawnSync(process.execPath, [executable, "not-a-command"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command/);
});

test("daemon resource policy follows CLI, environment, Docker detection, and conservative fallback order", async () => {
  const detectedArgs: string[] = [];
  const detected = await parseDaemonResourcePolicy(detectedArgs, 8, {
    env: {},
    detect: async () => ({ cpu_millis: 9_000, memory_bytes: 7 * 1024 ** 3 }),
  });
  assert.deepEqual(detected.capacity, {
    cpu_millis: 9_000,
    memory_bytes: 7 * 1024 ** 3,
    container_slots: 7,
    build_slots: 1,
  });
  assert.deepEqual(detectedArgs, []);

  let detectionCalls = 0;
  const explicitArgs = ["--capacity-cpu-millis", "6000", "--container-slots", "3"];
  const explicit = await parseDaemonResourcePolicy(explicitArgs, 8, {
    env: {
      HITCH_CAPACITY_CPU_MILLIS: "5000",
      HITCH_CAPACITY_MEMORY_MIB: "8192",
      HITCH_CONTAINER_SLOTS: "5",
      HITCH_BUILD_SLOTS: "2",
      HITCH_EVAL_CPU_MILLIS: "2000",
      HITCH_EVAL_MEMORY_MIB: "2048",
    },
    detect: async () => { detectionCalls += 1; return {}; },
  });
  assert.equal(detectionCalls, 0);
  assert.deepEqual(explicit.capacity, {
    cpu_millis: 6_000,
    memory_bytes: 8 * 1024 ** 3,
    container_slots: 3,
    build_slots: 2,
  });
  assert.equal(explicit.eval_trial.cpu_millis, 2_000);
  assert.equal(explicit.eval_trial.memory_bytes, 2 * 1024 ** 3);
  assert.deepEqual(explicitArgs, []);

  const conservative = await parseDaemonResourcePolicy([], 8, { env: {}, detect: async () => ({}) });
  assert.deepEqual(conservative.capacity, {
    cpu_millis: 1_000,
    memory_bytes: 1024 ** 3,
    container_slots: 1,
    build_slots: 1,
  });
});

test("CLI eval execution policy flags produce a complete daemon submission", () => {
  const args = [
    "--provider", "remote-docker",
    "--cpu-per-trial", "2",
    "--memory-per-trial", "4GiB",
    "--build-mode", "backend",
    "--model-capture", "hybrid",
    "--require-model-capture",
  ];
  const options = parseEvalExecutionOptions(args);
  assert.deepEqual(args, []);
  assert.deepEqual(options, {
    explicit: true,
    provider: "remote-docker",
    cpu_millis: 2_000,
    memory_bytes: 4 * 1024 ** 3,
    build_mode: "backend",
    model_capture: "hybrid",
    require_model_capture: true,
  });
  const request = { dataset: "demo@1.0", harness_ref: "pi@version:1.2.3", max_concurrent: 8 };
  const submission = buildDaemonEvalSubmission(request, options, {
    cpu_millis: 1_000,
    memory_bytes: 1024 ** 3,
    container_slots: 1,
    build_slots: 0,
    gpu_count: 1,
    ephemeral_disk_bytes: 8 * 1024 ** 3,
  });
  assert.deepEqual(submission, {
    schema_version: "1",
    request,
    execution: {
      provider: "remote-docker",
      max_parallelism: 8,
      resources: { default_trial: {
        cpu_millis: 2_000,
        memory_bytes: 4 * 1024 ** 3,
        container_slots: 1,
        build_slots: 0,
        gpu_count: 1,
        ephemeral_disk_bytes: 8 * 1024 ** 3,
      } },
      build: { mode: "backend" },
      model_capture: { mode: "hybrid", required: true },
    },
  });
  assert.throws(() => parseEvalExecutionOptions(["--memory-per-trial", "1000MB"]), /B, KiB, MiB, or GiB/);
  assert.throws(() => parseEvalExecutionOptions(["--model-capture", "off", "--require-model-capture"]), /cannot be combined/);
});

test("CLI refuses to run a control-plane eval rerun without its daemon", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-cli-control-plane-rerun-"));
  t.after(() => forceRemove(root));
  const evalId = `eval_${"8".repeat(32)}`;
  await mkdir(path.join(root, "evals", evalId), { recursive: true });
  await writeFile(path.join(root, "evals", evalId, "submission.json"), "{}\n");
  const result = spawnSync(process.execPath, [
    executable, "--root", root, "eval", "rerun", evalId, "--invalid",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /control-plane eval reruns require a running daemon/);
});

test("CLI environment image GC is a dry run unless --apply is explicit", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-cli-image-gc-"));
  t.after(() => forceRemove(root));
  const result = spawnSync(process.execPath, [executable, "--root", root, "images", "gc", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || undefined);
  const report = JSON.parse(result.stdout) as { dry_run: boolean; scanned: number; removed: unknown[] };
  assert.equal(report.dry_run, true);
  assert.equal(report.scanned, 0);
  assert.deepEqual(report.removed, []);
});

test("CLI exposes harness revision commands and rejects mixed legacy selection", () => {
  const help = spawnSync(process.execPath, [executable, "--help"], { encoding: "utf8" });
  assert.match(help.stdout, /hitch resolve <harness-ref>/);
  assert.match(help.stdout, /--harness <ref>/);
  assert.match(help.stdout, /--workspace-mode <mode>/);
  assert.match(help.stdout, /hitch workspace inspect <run-id>/);
  assert.match(help.stdout, /hitch images gc/);
  assert.match(help.stdout, /hitch images pin/);
  assert.match(help.stdout, /hitch runs candidate <run-id>/);
  assert.match(help.stdout, /hitch verifier inspect <run-id>/);
  assert.match(help.stdout, /hitch eval run \[--backend harbor\] --dataset <ref>/);
  assert.match(help.stdout, /hitch eval submit \[--backend harbor\]/);
  assert.match(help.stdout, /--cpu-per-trial <integer-cpus>/);
  assert.match(help.stdout, /--memory-per-trial <size>/);
  assert.match(help.stdout, /--model-capture off\|native\|proxy\|hybrid/);
  assert.match(help.stdout, /hitch eval watch <eval-id>/);
  assert.match(help.stdout, /hitch eval cancel <eval-id>/);
  assert.match(help.stdout, /hitch eval rerun <eval-id> \(--invalid \| --task <name>/);
  assert.match(help.stdout, /--type <type>/);
  assert.match(help.stdout, /hitch eval setup harbor/);
  assert.match(help.stdout, /hitch eval doctor/);
  assert.match(help.stdout, /--capacity-cpu-millis <n>/);
  assert.match(help.stdout, /--capacity-memory-mib <n>/);
  assert.match(help.stdout, /--container-slots <n>/);
  assert.match(help.stdout, /--build-slots <n>/);
  assert.match(help.stdout, /--capacity-gpus <n>/);
  assert.match(help.stdout, /--eval-gpus <n>/);
  assert.match(help.stdout, /--capacity-ephemeral-disk-mib <n>/);
  assert.match(help.stdout, /--eval-ephemeral-disk-mib <n>/);
  assert.match(help.stdout, /--eval-memory-mib <n>/);
  assert.match(help.stdout, /hitch worker register --server <url>/);
  assert.match(help.stdout, /hitch worker run --server <url>/);
  assert.match(help.stdout, /hitch trajectory project <run-id>/);
  assert.match(help.stdout, /--profile analysis/);
  assert.doesNotMatch(help.stdout, /analysis-v1/);
  assert.match(help.stdout, /hitch trajectory events <run-id>/);
  assert.match(help.stdout, /hitch capabilities \[--json\]/);

  const result = spawnSync(process.execPath, [
    executable,
    "run",
    "--harness", "codex@installed",
    "--agent", "codex",
    "--prompt", "hello",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /use only one of --harness and the legacy --agent/);

  const invalidWorkspaceMode = spawnSync(process.execPath, [
    executable,
    "run",
    "--harness", "codex@installed",
    "--workspace-mode", "mystery",
    "--prompt", "hello",
  ], { encoding: "utf8" });
  assert.equal(invalidWorkspaceMode.status, 2);
  assert.match(invalidWorkspaceMode.stderr, /workspace-mode must be one of/);

  const mutableEval = spawnSync(process.execPath, [
    executable,
    "eval", "run",
    "--backend", "harbor",
    "--dataset", "demo",
    "--harness", "codex@installed",
  ], { encoding: "utf8" });
  assert.equal(mutableEval.status, 2);
  assert.match(mutableEval.stderr, /eval requires an immutable harness ref/);

  const mixedRerunSelector = spawnSync(process.execPath, [
    executable,
    "eval", "rerun", "eval_77777777777777777777777777777777",
    "--invalid", "--task", "task-a",
  ], { encoding: "utf8" });
  assert.equal(mixedRerunSelector.status, 2);
  assert.match(mixedRerunSelector.stderr, /exactly one of --invalid or --task/);

  const unknownRerunType = spawnSync(process.execPath, [
    executable,
    "eval", "rerun", "eval_77777777777777777777777777777777",
    "--invalid", "--type", "resume",
  ], { encoding: "utf8" });
  assert.equal(unknownRerunType.status, 2);
  assert.match(unknownRerunType.stderr, /eval rerun --type must be one of/);

  const unavailableReplay = spawnSync(process.execPath, [
    executable,
    "eval", "rerun", "eval_77777777777777777777777777777777",
    "--invalid", "--type", "trajectory-replay",
  ], { encoding: "utf8" });
  assert.equal(unavailableReplay.status, 2);
  assert.match(unavailableReplay.stderr, /trajectory evidence alone cannot restore tool or process state/);

  const invalidDaemonPolicy = spawnSync(process.execPath, [
    executable,
    "--root", path.join(tmpdir(), `hitch-invalid-daemon-policy-${process.pid}`),
    "daemon", "start",
    "--build-slots", "-1",
  ], { encoding: "utf8" });
  assert.equal(invalidDaemonPolicy.status, 2);
  assert.match(invalidDaemonPolicy.stderr, /--build-slots must be a non-negative integer/);

  const invalidGpuPolicy = spawnSync(process.execPath, [
    executable,
    "--root", path.join(tmpdir(), `hitch-invalid-gpu-policy-${process.pid}`),
    "daemon", "start",
    "--capacity-gpus", "1",
    "--eval-gpus", "2",
  ], { encoding: "utf8" });
  assert.equal(invalidGpuPolicy.status, 2);
  assert.match(invalidGpuPolicy.stderr, /--eval-gpus cannot exceed --capacity-gpus/);

  const invalidDiskPolicy = spawnSync(process.execPath, [
    executable,
    "--root", path.join(tmpdir(), `hitch-invalid-disk-policy-${process.pid}`),
    "daemon", "start",
    "--capacity-ephemeral-disk-mib", "1024",
    "--eval-ephemeral-disk-mib", "2048",
  ], { encoding: "utf8" });
  assert.equal(invalidDiskPolicy.status, 2);
  assert.match(invalidDiskPolicy.stderr, /--eval-ephemeral-disk-mib cannot exceed --capacity-ephemeral-disk-mib/);

  const invalidDaemonPort = spawnSync(process.execPath, [
    executable,
    "--root", path.join(tmpdir(), `hitch-invalid-daemon-port-${process.pid}`),
    "daemon", "start",
    "--port", "65536",
  ], { encoding: "utf8" });
  assert.equal(invalidDaemonPort.status, 2);
  assert.match(invalidDaemonPort.stderr, /--port must be between 0 and 65535/);
});

test("CLI sets up and diagnoses a managed Harbor backend", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-cli-eval-setup-"));
  t.after(() => forceRemove(root));
  const python = await writeFakePython(root);
  const docker = await writeFakeDocker(root);
  const setup = spawnSync(process.execPath, [
    executable,
    "--root", root,
    "eval", "setup", "harbor",
    "--python", python,
    "--json",
  ], { encoding: "utf8" });
  assert.equal(setup.status, 0, setup.stderr || undefined);
  assert.equal((JSON.parse(setup.stdout) as { version: string }).version, "0.21.0");

  const doctor = spawnSync(process.execPath, [
    executable,
    "--root", root,
    "eval", "doctor",
    "--python", python,
    "--docker", docker,
    "--json",
  ], { encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "test-only" } });
  assert.equal(doctor.status, 0, doctor.stderr || undefined);
  assert.equal((JSON.parse(doctor.stdout) as { status: string }).status, "ready");
});

test("CLI inspects, resolves, and removes retained workspaces", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-cli-workspace-"));
  t.after(() => forceRemove(root));
  const runId = "run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const managedDirectory = path.join(root, "workspaces", runId);
  const executionRoot = path.join(managedDirectory, "root");
  const runDirectory = path.join(root, "runs", runId);
  await mkdir(executionRoot, { recursive: true });
  await mkdir(runDirectory, { recursive: true });
  await writeFile(path.join(runDirectory, "workspace.json"), `${JSON.stringify({
    schema_version: "1",
    run_id: runId,
    state_root: root,
    mode: "copy",
    status: "retained",
    source_workspace: "/source/project",
    execution_workspace: executionRoot,
    execution_root: executionRoot,
    managed_directory: managedDirectory,
    retained: true,
    changed: false,
  })}\n`);

  const inspect = spawnSync(process.execPath, [executable, "--root", root, "workspace", "inspect", runId, "--json"], { encoding: "utf8" });
  assert.equal(inspect.status, 0);
  assert.equal((JSON.parse(inspect.stdout) as { execution_workspace: string }).execution_workspace, executionRoot);
  const workspacePath = spawnSync(process.execPath, [executable, "--root", root, "workspace", "path", runId], { encoding: "utf8" });
  assert.equal(workspacePath.status, 0);
  assert.equal(workspacePath.stdout.trim(), executionRoot);
  const remove = spawnSync(process.execPath, [executable, "--root", root, "workspace", "remove", runId], { encoding: "utf8" });
  assert.equal(remove.status, 0);
  assert.match(remove.stdout, /Removed workspace/);
});

test("CLI runs, lists, and inspects Harbor evals", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-cli-eval-"));
  t.after(() => forceRemove(root));
  const harbor = await writeFakeHarbor(root);
  const npm = await writeFakeNpm(root);
  const env = { ...process.env, NODE_ENV: "test", HITCH_TEST_HOST_ARTIFACT_BUILDER: "1", HITCH_NPM_PATH: npm };
  const evalId = "eval_77777777777777777777777777777777";
  const run = spawnSync(process.execPath, [
    executable,
    "--root", root,
    "eval", "run",
    "--eval-id", evalId,
    "--dataset", "demo@1.0",
    "--harness", "pi@version:1.2.3",
    "--model", "openai/test-model",
    "--harbor", harbor,
    "--output", "json",
  ], { encoding: "utf8", env });
  assert.equal(run.status, 13, run.stderr || "eval run should report invalid evidence");
  const result = JSON.parse(run.stdout) as { status: string; eval_id: string };
  assert.equal(result.status, "failed");
  assert.equal(result.eval_id, evalId);

  const list = spawnSync(process.execPath, [executable, "--root", root, "eval", "list", "--json"], { encoding: "utf8" });
  assert.equal(list.status, 0, list.stderr || undefined);
  const listed = JSON.parse(list.stdout) as { evals: Array<{ eval_id: string }> };
  assert.equal(listed.evals[0]?.eval_id, result.eval_id);

  const inspect = spawnSync(process.execPath, [executable, "--root", root, "eval", "inspect", result.eval_id, "--json"], { encoding: "utf8" });
  assert.equal(inspect.status, 0, inspect.stderr || undefined);
  const inspected = JSON.parse(inspect.stdout) as { result: { summary: { primary_reward: number | null }; backend_summary: { primary_reward: number } }; runtime_storage: string };
  assert.equal(inspected.result.summary.primary_reward, null);
  assert.equal(inspected.result.backend_summary.primary_reward, 0.75);
  assert.equal(inspected.runtime_storage, "controller-runtime-ref-v1");
});
