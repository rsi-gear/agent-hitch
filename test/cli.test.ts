import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFakeDocker, writeFakeHarbor, writeFakeNpm, writeFakePython, forceRemove } from "../test-support/helpers.js";
import { packageVersion } from "../src/foundation/index.js";

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

test("CLI preserves typed exit code for invalid commands", () => {
  const result = spawnSync(process.execPath, [executable, "not-a-command"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command/);
});

test("CLI exposes harness revision commands and rejects mixed legacy selection", () => {
  const help = spawnSync(process.execPath, [executable, "--help"], { encoding: "utf8" });
  assert.match(help.stdout, /hitch resolve <harness-ref>/);
  assert.match(help.stdout, /--harness <ref>/);
  assert.match(help.stdout, /--workspace-mode <mode>/);
  assert.match(help.stdout, /hitch workspace inspect <run-id>/);
  assert.match(help.stdout, /hitch eval run \[--backend harbor\] --dataset <ref>/);
  assert.match(help.stdout, /hitch eval setup harbor/);
  assert.match(help.stdout, /hitch eval doctor/);

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
  const env = { ...process.env, HITCH_NPM_PATH: npm };
  const run = spawnSync(process.execPath, [
    executable,
    "--root", root,
    "eval", "run",
    "--dataset", "demo@1.0",
    "--harness", "pi@version:1.2.3",
    "--model", "openai/test-model",
    "--harbor", harbor,
    "--output", "json",
  ], { encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr || undefined);
  const result = JSON.parse(run.stdout) as { status: string; eval_id: string };
  assert.equal(result.status, "succeeded");

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
