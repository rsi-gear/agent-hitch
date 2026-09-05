import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("Harbor logs do not leak pipes and interrupted execution retains bounded diagnostic evidence", (t) => {
  if (process.platform === "win32") return t.skip("POSIX Harbor bridge");
  const result = spawnSync("python3", ["-B", "test-support/harbor_run_logs_smoke.py"], {
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});
