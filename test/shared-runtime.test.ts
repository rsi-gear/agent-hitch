import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ensureControllerRuntime, useControllerRuntimeDirectory } from "../src/controller-runtime/index.js";
import { artifactDirectoryIntegrity, verifyPreparedArtifact } from "../src/artifacts/index.js";
import { SharedRuntimeSnapshots } from "../src/evals/shared-runtime.js";
import { harborPreparedArtifact } from "../src/evals/prepared-harness.js";
import { nodeRuntimeHarnessFixture } from "../test-support/harbor-node-runtime-fixture.js";
import { forceRemove } from "../test-support/helpers.js";

test("concurrent tasks share verified installation snapshots, isolated from subsequent cache writes", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-shared-runtime-"));
  t.after(() => forceRemove(root));
  const controller = await ensureControllerRuntime({ root });
  const fixture = await nodeRuntimeHarnessFixture(root);
  await symlink("entry.js", path.join(fixture.directory, "alias.js"));
  fixture.manifest.artifact_integrity = await artifactDirectoryIntegrity(fixture.directory);
  await writeFile(path.join(fixture.directory, "artifact.json"), JSON.stringify(fixture.manifest));
  const artifact = { ...harborPreparedArtifact(root, { ...fixture.manifest, executable: "node", entrypoint_args: [], cache_hit: false }), directory: fixture.directory };
  const base = path.join(root, "eval", "shared-runtime");
  const alias = path.join(root, "controller-alias");
  await symlink(controller.directory, alias);
  try {
    await assert.rejects(new SharedRuntimeSnapshots(base, { ...controller, directory: alias }, "readonly-bind").prepare(artifact), /regular directory/);
  } finally {
    await unlink(alias);
  }
  const snapshots = new SharedRuntimeSnapshots(base, controller, "readonly-bind");
  const tasks = await Promise.all(Array.from({ length: 20 }, () => snapshots.prepare(artifact)));
  const shared = tasks[0]!.sharedRuntime!;
  assert.equal(new Set(tasks.map((x) => x.sharedRuntime!.artifact_directory)).size, 1);
  assert.equal(new Set(tasks.map((x) => x.sharedRuntime!.runtime_directory)).size, 1);
  assert.equal((await readdir(base)).length, 2);
  assert.notEqual(shared.runtime_directory, controller.directory);
  assert.notEqual(shared.artifact_directory, artifact.directory);
  await writeFile(path.join(artifact.directory, "entry.js"), "console.log('changed original cache')\n");
  const controllerFile = path.join(controller.directory, "payload", "package.json");
  await chmod(controllerFile, 0o644);
  await writeFile(controllerFile, "{}\n");
  await useControllerRuntimeDirectory(shared.runtime_directory, controller.runtime_id);
  await verifyPreparedArtifact(shared.artifact_directory, artifact);
  assert.match(await readFile(path.join(shared.artifact_directory, "alias.js"), "utf8"), /offline harness OK/);
  assert.deepEqual((await snapshots.prepare(artifact)).sharedRuntime, shared);
  // A fresh evaluation must not accept the now-corrupt source cache.
  await assert.rejects(new SharedRuntimeSnapshots(path.join(root, "new-eval"), controller, "readonly-bind").prepare(artifact), /integrity mismatch/);
});

test("corrupt dependencies are rejected before a snapshot is published; upload remains compatible", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-shared-corrupt-"));
  t.after(() => forceRemove(root));
  const controller = await ensureControllerRuntime({ root });
  const fixture = await nodeRuntimeHarnessFixture(root);
  const artifact = { ...harborPreparedArtifact(root, { ...fixture.manifest, executable: "node", entrypoint_args: [], cache_hit: false }), directory: fixture.directory };
  const base = path.join(root, "eval", "shared-runtime");
  await writeFile(path.join(artifact.directory, "extra-dependency.js"), "unexpected code");
  await assert.rejects(new SharedRuntimeSnapshots(base, controller, "readonly-bind").prepare(artifact), /content verification/);
  assert.equal((await readdir(base)).some((name) => name.startsWith("artifact") || name.startsWith(".")), false);
  assert.equal(await new SharedRuntimeSnapshots(undefined, controller, "upload").prepare(artifact), artifact);
  assert.throws(() => new SharedRuntimeSnapshots(undefined, controller, "readonly-bind"), /local Linux/);
  assert.throws(() => new SharedRuntimeSnapshots(base, controller, "typo"), /must be upload or readonly-bind/);
  const cancellation = new AbortController(); cancellation.abort();
  await assert.rejects(new SharedRuntimeSnapshots(base, controller, "readonly-bind").prepare(artifact, cancellation.signal), /abort/i);
});

test("shared runtime bridge enforces read-only mounts and verifier isolation", () => {
  const result = spawnSync("python3", ["test-support/shared_runtime_smoke.py"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /OK/);
});
