import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeRun } from "../src/engine.js";
import { readJSON } from "../src/fs.js";
import {
  finalizeWorkspace,
  planWorkspace,
  prepareWorkspace,
  removeWorkspace,
  workspaceRecordPath,
} from "../src/workspaces.js";

const executeFile = promisify(execFile);

test("worktree isolation maps subdirectories and retains changes outside the source checkout", async (t) => {
  const { source, state } = await gitFixture(t);
  const subdirectory = path.join(source, "packages", "api");
  await mkdir(subdirectory, { recursive: true });
  await writeFile(path.join(subdirectory, "input.txt"), "committed\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "initial");

  const runId = "run_11111111111111111111111111111111";
  const recordPath = workspaceRecordPath(state, runId);
  await mkdir(path.dirname(recordPath), { recursive: true });
  const plan = await planWorkspace({
    runId,
    sourceCwd: subdirectory,
    mode: "worktree",
    root: state,
    recordPath,
  });
  assert.equal(plan.source_subdirectory, path.join("packages", "api"));

  const ready = await prepareWorkspace(plan, { recordPath });
  assert.notEqual(ready.execution_workspace, subdirectory);
  assert.equal(await readFile(path.join(ready.execution_workspace, "input.txt"), "utf8"), "committed\n");
  await writeFile(path.join(ready.execution_workspace, "agent-output.txt"), "isolated\n");

  const retained = await finalizeWorkspace(ready, { recordPath });
  assert.equal(retained.status, "retained");
  assert.equal(retained.changed, true);
  await assert.rejects(stat(path.join(subdirectory, "agent-output.txt")), { code: "ENOENT" });
  await assert.rejects(removeWorkspace({ root: state, runId }), (error) => error.code === "workspace_has_changes");
  await rm(plan.execution_root, { recursive: true, force: true });
  await removeWorkspace({ root: state, runId, force: true });
  await assert.rejects(stat(plan.managed_directory), { code: "ENOENT" });
  assert.doesNotMatch(await git(source, "worktree", "list", "--porcelain"), new RegExp(runId));
});

test("worktree isolation rejects dirty and non-Git workspaces", async (t) => {
  const { source, state } = await gitFixture(t);
  await writeFile(path.join(source, "tracked.txt"), "base\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "initial");
  await writeFile(path.join(source, "tracked.txt"), "dirty\n");

  await assert.rejects(
    planWorkspace({
      runId: "run_22222222222222222222222222222222",
      sourceCwd: source,
      mode: "worktree",
      root: state,
    }),
    (error) => error.code === "workspace_dirty" && error.exitCode === 2,
  );

  const plain = await mkdtemp(path.join(tmpdir(), "hitch-plain-workspace-"));
  t.after(() => rm(plain, { recursive: true, force: true }));
  await assert.rejects(
    planWorkspace({
      runId: "run_33333333333333333333333333333333",
      sourceCwd: plain,
      mode: "worktree",
      root: state,
    }),
    (error) => error.code === "workspace_not_git" && error.exitCode === 2,
  );
});

test("concurrent worktree leases use distinct working directories", async (t) => {
  const { source, state } = await gitFixture(t);
  await writeFile(path.join(source, "tracked.txt"), "base\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "initial");
  const runIds = [
    "run_77777777777777777777777777777777",
    "run_88888888888888888888888888888888",
  ];
  for (const runId of runIds) await mkdir(path.dirname(workspaceRecordPath(state, runId)), { recursive: true });
  const plans = await Promise.all(runIds.map((runId) => planWorkspace({
    runId,
    sourceCwd: source,
    mode: "worktree",
    root: state,
    recordPath: workspaceRecordPath(state, runId),
  })));
  const leases = await Promise.all(plans.map((plan, index) => prepareWorkspace(plan, {
    recordPath: workspaceRecordPath(state, runIds[index]),
  })));

  assert.notEqual(leases[0].execution_root, leases[1].execution_root);
  await Promise.all(leases.map((lease, index) => writeFile(path.join(lease.execution_root, "agent-output.txt"), String(index))));
  assert.equal(await readFile(path.join(leases[0].execution_root, "agent-output.txt"), "utf8"), "0");
  assert.equal(await readFile(path.join(leases[1].execution_root, "agent-output.txt"), "utf8"), "1");
  await assert.rejects(stat(path.join(source, "agent-output.txt")), { code: "ENOENT" });
  await Promise.all(leases.map(async (lease, index) => {
    await finalizeWorkspace(lease, { recordPath: workspaceRecordPath(state, runIds[index]) });
    await removeWorkspace({ root: state, runId: runIds[index], force: true });
  }));
});

test("copy isolation preserves dirty and ignored files with independent Git metadata", async (t) => {
  const { source, state } = await gitFixture(t);
  await writeFile(path.join(source, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(source, "tracked.txt"), "base\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "initial");
  await writeFile(path.join(source, "tracked.txt"), "dirty\n");
  await writeFile(path.join(source, "untracked.txt"), "untracked\n");
  await writeFile(path.join(source, "ignored.txt"), "ignored\n");

  const runId = "run_44444444444444444444444444444444";
  const recordPath = workspaceRecordPath(state, runId);
  await mkdir(path.dirname(recordPath), { recursive: true });
  const plan = await planWorkspace({ runId, sourceCwd: source, mode: "copy", root: state, recordPath });
  const ready = await prepareWorkspace(plan, { recordPath });

  assert.equal(await readFile(path.join(ready.execution_root, "tracked.txt"), "utf8"), "dirty\n");
  assert.equal(await readFile(path.join(ready.execution_root, "untracked.txt"), "utf8"), "untracked\n");
  assert.equal(await readFile(path.join(ready.execution_root, "ignored.txt"), "utf8"), "ignored\n");
  assert.equal((await lstat(path.join(ready.execution_root, ".git"))).isDirectory(), true);
  const copiedCommonDir = (await git(ready.execution_root, "rev-parse", "--path-format=absolute", "--git-common-dir")).trim();
  assert.equal(path.resolve(ready.execution_root, copiedCommonDir).startsWith(ready.execution_root), true);

  await writeFile(path.join(ready.execution_root, "agent-output.txt"), "isolated\n");
  const retained = await finalizeWorkspace(ready, { recordPath });
  assert.equal(retained.changed, true);
  await assert.rejects(stat(path.join(source, "agent-output.txt")), { code: "ENOENT" });
  await removeWorkspace({ root: state, runId, force: true });
});

test("an unchanged non-Git copy can be removed without force", async (t) => {
  const source = await mkdtemp(path.join(tmpdir(), "hitch-copy-source-"));
  const state = await mkdtemp(path.join(tmpdir(), "hitch-copy-state-"));
  t.after(() => Promise.all([
    rm(source, { recursive: true, force: true }),
    rm(state, { recursive: true, force: true }),
  ]));
  await writeFile(path.join(source, "input.txt"), "plain\n");
  const runId = "run_99999999999999999999999999999999";
  const recordPath = workspaceRecordPath(state, runId);
  await mkdir(path.dirname(recordPath), { recursive: true });
  const plan = await planWorkspace({ runId, sourceCwd: source, mode: "copy", root: state, recordPath });
  const ready = await prepareWorkspace(plan, { recordPath });
  const retained = await finalizeWorkspace(ready, { recordPath });
  assert.equal(retained.changed, false);
  await removeWorkspace({ root: state, runId });
  assert.equal((await readJSON(recordPath)).status, "removed");
});

test("copy isolation supports an unborn Git repository", async (t) => {
  const { source, state } = await gitFixture(t);
  await writeFile(path.join(source, "first.txt"), "uncommitted\n");
  const runId = "run_cccccccccccccccccccccccccccccccc";
  const recordPath = workspaceRecordPath(state, runId);
  await mkdir(path.dirname(recordPath), { recursive: true });
  const plan = await planWorkspace({ runId, sourceCwd: source, mode: "copy", root: state, recordPath });
  assert.equal(plan.git.head, null);
  const ready = await prepareWorkspace(plan, { recordPath });
  assert.equal((await lstat(path.join(ready.execution_root, ".git"))).isDirectory(), true);
  assert.equal(await readFile(path.join(ready.execution_root, "first.txt"), "utf8"), "uncommitted\n");
  const retained = await finalizeWorkspace(ready, { recordPath });
  assert.equal(retained.changed, false);
  await removeWorkspace({ root: state, runId });
});

test("copy isolation rejects linked nested Git metadata", async (t) => {
  const source = await mkdtemp(path.join(tmpdir(), "hitch-copy-linked-source-"));
  const state = await mkdtemp(path.join(tmpdir(), "hitch-copy-linked-state-"));
  t.after(() => Promise.all([
    rm(source, { recursive: true, force: true }),
    rm(state, { recursive: true, force: true }),
  ]));
  await mkdir(path.join(source, "nested"), { recursive: true });
  await writeFile(path.join(source, "nested", ".git"), "gitdir: /outside/repository\n");
  const runId = "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const recordPath = workspaceRecordPath(state, runId);
  await mkdir(path.dirname(recordPath), { recursive: true });
  const plan = await planWorkspace({ runId, sourceCwd: source, mode: "copy", root: state, recordPath });
  await assert.rejects(
    prepareWorkspace(plan, { recordPath }),
    (error) => error.code === "workspace_nested_git_unsupported" && error.exitCode === 10,
  );
  assert.equal((await readJSON(recordPath)).retained, false);
});

test("workspace provisioning never overwrites a pre-existing managed directory", async (t) => {
  const source = await mkdtemp(path.join(tmpdir(), "hitch-copy-existing-source-"));
  const state = await mkdtemp(path.join(tmpdir(), "hitch-copy-existing-state-"));
  t.after(() => Promise.all([
    rm(source, { recursive: true, force: true }),
    rm(state, { recursive: true, force: true }),
  ]));
  const runId = "run_dddddddddddddddddddddddddddddddd";
  const recordPath = workspaceRecordPath(state, runId);
  await mkdir(path.dirname(recordPath), { recursive: true });
  const plan = await planWorkspace({ runId, sourceCwd: source, mode: "copy", root: state, recordPath });
  await mkdir(plan.managed_directory, { recursive: true });
  const sentinel = path.join(plan.managed_directory, "sentinel.txt");
  await writeFile(sentinel, "keep\n");

  await assert.rejects(
    prepareWorkspace(plan, { recordPath }),
    (error) => error.code === "workspace_already_exists" && error.exitCode === 11,
  );
  assert.equal(await readFile(sentinel, "utf8"), "keep\n");
});

test("workspace provisioning honors cancellation without leaving managed files", async (t) => {
  const source = await mkdtemp(path.join(tmpdir(), "hitch-copy-cancel-source-"));
  const state = await mkdtemp(path.join(tmpdir(), "hitch-copy-cancel-state-"));
  t.after(() => Promise.all([
    rm(source, { recursive: true, force: true }),
    rm(state, { recursive: true, force: true }),
  ]));
  const runId = "run_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const recordPath = workspaceRecordPath(state, runId);
  await mkdir(path.dirname(recordPath), { recursive: true });
  const plan = await planWorkspace({ runId, sourceCwd: source, mode: "copy", root: state, recordPath });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    prepareWorkspace(plan, { recordPath, signal: controller.signal }),
    (error) => error.code === "cancelled" && error.exitCode === 9,
  );
  assert.equal((await readJSON(recordPath)).status, "cancelled");
  await assert.rejects(stat(plan.managed_directory), { code: "ENOENT" });
});

test("managed modes reject a Hitch state root inside the source tree", async (t) => {
  const { source } = await gitFixture(t);
  await writeFile(path.join(source, "tracked.txt"), "base\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "initial");

  await assert.rejects(
    planWorkspace({
      runId: "run_55555555555555555555555555555555",
      sourceCwd: source,
      mode: "worktree",
      root: path.join(source, ".hitch"),
    }),
    (error) => error.code === "workspace_root_overlap" && error.exitCode === 2,
  );
});

test("run engine launches the harness in the isolated execution workspace", async (t) => {
  const { source, state } = await gitFixture(t);
  await writeFile(path.join(source, "tracked.txt"), "base\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "initial");
  const executable = await writeMutatingCodex(state);
  const previous = process.env.HITCH_CODEX_PATH;
  process.env.HITCH_CODEX_PATH = executable;
  t.after(() => {
    if (previous === undefined) delete process.env.HITCH_CODEX_PATH;
    else process.env.HITCH_CODEX_PATH = previous;
  });

  const runId = "run_66666666666666666666666666666666";
  const events = [];
  const result = await executeRun({
    runId,
    request: {
      harness_ref: "codex@installed",
      cwd: source,
      workspace_mode: "worktree",
      prompt: "hello",
      timeout_ms: 5_000,
    },
    runsRoot: path.join(state, "runs"),
    root: state,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.workspace.mode, "worktree");
  assert.equal(result.workspace.retained, true);
  assert.equal(await readFile(path.join(result.workspace.execution, "agent-output.txt"), "utf8"), "hello");
  await assert.rejects(stat(path.join(source, "agent-output.txt")), { code: "ENOENT" });
  const manifest = await readJSON(path.join(state, "runs", runId, "manifest.json"));
  assert.equal(manifest.workspace, source);
  assert.equal(manifest.workspace_mode, "worktree");
  assert.equal(manifest.execution_workspace, result.workspace.execution);
  assert.equal(manifest.workspace_changed, true);
  assert.ok(events.some((event) => event.type === "workspace.ready" && event.workspace === result.workspace.execution));
  await removeWorkspace({ root: state, runId, force: true });
});

async function gitFixture(t) {
  const source = await mkdtemp(path.join(tmpdir(), "hitch-workspace-source-"));
  const state = await mkdtemp(path.join(tmpdir(), "hitch-workspace-state-"));
  t.after(() => Promise.all([
    rm(source, { recursive: true, force: true }),
    rm(state, { recursive: true, force: true }),
  ]));
  await git(source, "init", "--quiet");
  await git(source, "config", "user.name", "Hitch Test");
  await git(source, "config", "user.email", "hitch@example.test");
  return { source, state };
}

async function git(cwd, ...args) {
  return (await executeFile("git", args, { cwd, encoding: "utf8" })).stdout;
}

async function writeMutatingCodex(directory) {
  const file = path.join(directory, "mutating-codex");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 9.9.9\\n");
  process.exit(0);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync("agent-output.txt", prompt);
  process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"thread_fake"}) + "\\n");
  process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"item_1",type:"agent_message",text:"reply:" + prompt}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}}) + "\\n");
});
`;
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}
