import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("Harbor verifier startup hook preserves phase, causes, cancellation and context semantics", () => {
  const result = spawnSync("python3", ["test-support/harbor_verifier_timeout_smoke.py"], {
    encoding: "utf8", timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
