import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { artifactMatches } from "../src/artifacts/index.js";
import { attachHarborNodeRuntime, prepareHarborNodeRuntime, verifyHarborNodeRuntime } from "../src/evals/harbor-node-runtime.js";
import { forceRemove } from "../test-support/helpers.js";
import { nodeRuntimeHarnessFixture } from "../test-support/harbor-node-runtime-fixture.js";

test("offline Node cache is target-pinned, single-flight, content verified and repairs corrupt entries", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-node-runtime-test-"));
  t.after(() => forceRemove(root));
  const log = path.join(root, "docker.jsonl");
  const docker = path.join(root, "docker-fixture");
  await writeFile(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'cp') fs.writeFileSync(args.at(-1), 'offline archive fixture');
else if (!['run', 'rm'].includes(args[0])) process.exit(1);
`, { mode: 0o755 });
  await chmod(docker, 0o755);
  const builder = {
    reference: "mutable-tag-never-executed", id: `sha256:${"a".repeat(64)}`,
    dockerPlatform: "linux/amd64", artifactPlatform: "linux-x64",
  };
  const input = { root, docker, builder, env: process.env };
  const runtimes = await Promise.all(Array.from({ length: 4 }, () => prepareHarborNodeRuntime(input)));
  assert.equal(new Set(runtimes.map((runtime) => runtime.manifest.runtime_id)).size, 1);
  const first = runtimes[0]!;
  const commands = () => readFile(log, "utf8").then((body) => body.trim().split("\n").map((line) => JSON.parse(line) as string[]));
  const calls = await commands();
  const runs = calls.filter((args) => args[0] === "run");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]![runs[0]!.indexOf("--network") + 1], "none");
  assert.equal(runs[0]![runs[0]!.indexOf("--platform") + 1], "linux/amd64");
  assert.ok(runs[0]!.includes(builder.id));
  assert.equal(runs[0]!.includes(builder.reference), false);
  assert.match(runs[0]!.at(-1)!, /getconf GNU_LIBC_VERSION/);
  assert.doesNotMatch(runs[0]!.at(-1)!, /curl|wget|nvm|npm install/);
  assert.equal(first.manifest.node_version, "v22.23.0");
  assert.equal(first.manifest.libc, "glibc");
  await assert.rejects(verifyHarborNodeRuntime(first.directory, { platform: "linux-arm64" }), /checksum mismatch/);

  await writeFile(path.join(first.directory, "node-runtime.tar.gz"), "corrupted archive");
  await assert.rejects(verifyHarborNodeRuntime(first.directory, {}), /checksum mismatch/);
  const repaired = await prepareHarborNodeRuntime(input);
  assert.equal(repaired.manifest.runtime_id, first.manifest.runtime_id);
  assert.equal((await commands()).filter((args) => args[0] === "run").length, 2);
  assert.equal((await readdir(path.join(root, "store/harbor-artifacts/node-runtimes/invalid"))).length, 1);
  assert.deepEqual(await readdir(path.join(root, "store/harbor-artifacts/node-runtimes/tmp")), []);

  const arm = await prepareHarborNodeRuntime({ ...input, builder: { ...builder, dockerPlatform: "linux/arm64", artifactPlatform: "linux-arm64" } });
  assert.notEqual(arm.manifest.runtime_id, repaired.manifest.runtime_id);
  assert.notEqual(arm.directory, repaired.directory);
  const changedImage = await prepareHarborNodeRuntime({ ...input, builder: { ...builder, id: `sha256:${"b".repeat(64)}` } });
  assert.notEqual(changedImage.manifest.runtime_id, repaired.manifest.runtime_id);

  const { directory: source, manifest } = await nodeRuntimeHarnessFixture(root);
  // Composition must produce a new artifact and keep the entrypoint pin.
  const composed = await attachHarborNodeRuntime(source, manifest, repaired);
  assert.notEqual(composed.manifest.artifact_id, manifest.artifact_id);
  assert.notEqual(composed.manifest.artifact_integrity, manifest.artifact_integrity);
  assert.equal(composed.manifest.entrypoint_integrity, manifest.entrypoint_integrity);
  assert.equal(await artifactMatches(composed.directory, composed.manifest), true);
  await writeFile(path.join(composed.directory, ".hitch-node-runtime/node-runtime.json"), "{}");
  assert.equal(await artifactMatches(composed.directory, composed.manifest), false);
});

test("failed Node export never publishes a cache reference or leaves partial staging", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-node-export-failure-"));
  t.after(() => forceRemove(root));
  const docker = path.join(root, "fake-docker");
  await writeFile(docker, "#!/usr/bin/env node\nprocess.exit(process.argv[2] === 'rm' ? 0 : 17)\n", { mode: 0o755 });
  await assert.rejects(prepareHarborNodeRuntime({
    root, docker, env: process.env,
    builder: { reference: "unused", id: `sha256:${"a".repeat(64)}`, dockerPlatform: "linux/amd64", artifactPlatform: "linux-x64" },
  }), (error: unknown) => (error as { code?: string }).code === "harbor_node_runtime_prepare_failed");
  for (const name of ["refs", "artifacts", "tmp", "locks"]) {
    assert.deepEqual(await readdir(path.join(root, "store/harbor-artifacts/node-runtimes", name)), []);
  }
});

test("Harbor bridge selects offline Node without network and rejects corrupt or incompatible runtimes", () => {
  const result = spawnSync("python3", ["test-support/harbor_node_runtime_smoke.py"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /OK/);
});
