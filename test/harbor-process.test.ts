import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { invokeHarbor, readHarborProcessExitStatus } from "../src/backends/harbor/process.js";

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
