import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

test("phase resource barriers survive swallowed stop errors and fence verifier startup", () => {
  const result = spawnSync("python3", [path.resolve("test-support/harbor_phase_resources_smoke.py"), path.resolve("integrations/harbor")], {
    encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /phase resource lifecycle barriers passed/);
});
