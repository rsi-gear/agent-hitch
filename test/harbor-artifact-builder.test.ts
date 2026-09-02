import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { harborTrialRuntimeContract } from "../src/backends/index.js";
import { ensureControllerRuntime } from "../src/controller-runtime/index.js";
import { prepareHarborArtifact } from "../src/evals/index.js";
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
