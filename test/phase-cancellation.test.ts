import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { copySealedPhaseRunBundle, executeRun, loadRunRecord, monitorPhaseCancellation, newRunId, verifyResultBundleIndex } from "../src/runs/index.js";
import { forceRemove } from "../test-support/helpers.js";

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const digest = `sha256:${"a".repeat(64)}` as const;
const context = { kind: "benchmark_phase", benchmark_id: "synthetic-cancellation", benchmark_revision: digest,
  task_id: "phase-stop", task_digest: digest, verifier_identity: digest, run_group_id: `run_group_${"a".repeat(32)}`, phase_index: 1 };
const parent = { kind: "eval", eval_id: `eval_${"b".repeat(32)}`, trial_id: "phase-stop", attempt: 1 };
async function json(file: string, value: unknown) { await writeFile(file, JSON.stringify(value), { mode: 0o600 }); }

test("phase cancellation rejects stale/private-file violations and accepts a matching request once", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX phase controls");
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-phase-control-"));
  t.after(() => forceRemove(directory));
  const runId = newRunId();
  const token = randomBytes(32).toString("hex");
  const configurationPath = path.join(directory, `control-${runId}.config.json`);
  const requestPath = configurationPath.replace(".config.json", ".request.json");
  const configuration = { schema_version: "hitch-phase-control@1", run_id: runId, token };
  const request = { schema_version: "hitch-phase-cancel@1", run_id: runId, token, reason: "native_phase_reset" };
  await json(configurationPath, configuration);
  const monitor = await monitorPhaseCancellation({ configurationPath, expectedRunId: runId, runsRoot: path.join(directory, "state/runs") });
  t.after(() => monitor.close());
  let events = 0;
  monitor.signal.addEventListener("abort", () => events++);
  for (const bad of [{ ...request, token: "c".repeat(64) }, { ...request, run_id: newRunId() }, { ...request, reason: "invented" }, { ...request, reason: ["native_phase_reset"] }, { ...request, extra: true }]) {
    await json(requestPath, bad);
    await wait(130);
    assert.equal(monitor.signal.aborted, false);
  }
  await writeFile(requestPath, "x".repeat(5000));
  await wait(130);
  assert.equal(monitor.signal.aborted, false);
  await unlink(requestPath);
  const target = path.join(directory, "link-target.json");
  await json(target, request);
  await symlink(target, requestPath);
  await wait(130);
  assert.equal(monitor.signal.aborted, false);
  await unlink(requestPath);
  await json(requestPath, request);
  for (let i = 0; i < 20 && !monitor.signal.aborted; i++) await wait(25);
  assert.equal(monitor.signal.aborted, true);
  await json(requestPath, request);
  await wait(130);
  assert.equal(events, 1);
  await monitor.close();
  const beforeLaunch = await monitorPhaseCancellation({ configurationPath, expectedRunId: runId, runsRoot: path.join(directory, "state/runs") });
  assert.equal(beforeLaunch.signal.aborted, true);
  await beforeLaunch.close();
  await assert.rejects(monitorPhaseCancellation({ configurationPath, expectedRunId: newRunId(), runsRoot: directory }), /run-scoped/);
  await assert.rejects(monitorPhaseCancellation({ configurationPath, expectedRunId: runId, runsRoot: directory }), /outside run bundles/);
  await writeFile(configurationPath, JSON.stringify(configuration).slice(0, -1));
  await assert.rejects(monitorPhaseCancellation({ configurationPath, expectedRunId: runId, runsRoot: path.join(directory, "state/runs") }), error => {
    assert.equal((error as Error).message.includes(token), false);
    return (error as Error).message === "phase control input is not valid JSON";
  });
});

