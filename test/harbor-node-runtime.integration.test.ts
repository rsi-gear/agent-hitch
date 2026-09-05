import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureControllerRuntime } from "../src/controller-runtime/index.js";
import { attachHarborNodeRuntime, prepareHarborNodeRuntime } from "../src/evals/harbor-node-runtime.js";
import { runCommand } from "../src/foundation/index.js";
import { nodeRuntimeHarnessFixture } from "../test-support/harbor-node-runtime-fixture.js";
import { forceRemove } from "../test-support/helpers.js";

test("real Linux/amd64 trial boots Hitch and npm with network disabled and no system Node", {
  skip: process.env.HITCH_NODE_RUNTIME_DOCKER_TEST !== "1", timeout: 5 * 60_000,
}, async (t) => {
  const docker = process.env.HITCH_DOCKER_PATH?.trim() || "docker";
  // Explicit opt-in: use an existing pinned image, never pull in this test.
  const sourceImage = process.env.HITCH_NODE_RUNTIME_TEST_IMAGE || "node:22.23.0-bookworm-slim";
  const inspected = await runCommand(docker, ["image", "inspect", "--format", "{{json .}}", sourceImage], { timeoutMs: 30_000 });
  const image = JSON.parse(inspected.stdout) as { Id: string; Os: string; Architecture: string };
  assert.equal(`${image.Os}/${image.Architecture}`, "linux/amd64");
  const root = await mkdtemp(path.join(tmpdir(), "hitch-node-docker-test-"));
  t.after(() => forceRemove(root));
  const input = {
    root, docker, env: process.env,
    builder: { id: image.Id, reference: sourceImage, dockerPlatform: "linux/amd64", artifactPlatform: "linux-x64" },
  };
  const runtime = await prepareHarborNodeRuntime(input);
  const cached = await prepareHarborNodeRuntime(input);
  assert.deepEqual(cached, runtime);
  const fixture = await nodeRuntimeHarnessFixture(root);
  const composed = await attachHarborNodeRuntime(fixture.directory, fixture.manifest, runtime);
  const controller = await ensureControllerRuntime({ root });
  const result = await runCommand("python3", [
    "test-support/harbor_node_runtime_docker.py", docker, image.Id, composed.directory, controller.directory, path.join(root, "logs"),
  ], { timeoutMs: 180_000 });
  assert.match(result.stdout, /no-node: offline-artifact OK/);
  assert.match(result.stdout, /existing-node: system OK/);
  assert.match(result.stdout, /corrupt-upload: rejected OK/);
  t.diagnostic(result.stdout.trim());
});
