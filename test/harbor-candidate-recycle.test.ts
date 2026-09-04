import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("Harbor candidate replacement fences ownership, persistent mounts, failures and replay", () => {
  const result = spawnSync("python3", ["test-support/harbor_candidate_recycle_smoke.py"], {
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
