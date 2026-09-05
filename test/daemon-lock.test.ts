import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireInstanceLock } from "../src/daemon/auth.js";

test("daemon lock reclamation retries an owner record still being written", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "hitch-daemon-lock-write-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "daemon.lock");
  await fs.writeFile(file, JSON.stringify({ pid: 2_147_483_647 }));
  const owner = JSON.stringify({ instance_id: "new-owner", pid: process.pid });
  const readFile = fs.readFile;
  let reads = 0;
  // Another daemon replaces the stale lock after our initial observation.
  // Its exclusive create is visible before its owner JSON write completes.
  const mock = t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === file && ++reads === 2) {
      await fs.writeFile(file, owner);
      return "";
    }
    return readFile(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(acquireInstanceLock(file, "contender"), { code: "already_running" });
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(reads >= 3, "the incomplete record must be retried");
  assert.equal(await fs.readFile(file, "utf8"), owner);
  await assert.rejects(fs.stat(`${file}.reclaim`), { code: "ENOENT" });
});

test("daemon lock acquisition still rejects a persistently malformed owner", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "hitch-daemon-lock-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "daemon.lock");
  await fs.writeFile(file, "{");
  await assert.rejects(acquireInstanceLock(file, "contender"), { code: "daemon_lock_invalid" });
  assert.equal(await fs.readFile(file, "utf8"), "{");
});
