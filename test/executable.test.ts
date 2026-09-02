import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HitchError, prepareSpawnCommand, resolveExecutable, runCommand } from "../src/foundation/index.js";

test("spawn preparation leaves native executables unchanged", () => {
  assert.deepEqual(prepareSpawnCommand("/usr/bin/node", ["--version"], { platform: "linux" }), {
    executable: "/usr/bin/node",
    args: ["--version"],
    windowsVerbatimArguments: false,
  });
});

test("spawn preparation routes Windows batch shims through cmd.exe with escaped arguments", () => {
  const invocation = prepareSpawnCommand(
    String.raw`C:\Program Files\node_modules\.bin\codex.cmd`,
    ["exec", "space and & shell metacharacters", "100%", String.raw`say "hello"`],
    { platform: "win32", comspec: String.raw`C:\Windows\System32\cmd.exe` },
  );

  assert.equal(invocation.executable, String.raw`C:\Windows\System32\cmd.exe`);
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.match(invocation.args[3] || "", /codex\.cmd/);
  assert.match(invocation.args[3] || "", /\^&/);
  assert.match(invocation.args[3] || "", /\^%/);
});

test("Windows batch spawn rejects command separators encoded as control characters", () => {
  assert.throws(
    () => prepareSpawnCommand("npm.cmd", ["view\r\nwhoami"], { platform: "win32" }),
    (error) => error instanceof HitchError && error.code === "invalid_input",
  );
});

test("Windows executable resolution and batch execution honor PATHEXT", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-windows-executable-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const shim = path.join(directory, "hitch-probe.CMD");
  await writeFile(shim, "@echo off\r\necho windows-shim-ready\r\n");

  const executable = await resolveExecutable("hitch-probe", directory, ".EXE;.CMD");
  assert.equal(executable?.toLowerCase(), (await realpath(shim)).toLowerCase());
  assert.equal((await runCommand(executable as string, [])).stdout.trim(), "windows-shim-ready");
});
