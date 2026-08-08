import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

  const result = spawnSync(process.execPath, [
    executable,
    "run",
    "--harness", "codex@installed",
    "--agent", "codex",
    "--prompt", "hello",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /use only one of --harness and the legacy --agent/);
});
