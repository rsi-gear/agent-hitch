import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withResourceAdmission } from "../src/backends/harbor/resource-admission.js";
import type { RunHarborBackendOptions } from "../src/backends/harbor/backend.js";
import { hash, resourceRequest, type ResourceLease } from "../src/resources/index.js";
import { fixtureImage, fixtureImageManifest, fixtureReference, resourceFixture } from "../test-support/resource-fixture.js";

test("pre-start failures free workspace capacity while uncertain started execution stays protected", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-admission-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, source } = await resourceFixture(directory, 1);
  const docker = path.join(directory, "docker");
  const inspection = { Id: hash("fixture OCI config"), Os: "linux", Architecture: "amd64", RepoDigests: [fixtureReference], RootFS: { Layers: [] } };
  await writeFile(docker, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(inspection))});\n`, { mode: 0o755 });
  const previous = process.env.HITCH_DOCKER_PATH; process.env.HITCH_DOCKER_PATH = docker;
  t.after(() => { if (previous === undefined) delete process.env.HITCH_DOCKER_PATH; else process.env.HITCH_DOCKER_PATH = previous; });
  await resourceRequest(store.root, "configure", { protocol: "hitch-resource-host@1", transport: { [fixtureImage.manifestDigest]: fixtureReference },
    imagePolicy: "cache-only", platform: fixtureImage.platform, workspace: { mode: "copy", maxWorkspaces: 1 }, limits: { minFreeBytes: 0 } });
  const proofs = path.join(store.directory, "oci-manifests"); await mkdir(proofs, { recursive: true });
  await writeFile(path.join(proofs, `${fixtureImage.manifestDigest.slice(7)}.json`), JSON.stringify({ manifest: fixtureImageManifest }));
  const active = async () => (await store.records<ResourceLease>("leases")).filter(lease => lease.purpose === "execution" && lease.state === "active");
  for (let attempt = 0; attempt < 3; attempt++) {
    const backendDirectory = path.join(directory, `attempt-${attempt}`);
    const options = { root: store.root, evalId: `eval_${"1".repeat(32)}`, evalDirectory: directory, backendDirectory,
      taskNames: ["task-0"], request: { dataset: source, attempts: 1, max_concurrent: 1 } } as unknown as RunHarborBackendOptions;
    const failure = new Error("missing credential before model execution");
    await assert.rejects(withResourceAdmission(options, async admitted => {
      assert.notEqual(admitted.request.dataset, source);
      assert.equal((await active()).length, 1);
      if (attempt === 2) admitted.emit?.({ type: "eval.backend.started" });
      throw failure;
    }), error => error === failure);
    const evidence = JSON.parse(await readFile(path.join(backendDirectory, "resource-evidence.json"), "utf8"));
    if (attempt === 2) {
      assert.equal((await active()).length, 1);
      assert.equal(evidence.executionEnded, false);
      assert.equal(evidence.resultSealed, undefined);
    } else {
      assert.equal((await active()).length, 0);
      assert.equal(evidence.executionEnded, true);
      assert.equal(evidence.resultSealed, true);
      const result = JSON.parse(await readFile(path.join(backendDirectory, "resource-admission-failure/result.json"), "utf8"));
      assert.equal(result.executionStarted, false);
      await store.objects.verify(evidence.materializedTree.manifestDigest);
    }
  }
});
