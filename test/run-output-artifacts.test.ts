import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { atomicWriteJSON, readJSON, sha256JSON } from "../src/foundation/index.js";
import { exportRunOutputArtifacts, listRunOutputArtifacts, sealRunOutputArtifacts, writeResultBundleIndex } from "../src/runs/index.js";
import { parseRunOutputManifest } from "../src/runs/output-artifacts.js";

const identity = { run_id: `run_${"a".repeat(32)}`, eval_id: `eval_${"b".repeat(32)}`, task_id: "task-one", attempt: 1,
  harness_commit: "c".repeat(40), task_digest: `sha256:${"d".repeat(64)}` };
const bytes = "PassengerId,Survived\n892,1\n";
const executable = fileURLToPath(new URL("../bin/hitch.js", import.meta.url));
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "hitch-outputs-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDirectory = path.join(root, "runs", identity.run_id), sourceDirectory = path.join(root, "source");
  await mkdir(path.join(sourceDirectory, "app/output"), { recursive: true });
  await writeFile(path.join(sourceDirectory, "app/output/submission.csv"), bytes);
  await writeFile(path.join(sourceDirectory, "secret.txt"), "never exported");
  await atomicWriteJSON(path.join(runDirectory, "manifest.json"), { schema_version: "1", run_id: identity.run_id, sealed: true,
    context: { kind: "benchmark_task", benchmark_id: "fixture", benchmark_revision: "1", task_id: identity.task_id,
      task_digest: identity.task_digest, verifier_identity: identity.task_digest },
    parent: { kind: "eval", eval_id: identity.eval_id, trial_id: "task-one__1", attempt: 1 }, status: "succeeded",
    harness: { harness_id: "codex", requested_ref: `codex@commit:${identity.harness_commit}`, revision_identity: identity.task_digest },
    model: { requested_id: "fixture", effective_id: "fixture", identity_resolved: false }, protocol: { timeout_ms: 1000, workspace_mode: "shared" },
    observation: { status: "valid", reward: 0, verifier_result_ref: "verifier/result.json" }, request_ref: "request.json", resolution_ref: "resolution.json", result_ref: "result.json",
    created_at: "2026-11-04T00:00:00.000Z" });
  await atomicWriteJSON(path.join(runDirectory, "request.json"), {});
  await atomicWriteJSON(path.join(runDirectory, "verifier/result.json"), { rewards: { reward: 0 } });
  await atomicWriteJSON(path.join(runDirectory, "resolution.json"), { revision: { type: "commit", commit: identity.harness_commit } });
  await atomicWriteJSON(path.join(runDirectory, "result.json"), { run_id: identity.run_id, status: "succeeded" });
  return { root, runDirectory, sourceDirectory, paths: ["app/output"], identity };
}
async function sealed(t: test.TestContext) {
  const f = await fixture(t), manifest = await sealRunOutputArtifacts(f);
  await writeResultBundleIndex(f.runDirectory);
  return { ...f, manifest };
}

test("sealed output API and CLI survive workspace deletion and export idempotently", async t => {
  const f = await sealed(t);
  await rm(f.sourceDirectory, { recursive: true });
  assert.equal(f.manifest.entries.length, 1);
  assert.equal(f.manifest.entries[0]?.path, "app/output/submission.csv");
  assert.deepEqual(await listRunOutputArtifacts(f.root, identity.run_id), f.manifest);
  const cli = spawnSync(process.execPath, [executable, "--root", f.root, "runs", "artifacts", "list", identity.run_id, "--json"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout), f.manifest);
  const out = path.join(f.root, "export");
  const results = await Promise.all([1, 2].map(() => exportRunOutputArtifacts(f.root, identity.run_id, { manifestDigest: f.manifest.digest, out })));
  assert.deepEqual(results[0], results[1]);
  assert.equal(await readFile(path.join(out, "app/output/submission.csv"), "utf8"), bytes);
  assert.deepEqual(await readJSON(path.join(out, "hitch-output-manifest.json")), f.manifest);
  const exported = spawnSync(process.execPath, [executable, "--root", f.root, "runs", "artifacts", "export", identity.run_id,
    "--manifest-digest", f.manifest.digest, "--out", out, "--json"], { encoding: "utf8" });
  assert.equal(exported.status, 0, exported.stderr); assert.deepEqual(JSON.parse(exported.stdout), results[0]);
  assert.equal((await readdir(f.root)).some(name => name.startsWith(".hitch-output-export-")), false);
});

