import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reclaimStaleLock } from "../src/locks.js";

test("stale-lock reclamation is serialized and rechecks under the guard", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-locks-"));
  const file = path.join(directory, "target.lock");
  await writeFile(file, "stale\n");
  const reclaimed = await reclaimStaleLock(file, async () => true);
  assert.equal(reclaimed, true);
  await assert.rejects(readFile(file, "utf8"));
  // The guard file is cleaned up.
  const guard = `${file}.reclaim`;
  await assert.rejects(readFile(guard, "utf8"));
});

test("reclamation refuses when the lock is not stale", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-locks-"));
  const file = path.join(directory, "target.lock");
  await writeFile(file, "fresh\n");
  const reclaimed = await reclaimStaleLock(file, async () => false);
  assert.equal(reclaimed, false);
  assert.equal(await readFile(file, "utf8"), "fresh\n");
});

test("a concurrent reclamation attempt does not double-remove", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-locks-"));
  const file = path.join(directory, "target.lock");
  await writeFile(file, "stale\n");
  const first = reclaimStaleLock(file, async () => true);
  const second = reclaimStaleLock(file, async () => true);
  const results = await Promise.all([first, second]);
  assert.equal(results.filter(Boolean).length, 1);
  await rm(directory, { recursive: true, force: true });
});
