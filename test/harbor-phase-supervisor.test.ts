import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("native phase supervisor joins real CLI cancellation, private RPC and sealed evidence", { timeout: 100_000 }, () => {
  const result = spawnSync("python3", ["test-support/harbor_phase_supervisor_smoke.py"], { encoding: "utf8", timeout: 90_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("native deadline adapter retains the pinned SDK graders, gates and accepted action prefix", { timeout: 20_000 }, () => {
  const result = spawnSync("python3", ["test-support/osworld_deadline_smoke.py"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
