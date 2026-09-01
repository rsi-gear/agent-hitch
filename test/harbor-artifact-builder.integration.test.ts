import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveHarness } from "../src/artifacts/index.js";
import { buildLocalGitTransport } from "../src/backends/index.js";
import { harborTrialRuntimeContract } from "../src/backends/index.js";
import { ensureControllerRuntime } from "../src/controller-runtime/index.js";
import {
  DEFAULT_HARBOR_ARTIFACT_BUILDER_BASE_IMAGE,
  HARBOR_NODE_VERSION_WITH_PREFIX,
  HARBOR_PNPM_VERSION,
  harborArtifactDirectory,
  prepareHarborArtifact,
} from "../src/evals/index.js";
import { readJSON, runCommand } from "../src/foundation/index.js";
import { forceRemove } from "../test-support/helpers.js";

test("a cold DeepSeek commit build uses the dedicated builder and runs in a real task image without pnpm", { timeout: 20 * 60 * 1_000 }, async (t) => {
  const docker = process.env.HITCH_DOCKER_PATH?.trim() || "docker";
  try {
    await runCommand(docker, ["info"], { timeoutMs: 30_000, failureCode: "docker_unavailable", failureExitCode: 12 });
  } catch {
    t.skip("Docker is unavailable");
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), "hitch-harbor-builder-integration-"));
  const source = path.join(root, "deepseek-source");
  const evalDirectory = path.join(root, "eval-input");
  const taskContext = path.join(root, "task-image");
  const taskImage = `hitch-harbor-no-pnpm-test:${process.pid}-${Date.now()}`;
  t.after(async () => {
    await runCommand(docker, ["image", "rm", "--force", taskImage], { timeoutMs: 30_000 }).catch(() => {});
    await forceRemove(root);
  });

  await Promise.all([mkdir(source, { recursive: true }), mkdir(evalDirectory, { recursive: true }), mkdir(taskContext, { recursive: true })]);
  await writeFile(path.join(source, "package.json"), `${JSON.stringify({
    name: "deepseek-builder-fixture",
    version: "0.0.0",
    private: true,
    packageManager: `pnpm@${HARBOR_PNPM_VERSION}`,
    scripts: { build: "node build.mjs" },
  }, null, 2)}\n`);
  await writeFile(path.join(source, "pnpm-lock.yaml"), [
    "lockfileVersion: '9.0'",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "importers:",
    "  .: {}",
    "",
  ].join("\n"));
  await writeFile(path.join(source, "build.mjs"), [
    "import { chmod, mkdir, writeFile } from 'node:fs/promises';",
    "await mkdir('apps/cli/lib', { recursive: true });",
    "const file = 'apps/cli/lib/bin.js';",
    "await writeFile(file, `#!/usr/bin/env node\\nif (process.argv.includes('--version')) process.stdout.write('dsh 0.0.0\\\\n');\\nelse process.stdout.write('ok\\\\n');\\n`);",
    "await chmod(file, 0o755);",
    "",
  ].join("\n"));
  await runCommand("git", ["init", source]);
  await runCommand("git", ["-C", source, "config", "user.email", "builder-test@example.invalid"]);
  await runCommand("git", ["-C", source, "config", "user.name", "Builder Test"]);
  await runCommand("git", ["-C", source, "add", "."]);
  await runCommand("git", ["-C", source, "commit", "-m", "fixture"]);
  const commit = (await runCommand("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  const reference = `deepseek@git+${pathToFileURL(source).href}#${commit}`;
  const resolvedRevision = await resolveHarness(reference, { root });
  const localTransport = await buildLocalGitTransport({ evalDirectory, resolvedRevision, sourceDirectory: source });
  const runtime = await ensureControllerRuntime({ root });

  const first = await prepareHarborArtifact({
    root,
    resolvedRevision,
    runtimeDirectory: runtime.directory,
    runtimeId: runtime.runtime_id,
    runtimeContract: harborTrialRuntimeContract("linux/amd64"),
    localTransport,
    env: process.env,
  });
  assert.equal(first.source, "dedicated-builder");
  assert.equal(first.cacheHit, false);
  assert.equal(first.artifact.node_version, HARBOR_NODE_VERSION_WITH_PREFIX);
  assert.equal(first.artifact.directory, harborArtifactDirectory(root, first.artifact.artifact_id));
  const manifest = await readJSON<{ toolchain: Record<string, string>; entrypoint: string }>(path.join(first.artifact.directory, "artifact.json"));
  assert.equal(manifest.toolchain.pnpm, HARBOR_PNPM_VERSION);

  const second = await prepareHarborArtifact({
    root,
    resolvedRevision,
    runtimeDirectory: runtime.directory,
    runtimeId: runtime.runtime_id,
    runtimeContract: harborTrialRuntimeContract("linux/amd64"),
    localTransport,
    env: process.env,
  });
  assert.equal(second.cacheHit, true);
  assert.equal(second.artifact.artifact_id, first.artifact.artifact_id);

  await writeFile(path.join(taskContext, "Dockerfile"), [
    `FROM ${DEFAULT_HARBOR_ARTIFACT_BUILDER_BASE_IMAGE}`,
    "RUN npm uninstall --global pnpm >/dev/null 2>&1 || true; rm -f /usr/local/bin/pnpm /usr/local/bin/pnpx; ! command -v pnpm",
    "ENTRYPOINT []",
    "",
  ].join("\n"));
  const dockerPlatform = first.artifact.platform === "linux-x64" ? "linux/amd64" : "linux/arm64";
  await runCommand(docker, ["build", "--platform", dockerPlatform, "--tag", taskImage, taskContext], { timeoutMs: 10 * 60 * 1_000 });
  const execution = await runCommand(docker, [
    "run", "--rm", "--platform", dockerPlatform,
    "--mount", `type=bind,source=${path.resolve(first.artifact.directory)},target=/artifact,readonly`,
    taskImage,
    "sh", "-ceu",
    `! command -v pnpm; test "$(node -p process.version)" = "${HARBOR_NODE_VERSION_WITH_PREFIX}"; node "/artifact/$1" --version`,
    "sh", manifest.entrypoint,
  ], { timeoutMs: 60_000 });
  assert.match(execution.stdout, /dsh 0\.0\.0/);
  assert.doesNotMatch(await readFile(path.join(taskContext, "Dockerfile"), "utf8"), /pnpm install|pnpm run build/);
});
