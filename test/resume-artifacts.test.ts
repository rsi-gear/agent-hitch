import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { preparedArtifactDirectory, verifyPreparedArtifact } from "../src/artifacts/index.js";
import { ensureControllerRuntime, useControllerRuntimeDirectory } from "../src/controller-runtime/index.js";
import { harborPreparedArtifact } from "../src/evals/prepared-harness.js";
import { preparedArtifactSummary } from "../src/evals/result-helpers.js";
import { loadResumedEvalArtifacts } from "../src/evals/resume-artifacts.js";
import type { EvalResumeState } from "../src/evals/resume-state.js";
import { nodeRuntimeHarnessFixture } from "../test-support/harbor-node-runtime-fixture.js";
import { forceRemove } from "../test-support/helpers.js";

async function fixture(root: string) {
  const controller = await ensureControllerRuntime({ root });
  const prepared = await nodeRuntimeHarnessFixture(root);
  // This fixture is installed in the host artifact store. Production Linux
  // container artifacts instead use the separate Harbor artifact cache.
  prepared.manifest.platform = `${process.platform}-${process.arch}`;
  await writeFile(path.join(prepared.directory, "artifact.json"), JSON.stringify(prepared.manifest));
  const directory = preparedArtifactDirectory(root, prepared.manifest.artifact_id);
  await mkdir(path.dirname(directory), { recursive: true });
  await rename(prepared.directory, directory);
  const artifact = harborPreparedArtifact(root, { ...prepared.manifest, executable: "node", entrypoint_args: [], cache_hit: false });
  const state = {
    plan: { candidate: {}, prepared_artifact: preparedArtifactSummary(artifact),
      controller_runtime: { runtime_id: controller.runtime_id, manifest_digest: controller.manifest_digest } },
    executionPlan: { work_items: [{ task_ids: ["task-a"], artifact_id: artifact.artifact_id }] },
  } as unknown as EvalResumeState;
  const contracts = [{ task_ids: ["task-a"], docker_platform: process.arch === "arm64" ? "linux/arm64" : "linux/amd64", artifact_platform: artifact.platform, node_version: "v22.23.0" }];
  return { controller, artifact, state, contracts };
}

test("resumed artifacts retain frozen identity and reject changed cache contents without rebuilding", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-resumed-artifacts-"));
  t.after(() => forceRemove(root));
  const { artifact, state, contracts, controller } = await fixture(root);
  const frozen = JSON.stringify(state);
  const plain = await loadResumedEvalArtifacts(root, state, contracts);
  const upload = await loadResumedEvalArtifacts(root, state, contracts, { controllerRuntime: controller, transport: "upload" });
  assert.deepEqual(plain, upload);
  assert.equal(upload.primary.artifact_id, artifact.artifact_id);
  assert.equal(upload.primary.sharedRuntime, undefined);
  assert.equal(upload.assignments[0]!.artifact, upload.artifactsById.get(artifact.artifact_id));
  assert.equal(JSON.stringify(state), frozen);
  await assert.rejects(loadResumedEvalArtifacts(root, state, contracts, {
    controllerRuntime: { ...controller, runtime_id: `sha256:${"f".repeat(64)}` }, transport: "readonly-bind", directory: path.join(root, "shared"),
  }), /frozen controller/);
  await writeFile(path.join(artifact.directory, "entry.js"), "changed cache\n");
  await assert.rejects(loadResumedEvalArtifacts(root, state, contracts), /integrity|verification/);
});

test("resumed readonly-bind execution snapshots saved artifacts and the frozen controller", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-resumed-shared-runtime-"));
  t.after(() => forceRemove(root));
  const { artifact, state, contracts, controller } = await fixture(root);
  const frozen = JSON.stringify(state);
  const resumed = await loadResumedEvalArtifacts(root, state, contracts, {
    controllerRuntime: controller, transport: "readonly-bind", directory: path.join(root, "eval", "shared-runtime"),
  });
  const shared = resumed.primary.sharedRuntime!;
  assert.ok(shared);
  assert.notEqual(shared.artifact_directory, artifact.directory);
  assert.notEqual(shared.runtime_directory, controller.directory);
  assert.equal(resumed.assignments[0]!.artifact, resumed.primary);
  assert.equal(resumed.artifactsById.get(artifact.artifact_id), resumed.primary);
  assert.deepEqual(preparedArtifactSummary(resumed.primary), preparedArtifactSummary(artifact));
  assert.equal(JSON.stringify(state), frozen);
  await writeFile(path.join(artifact.directory, "entry.js"), "changed original cache\n");
  await verifyPreparedArtifact(shared.artifact_directory, artifact);
  await useControllerRuntimeDirectory(shared.runtime_directory, controller.runtime_id);
  assert.match(await readFile(path.join(shared.artifact_directory, "entry.js"), "utf8"), /offline harness OK/);
});
