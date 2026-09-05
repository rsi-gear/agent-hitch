import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("Harbor prepares phase IDs before binding and exports sealed evidence without resetting budgets", () => {
  const result = spawnSync("python3", ["test-support/harbor_phase_invocation_smoke.py"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
