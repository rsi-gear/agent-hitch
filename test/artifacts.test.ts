import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { listPreparedArtifacts, prepareHarness, resolveHarness } from "../src/artifacts.js";
import { executeRun, newRunId } from "../src/engine.js";
import { readJSON } from "../src/fs.js";
import { parseHarnessReference } from "../src/harness-reference.js";
import { fakePiSource, writeFakeDeepseekNpm, writeFakeNpm } from "../test-support/helpers.js";
import type { RunRequestInput } from "../src/engine.js";

const exec = promisify(execFile);

function request(overrides: Partial<RunRequestInput> = {}): RunRequestInput {
  const base: RunRequestInput = { cwd: process.cwd(), prompt: "x", timeout_ms: 5_000, agent_args: [] };
  if (!overrides.harness_ref) (base as { agent?: string }).agent = "codex";
  return { ...base, ...overrides };
}

test("harness references use explicit selectors and keep bare names installed-compatible", () => {
  assert.deepEqual(parseHarnessReference("codex").selector, { type: "installed" });
  assert.equal(parseHarnessReference("codex").canonical, "codex@installed");
  assert.deepEqual(parseHarnessReference("codex@version:1.2.3-beta.1").selector, {
    type: "version",
    value: "1.2.3-beta.1",
  });
  const selector = parseHarnessReference("codex@commit:ABCDEF1").selector;
  assert.equal(selector.type === "commit" ? selector.value : "", "abcdef1");
  assert.throws(() => parseHarnessReference("codex@latest"), /unsupported harness selector/);
  assert.throws(() => parseHarnessReference("codex@version:^1.2.3"), /exact semantic version/);
});

test("exact package versions resolve by integrity, prepare once, and run from the cached artifact", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-version-"));
  const fakeNpm = await writeFakeNpm(root);
  const previous = process.env.HITCH_NPM_PATH;
  process.env.HITCH_NPM_PATH = fakeNpm;
  t.after(() => restoreEnv("HITCH_NPM_PATH", previous));

  const resolved = await resolveHarness("pi@version:1.2.3", { root });
  assert.equal(resolved.revision.version, "1.2.3");
  assert.equal(resolved.source.integrity, "sha512-fake-integrity");
  assert.match(resolved.identity, /^sha256:/);

  const first = await prepareHarness(resolved, { root });
  const second = await prepareHarness(resolved, { root });
  assert.equal(first.cache_hit, false);
  assert.equal(second.cache_hit, true);
  assert.equal(second.artifact_id, first.artifact_id);

  const storedEntrypoint = first.entrypoint_args[0] || first.executable;
  const storedPackage = path.resolve(path.dirname(storedEntrypoint), "..", "package.json");
  await writeFile(storedPackage, `${JSON.stringify({ tampered: true })}\n`);
  const dependencyRepaired = await prepareHarness(resolved, { root });
  assert.equal(dependencyRepaired.cache_hit, false);
  assert.equal(dependencyRepaired.artifact_id, first.artifact_id);

  await writeFile(storedEntrypoint, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const repaired = await prepareHarness(resolved, { root });
  assert.equal(repaired.cache_hit, false);
  assert.equal(repaired.artifact_id, first.artifact_id);
  const listed = await listPreparedArtifacts("pi", { root });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.status, "ready");
  assert.equal(listed[0]?.resolved_revision.revision.version, "1.2.3");

  const runId = newRunId();
  const result = await executeRun({
    runId,
    root,
    runsRoot: path.join(root, "runs"),
    request: request({ harness_ref: "pi@version:1.2.3", cwd: root, prompt: "versioned", timeout_ms: 5_000 }),
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "reply:versioned");
  const manifest = await readJSON<Record<string, unknown>>(path.join(root, "runs", runId, "manifest.json"));
  assert.equal(manifest.artifact_id, first.artifact_id);
  assert.equal((manifest.resolved_revision as { source: { type: string } }).source.type, "npm");
});

