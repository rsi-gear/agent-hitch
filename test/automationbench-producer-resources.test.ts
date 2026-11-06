import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

test("AutomationBench v4/v5 declare generic simulator limits and seal new export identities", () => {
  const result = spawnSync(process.execPath, [path.resolve("test-support/automationbench_producer_resources.mjs")], {
    encoding: "utf8", timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /v4\/v5 generic simulator resources and export identities passed/);
});
