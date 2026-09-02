import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("native phase supervisor joins real CLI cancellation, private RPC and sealed evidence", { timeout: 100_000 }, () => {
  const result = spawnSync("python3", ["test-support/harbor_phase_supervisor_smoke.py"], { encoding: "utf8", timeout: 90_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
