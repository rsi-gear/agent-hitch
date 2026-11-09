import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("MLE-bench tasks preserve resource isolation and independent delivery/quality verification", { timeout: 100_000 }, () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "benchmark-packages/kaggle/tests/task-contract.test.mjs"], {
    cwd: root, env, encoding: "utf8", timeout: 90_000, maxBuffer: 2 * 1024 ** 2,
  });
  assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
});
