import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { captureProcessIdentity, delay, inspectProcessIdentity } from "../src/foundation/index.js";
import { invokeHarbor, readHarborProcessExitStatus } from "../src/backends/harbor/process.js";

test("parent SIGKILL during durable identity admission cannot launch an unrecorded Harbor child", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-harbor-parent-kill-"));
  const marker = path.join(directory, "executed"), ready = path.join(directory, "ready");
  const source = `import {invokeHarbor} from ${JSON.stringify(new URL("../src/backends/harbor/process.js", import.meta.url).href)};
    import {writeFile} from 'node:fs/promises';
    await invokeHarbor(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`)}], {
      cwd: ${JSON.stringify(directory)}, env: process.env, stdoutPath: ${JSON.stringify(path.join(directory, "stdout"))},
      stderrPath: ${JSON.stringify(path.join(directory, "stderr"))}, exitStatusPath: ${JSON.stringify(path.join(directory, "exit.json"))},
      persistAcrossParentExit: true, emit:()=>{}, onStarted:async pid=>{ await writeFile(${JSON.stringify(ready)}, String(pid)); await new Promise(()=>{}); }
    });`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: "ignore" });
  const exited = once(parent, "exit");
  t.after(async () => { if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL"); await exited; await rm(directory, { recursive: true, force: true }); });
  const deadline = Date.now() + 5_000; let pid: number | undefined;
  while (!pid) { try { pid = Number(await readFile(ready, "utf8")); } catch {} assert.ok(Date.now() < deadline); if (!pid) await delay(20); }
  const identity = await captureProcessIdentity(pid); assert.ok(identity);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  parent.kill("SIGKILL"); assert.deepEqual(await exited, [null, "SIGKILL"]);
  while (await inspectProcessIdentity(identity) === "running") { assert.ok(Date.now() < deadline); await delay(20); }
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

for (const reject of [false, true]) {
  test(`recoverable Harbor cannot execute before its durable identity callback ${reject ? "fails" : "completes"}`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "hitch-harbor-admission-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const marker = path.join(directory, "executed");
    let resume!: () => void, reached!: () => void;
    const barrier = new Promise<void>(resolve => { resume = resolve; }), started = new Promise<void>(resolve => { reached = resolve; });
    const invocation = invokeHarbor(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`], {
      cwd: directory, env: process.env, stdoutPath: path.join(directory, "stdout.log"), stderrPath: path.join(directory, "stderr.log"),
      persistAcrossParentExit: true, exitStatusPath: path.join(directory, "process-exit.json"), emit: () => {},
      onStarted: async () => { reached(); await barrier; if (reject) throw new Error("durable identity write failed"); },
    });
    const outcome = invocation.then(value => ({ value }), error => ({ error }));
    await started;
    // A live, ready supervisor has been spawned; its backend remains gated.
    await new Promise(resolve => setTimeout(resolve, 100)); await assert.rejects(readFile(marker), { code: "ENOENT" });
    resume(); const result = await outcome;
    if (reject) { assert.ok("error" in result); await assert.rejects(readFile(marker), { code: "ENOENT" }); }
    else { assert.ok("value" in result); assert.equal(result.value.code, 0); assert.equal(await readFile(marker, "utf8"), "executed"); }
  });
}

test("recoverable Harbor process writes directly to durable log files", async (t) => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-harbor-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fake-harbor");
  await writeFile(executable, "#!/bin/sh\nprintf 'durable stdout\\n'\nprintf 'durable stderr\\n' >&2\n", { mode: 0o700 });
  await chmod(executable, 0o700);
  const events: Record<string, unknown>[] = [];
  let processId: number | undefined;
  const exitStatusPath = path.join(directory, "process-exit.json");
  const result = await invokeHarbor(executable, [], {
    cwd: directory,
    env: { PATH: process.env.PATH },
    stdoutPath: path.join(directory, "stdout.log"),
    stderrPath: path.join(directory, "stderr.log"),
    emit: (event) => events.push(event),
    persistAcrossParentExit: true,
    exitStatusPath,
    onStarted: (pid) => { processId = pid; },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(await readHarborProcessExitStatus(exitStatusPath), { code: 0, signal: null });
  assert.ok(processId);
  assert.equal(await readFile(path.join(directory, "stdout.log"), "utf8"), "durable stdout\n");
  assert.equal(await readFile(path.join(directory, "stderr.log"), "utf8"), "durable stderr\n");
  assert.ok(events.some((event) => event.type === "eval.backend.process-recorded" && event.process_id === processId));
  assert.equal(events.some((event) => event.type === "eval.backend.output"), false);
});

for (const recoverable of [false, true]) {
  test(`${recoverable ? "recoverable" : "attached"} Harbor process redacts credential values before logs are persisted`, async (t) => {
    if (recoverable && process.platform === "win32") return;
    const directory = await mkdtemp(path.join(tmpdir(), "hitch-harbor-redaction-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "secret-harbor");
    const secret = "custom-secret-value-without-provider-prefix";
    await writeFile(executable, "#!/bin/sh\nprintf 'out:%s\\n' \"$EVAL_SECRET\"\nprintf 'Authorization: Bearer abcdefghijklmnop\\n' >&2\n", { mode: 0o700 });
    await chmod(executable, 0o700);
    const events: Record<string, unknown>[] = [];
    const result = await invokeHarbor(executable, [], {
      cwd: directory,
      env: { PATH: process.env.PATH, EVAL_SECRET: secret },
      stdoutPath: path.join(directory, "stdout.log"),
      stderrPath: path.join(directory, "stderr.log"),
      emit: (event) => events.push(event),
      redactEnvNames: ["EVAL_SECRET"],
      ...(recoverable ? {
        persistAcrossParentExit: true,
        exitStatusPath: path.join(directory, "process-exit.json"),
        onStarted: () => {},
      } : {}),
    });
    assert.equal(result.code, 0);
    const persisted = `${await readFile(path.join(directory, "stdout.log"), "utf8")}\n${await readFile(path.join(directory, "stderr.log"), "utf8")}`;
    assert.equal(persisted.includes(secret), false);
    assert.equal(persisted.includes("abcdefghijklmnop"), false);
    assert.match(persisted, /\[REDACTED\]/);
    assert.equal(JSON.stringify(events).includes(secret), false);
  });
}