test("DeepSeek versions use an integrity-checked isolated global npm prefix", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-deepseek-version-"));
  const fakeNpm = await writeFakeDeepseekNpm(root);
  const previous = process.env.HITCH_NPM_PATH;
  process.env.HITCH_NPM_PATH = fakeNpm;
  t.after(() => restoreEnv("HITCH_NPM_PATH", previous));

  const resolved = await resolveHarness("deepseek@version:0.1.0-rc.7", { root });
  const artifact = await prepareHarness(resolved, { root });

  assert.equal(artifact.observed_version, "0.1.0-rc.7");
  assert.match(artifact.entrypoint, /^lib\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js$/);
  const invocations = (await readFile(path.join(root, "fake-dsh-npm.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(invocations.some((args) => args[0] === "pack"), true);
  assert.equal(invocations.some((args) => args[0] === "install" && args.includes("--global") && args.includes("--prefix")), true);
  assert.equal(invocations.some((args) => args[0] === "install" && args.includes("--save-exact")), false);
});

test("a clean local Git commit expands to a full SHA and produces an immutable runnable artifact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-commit-"));
  const source = path.join(root, "pi-source");
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(source);
  await mkdir(workspace);
  await writeFile(path.join(source, "package.json"), `${JSON.stringify({
    name: "fake-pi-source",
    version: "1.0.0",
    private: true,
    scripts: { build: "node build.js" },
  }, null, 2)}\n`);
  await writeFile(path.join(source, "package-lock.json"), `${JSON.stringify({
    name: "fake-pi-source",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "fake-pi-source", version: "1.0.0" } },
  }, null, 2)}\n`);
  const builtSource = fakePiSource("1.0.0");
  await writeFile(path.join(source, "build.js"), `
const fs = require("node:fs");
const path = require("node:path");
const output = path.join(process.cwd(), "packages", "coding-agent", "dist", "cli.js");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, ${JSON.stringify(builtSource)}, { mode: 0o755 });
`);
  await exec("git", ["init", source]);
  await exec("git", ["-C", source, "config", "user.email", "hitch@example.test"]);
  await exec("git", ["-C", source, "config", "user.name", "Hitch Test"]);
  await exec("git", ["-C", source, "add", "."]);
  await exec("git", ["-C", source, "commit", "-m", "fake pi"]);
  const { stdout } = await exec("git", ["-C", source, "rev-parse", "HEAD"]);
  const commit = stdout.trim();
  const reference = `pi@git+${pathToFileURL(source).href}#${commit.slice(0, 10)}`;

  const resolved = await resolveHarness(reference, { root: stateRoot });
  assert.equal(resolved.revision.commit, commit);
  assert.equal(resolved.source.registered, false);
  const artifact = await prepareHarness(resolved, { root: stateRoot });
  await chmod(artifact.entrypoint_args[0] || artifact.executable, 0o755);

  const runId = newRunId();
  const result = await executeRun({
    runId,
    root: stateRoot,
    resolvedRevision: resolved,
    runsRoot: path.join(stateRoot, "runs"),
    request: request({ harness_ref: reference, cwd: workspace, prompt: "committed", timeout_ms: 5_000 }),
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "reply:committed");
  const manifest = await readJSON<Record<string, unknown>>(path.join(stateRoot, "runs", runId, "manifest.json"));
  assert.equal((manifest.resolved_revision as { revision: { commit: string } }).revision.commit, commit);
  assert.equal(manifest.artifact_id, artifact.artifact_id);

  await writeFile(path.join(source, "dirty.txt"), "not committed\n");
  await assert.rejects(
    resolveHarness(reference, { root: stateRoot }),
    (error: unknown) => {
      const typed = error as { code?: string; exitCode?: number };
      return typed.code === "dirty_source" && typed.exitCode === 11;
    },
  );
});

test("commit selection fails explicitly for harnesses without a source-build contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-unsupported-"));
  await assert.rejects(
    resolveHarness("claude@commit:abcdef1", { root }),
    (error: unknown) => {
      const typed = error as { code?: string; exitCode?: number };
      return typed.code === "revision_selector_unsupported" && typed.exitCode === 10;
    },
  );
});

test("package preparation rejects bytes that do not match the resolved integrity", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-integrity-"));
  const fakeNpm = await writeFakeNpm(root, { installedIntegrity: "sha512-different" });
  const previous = process.env.HITCH_NPM_PATH;
  process.env.HITCH_NPM_PATH = fakeNpm;
  t.after(() => restoreEnv("HITCH_NPM_PATH", previous));
  const resolved = await resolveHarness("pi@version:1.2.3", { root });
  await assert.rejects(
    prepareHarness(resolved, { root }),
    (error: unknown) => {
      const typed = error as { code?: string; exitCode?: number };
      return typed.code === "artifact_integrity_mismatch" && typed.exitCode === 5;
    },
  );
});

test("run cancellation interrupts artifact preparation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-prepare-cancel-"));
  const fakeNpm = await writeFakeNpm(root, { installDelayMs: 2_000 });
  const previous = process.env.HITCH_NPM_PATH;
  process.env.HITCH_NPM_PATH = fakeNpm;
  t.after(() => restoreEnv("HITCH_NPM_PATH", previous));
  const controller = new AbortController();
  const execution = executeRun({
    runId: newRunId(),
    root,
    runsRoot: path.join(root, "runs"),
    request: request({ harness_ref: "pi@version:1.2.3", cwd: root, prompt: "cancel", timeout_ms: 5_000 }),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 250);
  const result = await execution;
  assert.equal(result.status, "cancelled");
  assert.equal(result.exit_code, 9);
  assert.equal((result.error as { code: string }).code, "cancelled");
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
