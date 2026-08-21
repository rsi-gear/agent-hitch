import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveHarness } from "../src/artifacts.js";
import { newEvalId, runEval } from "../src/evals.js";
import { readJSON } from "../src/fs.js";
import {
  buildLocalGitTransport,
  validateLocalGitTransportManifest,
  verifyLocalGitTransport,
  verifyMaterializedLocalGitSource,
} from "../src/local-git-transport.js";
import { forceRemove, writeFakeHarbor } from "../test-support/helpers.js";

const exec = promisify(execFile);

test("local Git transport contains only exact commit objects and preserves its proof", async (t) => {
  const fixture = await localRepository("hitch local source 空格 ");
  t.after(() => forceRemove(fixture.root));
  await exec("git", ["-C", fixture.source, "config", "credential.helper", "host-secret-helper"]);
  await writeFile(path.join(fixture.source, "untracked-secret.txt"), "must-not-enter-transport\n");
  // Transport construction consumes Git objects, not the worktree. runEval's
  // existing resolve step is what enforces a clean source before this seam.
  const transport = await buildLocalGitTransport({
    evalDirectory: fixture.evalDirectory,
    resolvedRevision: fixture.resolution,
    sourceDirectory: fixture.source,
  });
  assert.equal(transport.manifest.commit, fixture.commit);
  assert.equal(transport.manifest.tree, fixture.tree);
  assert.match(transport.manifest.payload_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.ok(transport.manifest.object_count >= 3);
  assert.equal(transport.manifest.file_count, 3);
  const payload = await readFile(transport.payloadPath);
  assert.equal(payload.includes(Buffer.from("must-not-enter-transport")), false);
  assert.equal(payload.includes(Buffer.from("host-secret-helper")), false);
  await verifyLocalGitTransport(transport, {
    expected: {
      harnessId: fixture.resolution.harness_id,
      resolutionIdentity: fixture.resolution.identity,
      commit: fixture.commit,
    },
  });

  const materialized = path.join(fixture.root, "materialized.git");
  await exec("git", ["init", "--bare", materialized]);
  const indexed = spawnSync("git", ["-C", materialized, "index-pack", "--stdin"], {
    input: payload,
    encoding: "utf8",
  });
  assert.equal(indexed.status, 0, indexed.stderr || undefined);
  await writeFile(path.join(materialized, "shallow"), `${fixture.commit}\n`);
  await exec("git", ["-C", materialized, "update-ref", "refs/heads/hitch-local", fixture.commit]);
  const verified = await verifyMaterializedLocalGitSource({
    directory: materialized,
    manifest: transport.manifest,
    resolution: fixture.resolution,
  });
  assert.equal(verified.commit, fixture.commit);
  assert.equal(verified.tree, fixture.tree);
  const absentHistory = spawnSync("git", ["-C", materialized, "cat-file", "-e", `${fixture.previousCommit}^{commit}`]);
  assert.notEqual(absentHistory.status, 0, "the transport must not include ancestor history");
  const checkout = path.join(fixture.root, "checkout");
  await exec("git", ["clone", "--no-hardlinks", "--no-checkout", materialized, checkout]);
  await exec("git", ["-C", checkout, "checkout", "--detach", fixture.commit]);
  assert.equal((await lstat(path.join(checkout, "link.txt"))).isSymbolicLink(), true);
  assert.equal((await lstat(path.join(checkout, "executable.sh"))).mode & 0o111, 0o111);
});

test("local Git transport fails closed on payload, manifest, commit, tree, and size mismatches", async (t) => {
  const fixture = await localRepository("hitch-local-integrity-");
  t.after(() => forceRemove(fixture.root));
  const transport = await buildLocalGitTransport({
    evalDirectory: fixture.evalDirectory,
    resolvedRevision: fixture.resolution,
    sourceDirectory: fixture.source,
  });
  const originalPayload = await readFile(transport.payloadPath);
  const originalManifest = transport.manifest;

  await writeFile(transport.payloadPath, Buffer.concat([originalPayload, Buffer.from("tamper")]));
  await assert.rejects(verifyLocalGitTransport(transport), /payload size|payload digest/);
  await writeFile(transport.payloadPath, originalPayload);

  const wrongTree = `${originalManifest.tree[0] === "0" ? "1" : "0"}${originalManifest.tree.slice(1)}`;
  await writeFile(transport.manifestPath, `${JSON.stringify({ ...originalManifest, tree: wrongTree }, null, 2)}\n`);
  await assert.rejects(verifyLocalGitTransport(transport), /does not contain the locked commit and tree/);
  await writeFile(transport.manifestPath, `${JSON.stringify(originalManifest, null, 2)}\n`);

  await assert.rejects(
    verifyLocalGitTransport(transport, {
      expected: { harnessId: fixture.resolution.harness_id, resolutionIdentity: fixture.resolution.identity, commit: "f".repeat(40) },
    }),
    /commit does not match/,
  );
  assert.throws(
    () => validateLocalGitTransportManifest({ ...originalManifest, payload_sha256: "sha256:bad" }),
    /payload_sha256/,
  );

  const limitedEval = path.join(fixture.root, "limited-eval");
  await mkdir(limitedEval, { recursive: true });
  await assert.rejects(
    buildLocalGitTransport({
      evalDirectory: limitedEval,
      resolvedRevision: fixture.resolution,
      sourceDirectory: fixture.source,
      limits: { maxPayloadBytes: 1, maxObjects: 100, maxFiles: 100, maxFileBytes: 1024 },
    }),
    /payload limit/,
  );
  assert.equal((await readdir(limitedEval)).some((name) => name.startsWith(".local-source-")), false);

  const abortedEval = path.join(fixture.root, "aborted-eval");
  await mkdir(abortedEval);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    buildLocalGitTransport({
      evalDirectory: abortedEval,
      resolvedRevision: fixture.resolution,
      sourceDirectory: fixture.source,
      signal: controller.signal,
    }),
    (error: unknown) => (error as { code?: string }).code === "cancelled",
  );
  assert.deepEqual(await readdir(abortedEval), []);
});