test("export rejects version mismatch, destination changes and source tampering", async t => {
  const f = await sealed(t), out = path.join(f.root, "export");
  await assert.rejects(exportRunOutputArtifacts(f.root, identity.run_id, { manifestDigest: identity.task_digest, out }), { code: "output_artifacts_version_mismatch" });
  await mkdir(out); await writeFile(path.join(out, "keep"), "existing");
  await assert.rejects(exportRunOutputArtifacts(f.root, identity.run_id, { manifestDigest: f.manifest.digest, out }), { code: "output_artifacts_destination_exists" });
  assert.equal(await readFile(path.join(out, "keep"), "utf8"), "existing");
  await writeFile(path.join(f.runDirectory, "output-artifacts/files/app/output/submission.csv"), "altered");
  await assert.rejects(listRunOutputArtifacts(f.root, identity.run_id), { code: "output_artifacts_corrupt" });
  await assert.rejects(exportRunOutputArtifacts(f.root, identity.run_id, { manifestDigest: f.manifest.digest, out: path.join(f.root, "another") }), { code: "output_artifacts_corrupt" });
});

for (const kind of ["symlink-file", "symlink-root", "hardlink", "oversize"] as const) test(`capture rejects ${kind} and leaves no partial manifest`, async t => {
  const f = await fixture(t), target = path.join(f.sourceDirectory, "app/output/submission.csv");
  if (kind === "symlink-root") {
    const original = f.sourceDirectory; f.sourceDirectory = path.join(f.root, "linked-source"); await symlink(original, f.sourceDirectory);
  } else {
    await rm(target);
    if (kind === "symlink-file") await symlink(path.join(f.sourceDirectory, "secret.txt"), target);
    if (kind === "hardlink") await link(path.join(f.sourceDirectory, "secret.txt"), target);
    if (kind === "oversize") await writeFile(target, Buffer.alloc(16 * 1024 * 1024 + 1));
  }
  await assert.rejects(sealRunOutputArtifacts(f));
  assert.equal((await readdir(f.runDirectory)).some(name => name.startsWith(".output-artifacts-") || name === "output-artifacts"), false);
});

test("manifest parser rejects traversal, absolute paths, conflicting paths and identity changes", async t => {
  const f = await sealed(t);
  for (const p of ["../secret", "/secret", "a/../b", "a\\b", "hitch-output-manifest.json", "a\u0000b"]) {
    const { digest: _, ...body } = f.manifest;
    const value = { ...body, entries: [{ ...body.entries[0]!, path: p, name: p }] };
    assert.throws(() => parseRunOutputManifest({ ...value, digest: sha256JSON(value) }));
  }
  assert.throws(() => parseRunOutputManifest({ ...f.manifest, task_id: "another" }));
  const { digest: _, ...body } = f.manifest;
  const changed = { ...body, harness_commit: "e".repeat(40) };
  await atomicWriteJSON(path.join(f.runDirectory, "output-artifacts/manifest.json"), { ...changed, digest: sha256JSON(changed) });
  await writeResultBundleIndex(f.runDirectory);
  await assert.rejects(listRunOutputArtifacts(f.root, identity.run_id), { code: "output_artifacts_corrupt" });
});

test("aborted export removes staging and unsealed or legacy runs cannot export", async t => {
  const f = await sealed(t), out = path.join(f.root, "export"), controller = new AbortController(); controller.abort();
  await assert.rejects(exportRunOutputArtifacts(f.root, identity.run_id, { manifestDigest: f.manifest.digest, out, signal: controller.signal }));
  assert.equal((await readdir(f.root)).some(name => name === "export" || name.startsWith(".hitch-output-export-")), false);
  const manifest = await readJSON<Record<string, unknown>>(path.join(f.runDirectory, "manifest.json"));
  await atomicWriteJSON(path.join(f.runDirectory, "manifest.json"), { ...manifest, sealed: false });
  await assert.rejects(listRunOutputArtifacts(f.root, identity.run_id), { code: "output_artifacts_not_sealed" });
  await atomicWriteJSON(path.join(f.runDirectory, "manifest.json"), manifest);
  await rm(path.join(f.runDirectory, "output-artifacts"), { recursive: true }); await writeResultBundleIndex(f.runDirectory);
  await assert.rejects(listRunOutputArtifacts(f.root, identity.run_id), { code: "output_artifacts_unavailable" });
});

test("accepts the identical cross-repository run-output-artifacts@1 golden manifest", async () => {
  const golden = JSON.parse(await readFile(new URL("../../test-contracts/run-output-artifacts-v1.json", import.meta.url), "utf8"));
  assert.deepEqual(parseRunOutputManifest(golden), golden);
});
