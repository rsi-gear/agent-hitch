import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reclaimStaleLock } from "../src/locks.js";

test("stale-lock reclamation is serialized and rechecks under the guard", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-lock-reclaim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "state.lock");
  await writeFile(file, "stale\n");

  let releaseFirst;
  const release = new Promise((resolve) => { releaseFirst = resolve; });
  let firstEntered;
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  const first = reclaimStaleLock(file, async () => {
    firstEntered();
    await release;
    return true;
  });
  await entered;

  let secondChecked = false;
  const second = await reclaimStaleLock(file, async () => {
    secondChecked = true;
    return true;
  });
  assert.equal(second, false);
  assert.equal(secondChecked, false);
  assert.equal(await readFile(file, "utf8"), "stale\n");

  releaseFirst();
  assert.equal(await first, true);
  await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
});