test("Harbor eval records and hands off a local exact commit transport", async (t) => {
  const fixture = await localRepository("hitch-local-eval-");
  t.after(() => forceRemove(fixture.root));
  const harbor = await writeFakeHarbor(fixture.root);
  const evalId = newEvalId();
  const result = await runEval({
    evalId,
    root: fixture.stateRoot,
    harborExecutable: harbor,
    request: {
      dataset: "demo@1.0",
      harness_ref: `pi@git+${pathToFileURL(fixture.source).href}#${fixture.commit}`,
      timeout_ms: 5_000,
    },
  });
  assert.equal(result.status, "succeeded");
  const evalDirectory = path.join(fixture.stateRoot, "evals", evalId);
  const plan = await readJSON<Record<string, unknown>>(path.join(evalDirectory, "plan.json"));
  const summary = plan.local_source_transport as Record<string, unknown>;
  assert.equal(summary.commit, fixture.commit);
  assert.equal(summary.tree, fixture.tree);
  assert.match(summary.payload_sha256 as string, /^sha256:[0-9a-f]{64}$/);
  const job = await readJSON<Record<string, unknown>>(path.join(evalDirectory, "harbor", "job.json"));
  const agent = (job.agents as Record<string, unknown>[])[0] as Record<string, unknown>;
  const kwargs = agent.kwargs as Record<string, unknown>;
  const handoff = kwargs.local_source_transport as Record<string, unknown>;
  assert.equal(handoff.commit, fixture.commit);
  assert.equal(handoff.resolution_identity, (plan.candidate as Record<string, unknown>).revision_identity);
  assert.equal(handoff.payload_sha256, summary.payload_sha256);
  assert.equal((result.local_source_transport as Record<string, unknown>).commit, fixture.commit);
  const events = await readFile(path.join(evalDirectory, "events.jsonl"), "utf8");
  assert.match(events, /eval\.local-source\.prepared/);

  const materializeFailureHarbor = await writeMaterializeFailureHarbor(fixture.root);
  const materializeFailure = await runEval({
    root: fixture.stateRoot,
    harborExecutable: materializeFailureHarbor,
    request: {
      dataset: "demo@1.0",
      harness_ref: `pi@git+${pathToFileURL(fixture.source).href}#${fixture.commit}`,
    },
  });
  assert.equal(materializeFailure.status, "failed");
  assert.equal((materializeFailure.error as { code: string }).code, "local_source_materialize_failed");

  await writeFile(path.join(fixture.source, "dirty-untracked.txt"), "not committed\n");
  const rejected = await runEval({
    root: fixture.stateRoot,
    harborExecutable: harbor,
    request: {
      dataset: "demo@1.0",
      harness_ref: `pi@git+${pathToFileURL(fixture.source).href}#${fixture.commit}`,
    },
  });
  assert.equal((rejected.error as { code: string }).code, "dirty_source");
  assert.equal(rejected.exit_code, 11);
});

