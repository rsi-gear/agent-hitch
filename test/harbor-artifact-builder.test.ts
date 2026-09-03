import test from "node:test";
import assert from "node:assert/strict";
import { nodeRuntimeHarnessFixture } from "../test-support/harbor-node-runtime-fixture.js";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { harborTrialRuntimeContract } from "../src/backends/index.js";
import { ensureControllerRuntime } from "../src/controller-runtime/index.js";
import { loadHarborArtifact, prepareHarborArtifact } from "../src/evals/index.js";
import { forceRemove } from "../test-support/helpers.js";

test("artifact builder uses the planner contract instead of host or environment platform", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-builder-contract-"));
  t.after(() => forceRemove(root));
  const log = path.join(root, "docker-argv.jsonl");
  const docker = path.join(root, "fake-docker");
  await writeFile(docker, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "image" && args[1] === "inspect") {
  process.stdout.write(JSON.stringify({
    Id: "sha256:" + "a".repeat(64),
    Os: "linux",
    Architecture: "amd64",
    Config: { Labels: {
      "io.hitch.harbor-artifact-builder.recipe": "1",
      "io.hitch.harbor-artifact-builder.node": "v22.23.0",
      "io.hitch.harbor-artifact-builder.pnpm": "10.17.1"
    }}
  }) + "\\n");
  process.exit(0);
}
if (args[0] === "rm") process.exit(0);
process.stderr.write("intentional builder stop\\n");
process.exit(17);
`, { mode: 0o755 });
  await chmod(docker, 0o755);
  const runtime = await ensureControllerRuntime({ root });
  await assert.rejects(prepareHarborArtifact({
    root,
    resolvedRevision: {
      schema_version: "1",
      requested_ref: "pi@version:1.2.3",
      canonical_ref: "pi@version:1.2.3",
      harness_id: "pi",
      selector: { type: "version", value: "1.2.3" },
      source: { type: "npm", package: "@mariozechner/pi-coding-agent" },
      revision: { type: "version", version: "1.2.3" },
      identity: `sha256:${"b".repeat(64)}`,
      resolved_at: "2026-09-01T00:00:00.000Z",
    },
    runtimeDirectory: runtime.directory,
    runtimeId: runtime.runtime_id,
    runtimeContract: harborTrialRuntimeContract("linux/amd64"),
    env: { ...process.env, HITCH_DOCKER_PATH: docker, HITCH_HARBOR_BUILDER_PLATFORM: "linux/arm64" },
  }), (error: unknown) => (error as { code?: string }).code === "harbor_artifact_build_failed");
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.equal(calls.some((args) => args[0] === "info"), false);
  const run = calls.find((args) => args[0] === "run");
  assert.ok(run);
  assert.equal(run[run.indexOf("--platform") + 1], "linux/amd64");
});

test("artifact preparation seals offline Node and reruns reload the same content-pinned bundle", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-builder-offline-"));
  t.after(() => forceRemove(root));
  const fixture = await nodeRuntimeHarnessFixture(root);
  const docker = path.join(root, "fake-docker");
  const log = path.join(root, "calls.jsonl");
  await writeFile(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'image') {
  process.stdout.write(JSON.stringify({ Id: 'sha256:' + 'a'.repeat(64), Os: 'linux', Architecture: 'amd64', Config: { Labels: {
    'io.hitch.harbor-artifact-builder.recipe': '1', 'io.hitch.harbor-artifact-builder.node': 'v22.23.0', 'io.hitch.harbor-artifact-builder.pnpm': '10.17.1'
  }}}));
} else if (args[0] === 'run') {
  if (!args.includes('--network')) process.stdout.write(JSON.stringify({ artifact: { artifact_id: ${JSON.stringify(fixture.manifest.artifact_id)} } }));
} else if (args[0] === 'cp') {
  if (args[1].endsWith('/tmp/node-runtime.tar.gz')) fs.writeFileSync(args[2], 'offline runtime fixture');
  else fs.cpSync(${JSON.stringify(fixture.directory)}, path.join(args[2], ${JSON.stringify(path.basename(fixture.directory))}), { recursive: true });
} else if (args[0] !== 'rm') process.exit(1);
`, { mode: 0o755 });
  const runtime = await ensureControllerRuntime({ root });
  const input = {
    root, resolvedRevision: fixture.manifest.resolved_revision,
    runtimeDirectory: runtime.directory, runtimeId: runtime.runtime_id,
    runtimeContract: harborTrialRuntimeContract("linux/amd64"), env: { ...process.env, HITCH_DOCKER_PATH: docker },
  };
  const first = await prepareHarborArtifact(input);
  assert.equal(first.cacheHit, false);
  assert.notEqual(first.artifact.artifact_id, fixture.manifest.artifact_id);
  const second = await prepareHarborArtifact(input);
  assert.equal(second.cacheHit, true);
  assert.deepEqual(second.artifact, first.artifact);
  assert.deepEqual(await loadHarborArtifact(root, first.artifact), first.artifact);
  assert.equal(await readFile(path.join(first.artifact.directory, ".hitch-node-runtime/node-runtime.tar.gz"), "utf8"), "offline runtime fixture");
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.equal(calls.filter((args) => args[0] === "run").length, 2); // one harness build, one shared Node export
});
