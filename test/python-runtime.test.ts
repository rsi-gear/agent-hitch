import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand, packageRoot } from "../src/foundation/index.js";
import { observeHarborPythonRuntime } from "../src/backends/harbor/python-runtime.js";

test("Python runtime inventory verifies file drift, bytecode caches and resource bounds", async () => {
  const result = await runCommand(process.env.HITCH_TEST_PYTHON || "python3",
    ["-B", path.join(packageRoot(), "test-support/python-runtime-inventory.py")], { timeoutMs: 30_000 });
  assert.match(result.stderr, /Ran \d+ tests/);
  assert.match(result.stderr, /\bOK\b/);
});

test("unsupported launchers and relative module paths fail without exposing diagnostics", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-python-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"); await mkdir(bin);
  const harbor = path.join(bin, "harbor");
  await writeFile(harbor, `#!${process.execPath}\nconsole.error('private-diagnostic');console.log('harbor 0.21.0');\n`, { mode: 0o755 });
  for (const env of [{ HITCH_HARBOR_PATH: harbor }, { HITCH_HARBOR_PATH: harbor, PYTHONPATH: "relative" }]) {
    await assert.rejects(observeHarborPythonRuntime({ root, env }), error => {
      assert.equal((error as { code?: string }).code, "harbor_python_runtime_unavailable");
      assert.ok(!(error as Error).message.includes("private-diagnostic"));
      assert.ok(!(error as Error).message.includes(root));
      return true;
    });
  }
});

async function waitingInventory(t: TestContext, timeoutMs?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-python-deadline-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const marker = path.join(root, "started");
  const release = path.join(root, "release");
  const versionProbe = path.join(root, "version-probe");
  const python = path.join(bin, "python");
  const harbor = path.join(bin, "harbor");
  const observation = { schema_version: "1", integrity: "sha256:" + "a".repeat(64), python_version: "3.13.9", file_count: 1 };
  await writeFile(python, `#!${process.execPath}
const fs = require('node:fs');
if (!process.argv.includes('-B')) {
  fs.writeFileSync(${JSON.stringify(versionProbe)}, 'unverified-launch');
  console.log('harbor 0.21.0'); process.exit(0);
}
// fs.watch can report creation before writeFileSync finishes writing.
// Publish the complete PID atomically before the parent advances its timers.
fs.writeFileSync(${JSON.stringify(marker + ".pid")}, String(process.pid));
fs.renameSync(${JSON.stringify(marker + ".pid")}, ${JSON.stringify(marker)});
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) {
    console.log(${JSON.stringify(JSON.stringify({ runtime: observation, proof: "b".repeat(64) }))}); process.exit(0);
  }
}, 5);
`, { mode: 0o755 });
  await writeFile(harbor, `#!${python}\n`, { mode: 0o755 });
  let watcher: ReturnType<typeof watch>;
  const started = new Promise<void>(resolve => {
    watcher = watch(root, (_event, filename) => {
      if (filename === "started") { watcher.close(); resolve(); }
    });
  });
  const controller = new AbortController();
  const result = observeHarborPythonRuntime({ root, signal: controller.signal, env: {
    HITCH_HARBOR_PATH: harbor,
    ...(timeoutMs === undefined ? {} : { HITCH_HARBOR_PYTHON_RUNTIME_TIMEOUT_MS: timeoutMs }),
  } });
  // Attach a rejection handler immediately, including when the caller advances timers.
  void result.catch(() => {});
  t.after(async () => {
    controller.abort();
    watcher.close();
    await result.catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await started;
  return { result, controller, marker, release, observation, versionProbe };
}

test("runtime verification resolves its launcher without an unbounded version probe", async t => {
  const fixture = await waitingInventory(t);
  await writeFile(fixture.release, "ready");
  assert.deepEqual(await fixture.result, fixture.observation);
  await assert.rejects(readFile(fixture.versionProbe), { code: "ENOENT" });
});

test("valid runtime inventories can finish after the former 45-second cutoff", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = await waitingInventory(t);
  t.mock.timers.tick(45_001);
  await writeFile(fixture.release, "ready");
  assert.deepEqual(await fixture.result, fixture.observation);
});

test("configured inventory deadlines stop the subprocess with an actionable error", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = await waitingInventory(t, "100");
  const pid = Number(await readFile(fixture.marker, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "inventory marker must identify the actual child PID");
  t.mock.timers.tick(100);
  await assert.rejects(fixture.result, { code: "harbor_python_runtime_timeout" });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("cancelling a runtime inventory stops its subprocess without claiming file drift", async t => {
  const fixture = await waitingInventory(t);
  const pid = Number(await readFile(fixture.marker, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "inventory marker must identify the actual child PID");
  fixture.controller.abort();
  await assert.rejects(fixture.result, { code: "cancelled" });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("invalid inventory deadlines fail before invoking a launcher", async () => {
  for (const value of ["0", "-1", "1.5", "private-diagnostic", "2147483648"]) {
    await assert.rejects(observeHarborPythonRuntime({ root: "/unused", env: {
      HITCH_HARBOR_PYTHON_RUNTIME_TIMEOUT_MS: value,
    } }), error => {
      assert.equal((error as { code?: string }).code, "invalid_input");
      assert.ok(!(error as Error).message.includes("private-diagnostic"));
      return true;
    });
  }
});