test("Harbor bridge verifies, uploads, and reuses the same locked local source", async (t) => {
  const fixture = await localRepository("hitch-local-bridge-");
  t.after(() => forceRemove(fixture.root));
  const transport = await buildLocalGitTransport({
    evalDirectory: fixture.evalDirectory,
    resolvedRevision: fixture.resolution,
    sourceDirectory: fixture.source,
  });
  const { ensureControllerRuntime } = await import("../src/controller-runtime/store.js");
  const runtime = await ensureControllerRuntime({ root: fixture.stateRoot });
  const smoke = path.resolve("test-support", "local_transport_bridge_smoke.py");
  const bridge = path.resolve("integrations", "harbor", "hitch_harbor_agent.py");
  const result = spawnSync("python3", [smoke, bridge, runtime.directory, transport.directory, path.join(fixture.root, "logs")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || undefined);
  assert.match(result.stdout, /local transport bridge smoke OK/);
});

test("Git commands without input do not receive a writable stdin pipe", async (t) => {
  const fixture = await localRepository("hitch-local-stdin-");
  t.after(() => forceRemove(fixture.root));
  const fakeGit = path.join(fixture.root, "fake-git-no-stdin");
  await writeFile(fakeGit, `#!/usr/bin/env node
const fs = require("node:fs");
if (!fs.fstatSync(0).isCharacterDevice()) {
  process.stderr.write("unexpected writable stdin pipe\\n");
  process.exit(91);
}
const revision = process.argv.at(-1) || "";
if (revision.endsWith("^{commit}")) process.stdout.write("${fixture.commit}\\n");
else if (revision.endsWith("^{tree}")) process.stdout.write("${fixture.tree}\\n");
else process.exit(92);
`, { mode: 0o755 });

  const verified = await verifyMaterializedLocalGitSource({
    directory: fixture.source,
    manifest: {
      schema_version: "1",
      kind: "local-git-commit",
      harness_id: fixture.resolution.harness_id,
      resolution_identity: fixture.resolution.identity,
      commit: fixture.commit,
      tree: fixture.tree,
      payload_sha256: `sha256:${"0".repeat(64)}`,
      payload_bytes: 0,
      object_count: 0,
      file_count: 0,
      created_at: new Date().toISOString(),
    },
    resolution: fixture.resolution,
    env: { ...process.env, HITCH_GIT_PATH: fakeGit },
  });
  assert.equal(verified.commit, fixture.commit);
  assert.equal(verified.tree, fixture.tree);
});

async function localRepository(prefix: string): Promise<{
  root: string;
  source: string;
  stateRoot: string;
  evalDirectory: string;
  commit: string;
  tree: string;
  previousCommit: string;
  resolution: Awaited<ReturnType<typeof resolveHarness>>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const source = path.join(root, "repo with 空格");
  const stateRoot = path.join(root, "state");
  const evalDirectory = path.join(root, "eval");
  await mkdir(source, { recursive: true });
  await mkdir(evalDirectory, { recursive: true });
  await exec("git", ["init", source]);
  await exec("git", ["-C", source, "config", "user.email", "hitch@example.test"]);
  await exec("git", ["-C", source, "config", "user.name", "Hitch Test"]);
  await writeFile(path.join(source, "history-secret.txt"), "ancestor must not be transported\n");
  await exec("git", ["-C", source, "add", "."]);
  await exec("git", ["-C", source, "commit", "-m", "unrelated history"]);
  const previousCommit = (await exec("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  await rm(path.join(source, "history-secret.txt"));
  await writeFile(path.join(source, "regular.txt"), "committed bytes\n");
  await writeFile(path.join(source, "executable.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await symlink("regular.txt", path.join(source, "link.txt"));
  await exec("git", ["-C", source, "add", "-A"]);
  await exec("git", ["-C", source, "commit", "-m", "transport fixture"]);
  const commit = (await exec("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  const tree = (await exec("git", ["-C", source, "rev-parse", "HEAD^{tree}"])).stdout.trim();
  const reference = `pi@git+${pathToFileURL(source).href}#${commit}`;
  const resolution = await resolveHarness(reference, { root: stateRoot });
  return { root, source, stateRoot, evalDirectory, commit, tree, previousCommit, resolution };
}

async function writeMaterializeFailureHarbor(directory: string): Promise<string> {
  const executable = path.join(directory, "fake-harbor-materialize-failure");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("harbor 0.1.0\\n"); process.exit(0); }
const config = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"));
const output = path.join(config.jobs_dir, config.job_name);
fs.mkdirSync(path.join(output, "trial__1"), { recursive: true });
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ n_total_trials: 1, stats: { n_completed_trials: 0, n_errored_trials: 1 } }));
fs.writeFileSync(path.join(output, "trial__1", "result.json"), JSON.stringify({
  task_name: "trial", trial_name: "trial__1", exception_info: "hitch-local-source-materialize: payload digest mismatch"
}));
`, { mode: 0o755 });
  return executable;
}
