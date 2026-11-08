import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { delimiter } from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = process.env.KAGGLE_TEST_PYTHON ?? "python3";

test("Kaggle producer and scorer preserve split, resource and reward contracts", { timeout: 100_000 }, t => {
  if (spawnSync(python, ["--version"], { encoding: "utf8" }).error) {
    t.skip("Python 3 is required for the Kaggle source example contract suite");
    return;
  }
  for (const [command, args] of [
    [python, ["-m", "unittest", "discover", "-s", "benchmark-packages/kaggle/tests", "-v"]],
    [python, ["-B", "benchmark-packages/kaggle/tests/worker-supervisor.py"]],
    [python, ["-B", "benchmark-packages/kaggle/tests/holdout-worker.py"]],
    [process.execPath, ["--test", "benchmark-packages/kaggle/tests/producer.test.mjs",
      "benchmark-packages/kaggle/tests/analysis-mlebench.test.mjs"]],
  ] as const) {
    // A nested Node test runner otherwise sees NODE_TEST_CONTEXT and silently
    // skips its files while returning zero, making this integration check fake.
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(command, [...args], { cwd: root, env, encoding: "utf8", timeout: 90_000, maxBuffer: 2 * 1024 ** 2 });
    assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
  }
});

test("analysis scoring agrees with the pinned native MLE-bench graders", {
  skip: !process.env.GEAR_MLEBENCH_REPOSITORY,
}, () => {
  const result = spawnSync(python, ["-B", "benchmark-packages/kaggle/tests/mlebench-parity.py"], {
    cwd: root, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1", MKL_NUM_THREADS: "1",
      PYTHONPATH: [process.env.GEAR_MLEBENCH_REPOSITORY, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
  });
  assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
});
