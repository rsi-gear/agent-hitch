import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { doctorHarbor, managedHarborExecutable, setupHarbor } from "../src/eval-tools.js";
import { writeFakeDocker, writeFakePython } from "../test-support/helpers.js";

test("managed Harbor setup is isolated, pinned, reusable, and discoverable", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const python = await writeFakePython(root);
  const first = await setupHarbor({ root, python, version: "0.21.0" });
  const second = await setupHarbor({ root, python, version: "0.21.0" });

  assert.equal(first.cache_hit, false);
  assert.equal(second.cache_hit, true);
  assert.equal(first.version, "0.21.0");
  assert.equal(first.install_directory, path.join(root, "tools", "harbor-0.21.0"));
  assert.equal(await managedHarborExecutable(root), first.executable);
});

test("Harbor doctor reports required runtime checks and credential warnings", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const python = await writeFakePython(root);
  const docker = await writeFakeDocker(root);
  await setupHarbor({ root, python });

  const ready = await doctorHarbor({
    root,
    python,
    docker,
    env: { ...process.env, OPENAI_API_KEY: "test-only" },
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.status, "ready");
  assert.equal(ready.checks.harbor.source, "managed");
  assert.deepEqual(ready.checks.credentials.present, ["OPENAI_API_KEY"]);

  const stoppedDocker = await writeFakeDocker(root, { daemonRunning: false });
  const actionRequired = await doctorHarbor({ root, python, docker: stoppedDocker, env: process.env });
  assert.equal(actionRequired.ready, false);
  assert.equal(actionRequired.status, "action_required");
  assert.equal(actionRequired.checks.docker.daemon, "unavailable");
});

test("managed Harbor setup rejects unsupported Python", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-python-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const python = await writeFakePython(root, { version: "3.11.9" });
  await assert.rejects(
    setupHarbor({ root, python }),
    (error) => error.code === "python_unsupported" && error.exitCode === 3,
  );
});
