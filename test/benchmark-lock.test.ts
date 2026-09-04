import test from "node:test";
import assert from "node:assert/strict";
import { chmod, cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBenchmark, loadBenchmarkLock, lockBenchmark, mapBenchmarkMetrics } from "../src/benchmarks/index.js";
import { writeBenchmarkFixture } from "../test-support/benchmark-fixture.js";

test("standard package identity and metric mapping are independent of host path and benchmark names", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = path.join(root, "a"), b = path.join(root, "b");
  await writeBenchmarkFixture(a);
  await cp(a, b, { recursive: true });
  const first = await loadBenchmark(a), other = await loadBenchmark(b);
  assert.deepEqual(first.lock, other.lock);
  await lockBenchmark(a);
  assert.deepEqual((await loadBenchmarkLock(path.join(a, "benchmark.lock.json"))).lock, first.lock);
  const metrics = mapBenchmarkMetrics({ passed: 0, auxiliary: 1 }, first.manifest, first.tasks[0]!.config);
  assert.deepEqual(metrics, { primary: 0, metrics: { target_reached: 0 } });
  for (const raw of [{}, { passed: true }, { passed: NaN }, { passed: "1" }, { passed: 2 }]) assert.throws(() => mapBenchmarkMetrics(raw, first.manifest, first.tasks[0]!.config), /metric/);
  const script = path.join(b, "tasks/add-seven/tests/test.sh");
  await chmod(script, 0o755);
  assert.notEqual((await loadBenchmark(b)).lock.package_digest, first.lock.package_digest);
  await writeFile(script, (await readFile(script, "utf8")) + "# changed grader\n");
  assert.notEqual((await loadBenchmark(b)).lock.tasks[0]!.grader_digest, first.lock.tasks[0]!.grader_digest);
});

test("new tool/metric names work without registration; unknown features, missing hooks and symlinks fail closed", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-other-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeBenchmarkFixture(root, { benchmark: "unregistered-synthetic", task: "different-task", tool: "grow", metric: "complete" });
  const loaded = await loadBenchmark(root);
  assert.equal(loaded.tasks[0]!.config.driver.kind, "tool-server");
  assert.deepEqual(mapBenchmarkMetrics({ passed: 1 }, loaded.manifest, loaded.tasks[0]!.config), { primary: 1, metrics: { complete: 1 } });
  const file = path.join(root, "tasks/different-task/task.hitch.json");
  const original = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
  for (const edited of [{ ...original, alien: true }, { ...original, requirements: [...original.requirements, "desktop"] }, { ...original, lifecycle: { ...original.lifecycle, prepare: undefined } }]) {
    await writeFile(file, JSON.stringify(edited));
    await assert.rejects(loadBenchmark(root));
  }
  await writeFile(file, JSON.stringify(original));
  await symlink("/etc/passwd", path.join(root, "runtime/escape"));
  await assert.rejects(loadBenchmark(root), /symlinks/);
});
