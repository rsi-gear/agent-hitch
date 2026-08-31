import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { invokeHarbor } from "../src/backends/harbor/process.js";

test("recoverable Harbor process writes directly to durable log files", async (t) => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-harbor-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fake-harbor");
  await writeFile(executable, "#!/bin/sh\nprintf 'durable stdout\\n'\nprintf 'durable stderr\\n' >&2\n", { mode: 0o700 });
  await chmod(executable, 0o700);
  const events: Record<string, unknown>[] = [];
  let processId: number | undefined;
  const result = await invokeHarbor(executable, [], {
    cwd: directory,
    env: { PATH: process.env.PATH },
    stdoutPath: path.join(directory, "stdout.log"),
    stderrPath: path.join(directory, "stderr.log"),
    emit: (event) => events.push(event),
    persistAcrossParentExit: true,
    onStarted: (pid) => { processId = pid; },
  });
  assert.equal(result.code, 0);
  assert.ok(processId);
  assert.equal(await readFile(path.join(directory, "stdout.log"), "utf8"), "durable stdout\n");
  assert.equal(await readFile(path.join(directory, "stderr.log"), "utf8"), "durable stderr\n");
  assert.ok(events.some((event) => event.type === "eval.backend.process-recorded" && event.process_id === processId));
  assert.equal(events.some((event) => event.type === "eval.backend.output"), false);
});
