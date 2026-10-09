import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureControllerRuntime } from "../src/controller-runtime/index.js";
import { attachHarborNodeRuntime, prepareHarborNodeRuntime } from "../src/evals/harbor-node-runtime.js";
import { harborPreparedArtifact } from "../src/evals/prepared-harness.js";
import { SharedRuntimeSnapshots } from "../src/evals/shared-runtime.js";
import { runCommand } from "../src/foundation/index.js";
import { nodeRuntimeHarnessFixture } from "../test-support/harbor-node-runtime-fixture.js";
import { forceRemove } from "../test-support/helpers.js";

test("real Docker candidates share read-only installations with isolated workspaces and offline Node", {
  skip: process.env.HITCH_NODE_RUNTIME_DOCKER_TEST !== "1", timeout: 5 * 60_000,
}, async (t) => {
  const docker = process.env.HITCH_DOCKER_PATH?.trim() || "docker";
  const sourceImage = process.env.HITCH_NODE_RUNTIME_TEST_IMAGE || "node:22.23.0-bookworm-slim";
  const inspected = await runCommand(docker, ["image", "inspect", "--format", "{{json .}}", sourceImage], { timeoutMs: 30_000 });
  const image = JSON.parse(inspected.stdout) as { Id: string; Os: string; Architecture: string };
  assert.equal(`${image.Os}/${image.Architecture}`, "linux/amd64");
  const root = await mkdtemp(path.join(tmpdir(), "hitch-shared-docker-$-"));
  t.after(() => forceRemove(root));
  const runtime = await prepareHarborNodeRuntime({ root, docker, env: process.env,
    builder: { id: image.Id, reference: sourceImage, dockerPlatform: "linux/amd64", artifactPlatform: "linux-x64" } });
  const fixture = await nodeRuntimeHarnessFixture(root);
  const composed = await attachHarborNodeRuntime(fixture.directory, fixture.manifest, runtime);
  const controller = await ensureControllerRuntime({ root });
  const artifact = { ...harborPreparedArtifact(root, { ...composed.manifest, executable: "node", entrypoint_args: [], cache_hit: false }), directory: composed.directory };
  const prepared = await new SharedRuntimeSnapshots(path.join(root, "shared"), controller, "readonly-bind").prepare(artifact);
  // A mutable cache must not be able to alter either container's installation.
  const source = path.join(controller.directory, "payload", "package.json");
  await chmod(source, 0o644);
  await writeFile(source, "{}\n");
  await writeFile(path.join(composed.directory, "entry.js"), "throw Error('mutable cache')\n");
  const result = await runCommand("python3", ["test-support/shared_runtime_docker.py", docker, image.Id,
    prepared.sharedRuntime!.artifact_directory, prepared.sharedRuntime!.runtime_directory, path.join(root, "logs")], { timeoutMs: 240_000 });
  assert.match(result.stdout, /shared runtime: two candidates, isolated workspaces, verifier excluded, no uploads OK/);
  t.diagnostic(result.stdout.trim());
});
