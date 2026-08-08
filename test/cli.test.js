import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const executable = fileURLToPath(new URL("../bin/hitch.js", import.meta.url));

test("CLI help is available without daemon or agent setup", () => {
  const result = spawnSync(process.execPath, [executable, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Hitch — one local runtime/);
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
});

test("CLI inspects, resolves, and removes retained workspaces", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-cli-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  assert.equal(JSON.parse(inspect.stdout).execution_workspace, executionRoot);
  const workspacePath = spawnSync(process.execPath, [executable, "--root", root, "workspace", "path", runId], { encoding: "utf8" });
  assert.equal(workspacePath.status, 0);
  assert.equal(workspacePath.stdout.trim(), executionRoot);
  const remove = spawnSync(process.execPath, [executable, "--root", root, "workspace", "remove", runId], { encoding: "utf8" });
  assert.equal(remove.status, 0);
  assert.match(remove.stdout, /Removed workspace/);
});
