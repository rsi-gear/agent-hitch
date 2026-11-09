import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutionLease } from "../src/evals/execution-leases.js";

const executable = fileURLToPath(new URL("../bin/hitch.js", import.meta.url));
const evalId = "eval_" + "a".repeat(32);

async function fixture(t: { after(fn: () => Promise<void>): void }, status = "failed") {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-direct-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "evals", evalId);
  await mkdir(directory, { recursive: true });
  const request = { schema_version: "1", backend: "harbor", dataset: "/test/data", harness_ref: "fixture", attempts: 1 };
  const result = { schema_version: "1", eval_id: evalId, status, completed_at: "2026-11-09T06:53:11.770Z" };
  await writeFile(path.join(directory, "request.json"), JSON.stringify(request));
  await writeFile(path.join(directory, "result.json"), JSON.stringify(result));
  const lease = await createExecutionLease({ evalDirectory: directory, evalId, workId: "work_" + "b".repeat(32),
    worker: { workerId: "fixture-worker", provider: "local-docker", collisionDomainId: "fixture-domain" },
    reservation: { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 }, ttlMs: 60000 });
  return { root, directory, lease };
}

function cancel(root: string, json = true) {
  return spawnSync(process.execPath, [executable, "--root", root, "eval", "cancel", evalId, ...(json ? ["--json"] : [])], { encoding: "utf8" });
}

test("direct terminal eval cancellation accepts --json without a daemon and preserves failed evidence", async t => {
  const { root, directory, lease } = await fixture(t);
  await lease.release();
  const before = await readFile(path.join(directory, "result.json"), "utf8");
  for (const json of [true, false, true]) {
    const result = cancel(root, json);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { schema_version: "1", eval_id: evalId, status: "failed" });
    assert.equal(await readFile(path.join(directory, "result.json"), "utf8"), before);
  }
});

test("terminal result cannot confirm cancellation while a lease is still active", async t => {
  const { root, lease } = await fixture(t);
  await lease.markRunning();
  const result = cancel(root);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.trim(), "");
  assert.doesNotMatch(result.stderr, /unexpected argument.*--json/);
});

test("released leases cannot make an unfinished or unrecognized result terminal", async t => {
  for (const status of ["running", "unknown"]) {
    const { root, lease } = await fixture(t, status);
    await lease.release();
    const result = cancel(root);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  }
});

test("a pending rerun prevents a direct terminal cancellation acknowledgement", async t => {
  const { root, directory, lease } = await fixture(t);
  await lease.release();
  const rerun = path.join(directory, "reruns", "rerun_" + "c".repeat(32));
  await mkdir(rerun, { recursive: true });
  await writeFile(path.join(rerun, "submission.json"), "{}");
  const result = cancel(root);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

test("daemon-managed evaluations continue through their coordinator", async t => {
  const { root, directory, lease } = await fixture(t);
  await lease.release();
  await writeFile(path.join(directory, "control.json"), JSON.stringify({ state: "failed" }));
  const result = cancel(root);
  assert.notEqual(result.status, 0, "stopped daemon must not be bypassed for managed evaluations");
  assert.equal(result.stdout.trim(), "");
});