test("real Hitch CLI phase cancellation seals native evidence and exports the cancelled run", { timeout: 20000 }, async (t) => {
  if (process.platform === "win32") return t.skip("POSIX phase controls");
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-phase-cancel-cli-"));
  t.after(() => forceRemove(directory));
  const project = path.join(directory, "project");
  const root = path.join(directory, "state");
  await mkdir(project);
  const executable = path.join(directory, "synthetic-codex");
  await writeFile(executable, `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('codex-cli 9.9.9');process.exit(0);}
require('node:fs').writeFileSync('candidate.pid',String(process.pid));
console.log(JSON.stringify({type:'thread.started',thread_id:require('node:crypto').randomUUID()}));
console.log(JSON.stringify({type:'item.completed',item:{id:'ready',type:'agent_message',text:'candidate-ready'}}));
process.stdin.resume();setInterval(()=>{},1000);
`, { mode: 0o755 });
  const runId = newRunId();
  const token = randomBytes(32).toString("hex");
  const configurationPath = path.join(directory, `control-${runId}.config.json`);
  const requestPath = configurationPath.replace(".config.json", ".request.json");
  await json(configurationPath, { schema_version: "hitch-phase-control@1", run_id: runId, token });
  await json(path.join(directory, "context.json"), context);
  await json(path.join(directory, "parent.json"), parent);
  const cli = spawn(process.execPath, [path.resolve("dist/bin/hitch.js"), "--root", root, "run", "--agent", "codex",
    "--cwd", project, "--workspace-mode", "shared", "--prompt", "Wait for the controller", "--model", "synthetic-model",
    "--context-file", path.join(directory, "context.json"), "--parent-file", path.join(directory, "parent.json"),
    "--internal-run-id", runId, "--internal-phase-control", configurationPath, "--timeout", "60000"], {
    env: { ...process.env, HITCH_CODEX_PATH: executable, HITCH_HARBOR_INTERNAL: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  cli.stdout.setEncoding("utf8"); cli.stderr.setEncoding("utf8");
  cli.stdout.on("data", value => { output += value; }); cli.stderr.on("data", value => { output += value; });
  const completion = new Promise<number | null>((resolve, reject) => { cli.once("error", reject); cli.once("close", resolve); });
  try {
    for (let i = 0; i < 200 && !output.includes("candidate-ready") && cli.exitCode === null; i++) await wait(25);
    assert.ok(output.includes("candidate-ready"), output);
    const request = { schema_version: "hitch-phase-cancel@1", run_id: runId, token, reason: "native_phase_reset" };
    await json(requestPath, { ...request, token: "c".repeat(64) });
    await wait(200);
    assert.equal(cli.exitCode, null);
    await json(requestPath, request);
    for (let i = 0; i < 200 && cli.exitCode === null; i++) await wait(25);
    assert.notEqual(cli.exitCode, null, "cancellation did not finish the CLI");
    assert.equal(await completion, 9, output);
    const sourceDirectory = path.join(root, "runs", runId);
    const loaded = await loadRunRecord(sourceDirectory);
    assert.equal(loaded.record.status, "cancelled");
    assert.equal(loaded.record.observation, undefined);
    assert.equal(loaded.record_status, "valid");
    assert.equal(loaded.trajectory_status, "valid");
    const index = await verifyResultBundleIndex(sourceDirectory);
    assert.equal(output.includes(token), false);
    for (const file of index.files) assert.equal((await readFile(path.join(sourceDirectory, file.path))).includes(Buffer.from(token)), false, file.path);
    await copySealedPhaseRunBundle({ sourceDirectory, destinationDirectory: path.join(directory, "exported"), expected: { run_id: runId, context, parent, revision_identity: (await loadRunRecord(sourceDirectory)).record.harness.revision_identity } });
    // Exercise the executor race where cancellation is delivered by onProcess
    // before its abort listener is installed.
    const old = process.env.HITCH_CODEX_PATH;
    process.env.HITCH_CODEX_PATH = executable;
    const abort = new AbortController();
    try {
      const cancelled = await executeRun({ runId: newRunId(), root, runsRoot: path.join(root, "runs"), signal: abort.signal,
        onProcess: control => { if (control?.child) abort.abort(); },
        request: { agent: "codex", cwd: project, workspace_mode: "shared", prompt: "cancel on launch", timeout_ms: 3000, context, parent },
      });
      assert.equal(cancelled.status, "cancelled");
      const preCancelledId = newRunId();
      const preCancelled = await executeRun({ runId: preCancelledId, root, runsRoot: path.join(root, "runs"), signal: abort.signal,
        onProcess: control => { assert.equal(control?.child, undefined); },
        request: { agent: "codex", cwd: project, workspace_mode: "shared", prompt: "cancel before launch", timeout_ms: 3000, context, parent },
      });
      assert.equal(preCancelled.status, "cancelled");
      await verifyResultBundleIndex(path.join(root, "runs", preCancelledId));
    } finally {
      if (old === undefined) delete process.env.HITCH_CODEX_PATH; else process.env.HITCH_CODEX_PATH = old;
    }
  } finally {
    if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL");
    try {
      const pid = (await readFile(path.join(project, "candidate.pid"), "utf8")).trim();
      if (/^[1-9][0-9]{0,9}$/.test(pid) && Number(pid) > 1) process.kill(-Number(pid), "SIGKILL");
    } catch { /* Own synthetic child already exited. */ }
  }
});
