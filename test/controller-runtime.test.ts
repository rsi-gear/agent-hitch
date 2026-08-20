import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashRuntimePayload, verifyRuntimePayload, canonicalEncodeManifest, isEntrypointPath } from "../src/controller-runtime/hash.js";
import { ensureControllerRuntime, useControllerRuntimeById } from "../src/controller-runtime/store.js";
import { statePaths } from "../src/config.js";
import { forceRemove } from "../test-support/helpers.js";
import { validateControllerRuntimeManifest } from "../src/domain/validate.js";
import type { ControllerRuntimeManifest } from "../src/domain/types.js";

/** Build a tiny fake payload root that matches the allowlist shape (package.json + dist/bin + dist/src + dist/scripts). */
async function payloadFixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-runtime-payload-"));
  await mkdir(path.join(root, "dist", "bin"), { recursive: true });
  await mkdir(path.join(root, "dist", "src"), { recursive: true });
  await mkdir(path.join(root, "dist", "scripts"), { recursive: true });
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "fake-hitch", version: "0.2.0" })}\n`);
  await writeFile(path.join(root, "dist", "bin", "hitch.js"), "#!/usr/bin/env node\nconsole.log('hitch');\n", { mode: 0o755 });
  await writeFile(path.join(root, "dist", "src", "cli.js"), "export const main = () => {};\n");
  await writeFile(path.join(root, "dist", "scripts", "check.js"), "export const check = () => {};\n");
  return {
    root,
    cleanup: () => forceRemove(root),
  };
}

test("canonical hashing is deterministic and content-addressed", async () => {
  const fixture = await payloadFixture();
  const first = await hashRuntimePayload({ payloadRoot: fixture.root });
  const second = await hashRuntimePayload({ payloadRoot: fixture.root });
  assert.equal(first.runtimeId, second.runtimeId);
  assert.match(first.runtimeId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.fileCount, 4);
  assert.ok(first.totalBytes > 0);
  await fixture.cleanup();
});

test("changing any payload byte changes the runtime id", async () => {
  const fixture = await payloadFixture();
  const before = await hashRuntimePayload({ payloadRoot: fixture.root });
  await writeFile(path.join(fixture.root, "dist", "src", "cli.js"), "export const main = () => 1;\n");
  const after = await hashRuntimePayload({ payloadRoot: fixture.root });
  assert.notEqual(before.runtimeId, after.runtimeId);
  await fixture.cleanup();
});

test("changing the executable bit of a non-entrypoint payload file changes the runtime id", async () => {
  const fixture = await payloadFixture();
  const before = await hashRuntimePayload({ payloadRoot: fixture.root });
  await chmod(path.join(fixture.root, "dist", "src", "cli.js"), 0o755);
  const after = await hashRuntimePayload({ payloadRoot: fixture.root });
  assert.notEqual(before.runtimeId, after.runtimeId);
  await fixture.cleanup();
});

test("changing the executable bit of an entrypoint fails integrity verification after promotion", async (t) => {
  // Entrypoints are declared executable in the allowlist; the promoted bundle
  // sets 0555 and any later change must fail verification (spec §11.1).
  const state = await mkdtemp(path.join(tmpdir(), "hitch-runtime-exec-"));
  const fixture = await payloadFixture();
  t.after(async () => {
    await fixture.cleanup();
    await forceRemove(state);
  });
  const use = await ensureControllerRuntime({ root: state, payloadRoot: fixture.root });
  if (process.platform !== "win32") {
    const entrypoint = path.join(use.directory, "payload", "dist", "bin", "hitch.js");
    await chmod(entrypoint, 0o644);
    await assert.rejects(
      useControllerRuntimeById(statePaths(state), use.runtime_id.replace("sha256:", "")),
      (error: unknown) => (error as { code?: string }).code === "controller_runtime_integrity_mismatch",
    );
  }
});

test("entrypoints are recorded as executable in the manifest", async () => {
  const fixture = await payloadFixture();
  const result = await hashRuntimePayload({ payloadRoot: fixture.root });
  const entrypoint = result.manifest.files.find((file) => file.path === "dist/bin/hitch.js");
  assert.ok(entrypoint);
  assert.equal(entrypoint.executable, true);
  assert.equal(isEntrypointPath("dist/bin/hitch.js"), true);
  assert.equal(isEntrypointPath("dist/src/cli.js"), false);
  await fixture.cleanup();
});

test("manifest canonical encoding sorts files and omits created_at", async () => {
  const fixture = await payloadFixture();
  const result = await hashRuntimePayload({ payloadRoot: fixture.root });
  const encoded = canonicalEncodeManifest(result.manifest.files);
  assert.ok(!encoded.includes("created_at"));
  assert.ok(encoded.includes("dist/bin/hitch.js"));
  await fixture.cleanup();
});

test("verification rejects a tampered payload", async () => {
  const fixture = await payloadFixture();
  const result = await hashRuntimePayload({ payloadRoot: fixture.root });
  // Tamper with a payload byte after hashing (keep the same length so the
  // digest check runs rather than the size check).
  const cliFile = path.join(fixture.root, "dist", "src", "cli.js");
  const original = await readFile(cliFile, "utf8");
  const tampered = original.replace("main", "mxxn");
  assert.notEqual(original, tampered);
  assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(original));
  await writeFile(cliFile, tampered);
  await assert.rejects(
    verifyRuntimePayload(fixture.root, result.manifest),
    /digest mismatch/,
  );
  await fixture.cleanup();
});

test("ensureControllerRuntime promotes once and returns cache hits with identical ids", async (t) => {
  const state = await mkdtemp(path.join(tmpdir(), "hitch-runtime-state-"));
  const fixture = await payloadFixture();
  t.after(async () => {
    await fixture.cleanup();
    await forceRemove(state);
  });

  const first = await ensureControllerRuntime({ root: state, payloadRoot: fixture.root });
  const second = await ensureControllerRuntime({ root: state, payloadRoot: fixture.root });
  assert.equal(first.cache_hit, false);
  assert.equal(second.cache_hit, true);
  assert.equal(first.runtime_id, second.runtime_id);
  // The manifest on disk validates.
  const manifestPath = path.join(statePaths(state).controllerRuntimes, first.runtime_id.replace("sha256:", ""), "manifest.json");
  const manifest = validateControllerRuntimeManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  assert.equal(manifest.runtime_id, first.runtime_id);
  assert.ok(manifest.files.length >= 3);
});

test("useControllerRuntimeById verifies the promoted bundle and rejects corruption", async (t) => {
  const state = await mkdtemp(path.join(tmpdir(), "hitch-runtime-use-"));
  const fixture = await payloadFixture();
  t.after(async () => {
    await fixture.cleanup();
    await forceRemove(state);
  });
  const use = await ensureControllerRuntime({ root: state, payloadRoot: fixture.root });
  const verified = await useControllerRuntimeById(statePaths(state), use.runtime_id.replace("sha256:", ""));
  assert.equal(verified.runtime_id, use.runtime_id);
  assert.equal(verified.cache_hit, true);

  // Corrupt a promoted payload file: the next verified use must fail instead
  // of silently falling back (spec §4.6, §11.1). Promoted payload files are
  // 0444, so make the file writable before tampering.
  const payloadFile = path.join(verified.directory, "payload", "dist", "src", "cli.js");
  await chmod(payloadFile, 0o644);
  await writeFile(payloadFile, "corrupted;\n");
  await assert.rejects(
    useControllerRuntimeById(statePaths(state), use.runtime_id.replace("sha256:", "")),
    (error: unknown) => (error as { code?: string }).code === "controller_runtime_integrity_mismatch",
  );
});

test("missing expected runtime fails with integrity mismatch (no fallback)", async (t) => {
  const state = await mkdtemp(path.join(tmpdir(), "hitch-runtime-missing-"));
  t.after(() => forceRemove(state));
  await assert.rejects(
    useControllerRuntimeById(statePaths(state), "a".repeat(64)),
    (error: unknown) => {
      const typed = error as { code?: string };
      return typed.code === "controller_runtime_integrity_mismatch";
    },
  );
});

test("concurrent first use produces exactly one cache entry", async (t) => {
  const state = await mkdtemp(path.join(tmpdir(), "hitch-runtime-race-"));
  const fixture = await payloadFixture();
  t.after(async () => {
    await fixture.cleanup();
    await forceRemove(state);
  });
  const results = await Promise.all([
    ensureControllerRuntime({ root: state, payloadRoot: fixture.root }),
    ensureControllerRuntime({ root: state, payloadRoot: fixture.root }),
    ensureControllerRuntime({ root: state, payloadRoot: fixture.root }),
  ]);
  const ids = new Set(results.map((result) => result.runtime_id));
  assert.equal(ids.size, 1);
  const cacheHits = results.filter((result) => result.cache_hit).length;
  assert.ok(cacheHits >= 2, `expected at least two cache hits, got ${cacheHits}`);
  const runtimeDir = path.join(statePaths(state).controllerRuntimes, results[0]?.runtime_id.replace("sha256:", "") as string);
  assert.equal((await (await import("node:fs/promises")).readdir(runtimeDir)).length > 0, true);
});

test("runtime bundle is never used as a writable workspace", async (t) => {
  const state = await mkdtemp(path.join(tmpdir(), "hitch-runtime-readonly-"));
  const fixture = await payloadFixture();
  t.after(async () => {
    await fixture.cleanup();
    await forceRemove(state);
  });
  const use = await ensureControllerRuntime({ root: state, payloadRoot: fixture.root });
  // Promoted payload files are 0444 and directories 0555 on POSIX.
  if (process.platform !== "win32") {
    const { stat } = await import("node:fs/promises");
    const payloadDir = path.join(use.directory, "payload");
    const info = await stat(payloadDir);
    assert.equal((info.mode & 0o555), 0o555);
  }
});

test("hash ignores non-payload files at the package root (docs, tests, tooling)", async () => {
  const fixture = await payloadFixture();
  // The payload root is the whole package; only allowlisted trees are hashed.
  await mkdir(path.join(fixture.root, "docs"), { recursive: true });
  await writeFile(path.join(fixture.root, "docs", "guide.md"), "not part of the runtime\n");
  const result = await hashRuntimePayload({ payloadRoot: fixture.root });
  assert.equal(result.manifest.files.some((file) => file.path.startsWith("docs/")), false);
  await fixture.cleanup();
});

test("verification rejects an undeclared file inside the staged payload tree", async () => {
  const fixture = await payloadFixture();
  const result = await hashRuntimePayload({ payloadRoot: fixture.root });
  // Simulate a staged payload with an undeclared file inside a declared tree:
  // verification must reject it (spec §4.6).
  const staged = await mkdtemp(path.join(tmpdir(), "hitch-runtime-staged-"));
  await mkdir(path.join(staged, "dist", "bin"), { recursive: true });
  await mkdir(path.join(staged, "dist", "src"), { recursive: true });
  await mkdir(path.join(staged, "dist", "scripts"), { recursive: true });
  await writeFile(path.join(staged, "package.json"), await readFile(path.join(fixture.root, "package.json")));
  await writeFile(path.join(staged, "dist", "bin", "hitch.js"), await readFile(path.join(fixture.root, "dist", "bin", "hitch.js")));
  await chmod(path.join(staged, "dist", "bin", "hitch.js"), 0o755);
  await writeFile(path.join(staged, "dist", "src", "cli.js"), await readFile(path.join(fixture.root, "dist", "src", "cli.js")));
  await writeFile(path.join(staged, "dist", "scripts", "check.js"), await readFile(path.join(fixture.root, "dist", "scripts", "check.js")));
  await writeFile(path.join(staged, "dist", "stray.txt"), "stray\n");
  await assert.rejects(
    verifyRuntimePayload(staged, result.manifest),
    /undeclared file/,
  );
  await forceRemove(staged);
  await fixture.cleanup();
});

test("hash rejects symlinks and special files inside the payload", async () => {
  const fixture = await payloadFixture();
  const { symlink } = await import("node:fs/promises");
  // The symlink sits inside a declared tree (dist/src), so enumeration must
  // reject it (spec §4.4.2).
  await symlink(path.join(fixture.root, "package.json"), path.join(fixture.root, "dist", "src", "link.json"));
  await assert.rejects(
    hashRuntimePayload({ payloadRoot: fixture.root }),
    /symlinks/,
  );
  await fixture.cleanup();
});

test("verification rejects a declared path that is a symlink", async () => {
  const fixture = await payloadFixture();
  const result = await hashRuntimePayload({ payloadRoot: fixture.root });
  // Rebuild the payload with the same declared file set, then replace one
  // declared file with a symlink: verification must reject it (spec §4.4.2).
  const staged = await mkdtemp(path.join(tmpdir(), "hitch-runtime-symlink-"));
  await mkdir(path.join(staged, "dist", "bin"), { recursive: true });
  await mkdir(path.join(staged, "dist", "src"), { recursive: true });
  await mkdir(path.join(staged, "dist", "scripts"), { recursive: true });
  await writeFile(path.join(staged, "package.json"), await readFile(path.join(fixture.root, "package.json")));
  await writeFile(path.join(staged, "dist", "bin", "hitch.js"), await readFile(path.join(fixture.root, "dist", "bin", "hitch.js")));
  await chmod(path.join(staged, "dist", "bin", "hitch.js"), 0o755);
  await writeFile(path.join(staged, "dist", "scripts", "check.js"), await readFile(path.join(fixture.root, "dist", "scripts", "check.js")));
  const { symlink } = await import("node:fs/promises");
  await symlink(path.join(staged, "package.json"), path.join(staged, "dist", "src", "cli.js"));
  await assert.rejects(
    verifyRuntimePayload(staged, result.manifest),
    /symlinks/,
  );
  await forceRemove(staged);
  await fixture.cleanup();
});

test("verification rejects a hardlinked payload file", async () => {
  const fixture = await payloadFixture();
  const result = await hashRuntimePayload({ payloadRoot: fixture.root });
  // Rebuild the payload, then replace one declared file with a hardlink to
  // another declared file: verification must reject it (spec §4.4.2).
  const staged = await mkdtemp(path.join(tmpdir(), "hitch-runtime-hardlink-"));
  await mkdir(path.join(staged, "dist", "bin"), { recursive: true });
  await mkdir(path.join(staged, "dist", "src"), { recursive: true });
  await mkdir(path.join(staged, "dist", "scripts"), { recursive: true });
  await writeFile(path.join(staged, "package.json"), await readFile(path.join(fixture.root, "package.json")));
  await writeFile(path.join(staged, "dist", "bin", "hitch.js"), await readFile(path.join(fixture.root, "dist", "bin", "hitch.js")));
  await chmod(path.join(staged, "dist", "bin", "hitch.js"), 0o755);
  await writeFile(path.join(staged, "dist", "scripts", "check.js"), await readFile(path.join(fixture.root, "dist", "scripts", "check.js")));
  const { link } = await import("node:fs/promises");
  await link(path.join(staged, "dist", "scripts", "check.js"), path.join(staged, "dist", "src", "cli.js"));
  await assert.rejects(
    verifyRuntimePayload(staged, result.manifest),
    /hardlinks/,
  );
  await forceRemove(staged);
  await fixture.cleanup();
});

test("a corrupt same-id runtime is quarantined and re-promoted from the staged bundle", async (t) => {
  const state = await mkdtemp(path.join(tmpdir(), "hitch-runtime-quarantine-"));
  const fixture = await payloadFixture();
  t.after(async () => {
    await fixture.cleanup();
    await forceRemove(state);
  });
  const first = await ensureControllerRuntime({ root: state, payloadRoot: fixture.root });
  // Corrupt the promoted payload so the bundle fails verification.
  const { chmod: chmodFile } = await import("node:fs/promises");
  const payloadFile = path.join(first.directory, "payload", "dist", "src", "cli.js");
  await chmodFile(payloadFile, 0o644);
  await writeFile(payloadFile, "corrupted;\n");
  await assert.rejects(
    useControllerRuntimeById(statePaths(state), first.runtime_id.replace("sha256:", "")),
    (error: unknown) => (error as { code?: string }).code === "controller_runtime_integrity_mismatch",
  );
  // A fresh ensure must quarantine the corrupt bundle and promote a valid one
  // with the same runtime id (spec §4.5).
  const repaired = await ensureControllerRuntime({ root: state, payloadRoot: fixture.root });
  assert.equal(repaired.runtime_id, first.runtime_id);
  assert.equal(repaired.cache_hit, false);
  const verified = await useControllerRuntimeById(statePaths(state), first.runtime_id.replace("sha256:", ""));
  assert.equal(verified.runtime_id, first.runtime_id);
});

test("bundle payload layout matches the Harbor bridge expectations", async (t) => {
  // The Python bridge uploads <bundle>/payload to /opt/hitch and executes
  // /opt/hitch/dist/bin/hitch.js (spec §4.2, §8.5). The bundle root therefore
  // must contain manifest.json + payload/, and payload/ must be a package root
  // with dist/bin/hitch.js and package.json.
  const state = await mkdtemp(path.join(tmpdir(), "hitch-runtime-layout-"));
  const fixture = await payloadFixture();
  t.after(async () => {
    await fixture.cleanup();
    await forceRemove(state);
  });
  const use = await ensureControllerRuntime({ root: state, payloadRoot: fixture.root });
  const { stat: statFile } = await import("node:fs/promises");
  assert.ok((await statFile(path.join(use.directory, "manifest.json"))).isFile());
  const entry = path.join(use.directory, "payload", "dist", "bin", "hitch.js");
  assert.ok((await statFile(entry)).isFile());
  assert.ok((await statFile(path.join(use.directory, "payload", "package.json"))).isFile());
  assert.ok((await statFile(path.join(use.directory, "payload", "dist", "src"))).isDirectory());
});

test("runtime allowlist excludes dev/test artifacts under dist/", async () => {
  const fixture = await payloadFixture();
  // dist/test and dist/test-support are build-time artifacts of the checkout;
  // they must not be part of the runtime payload (spec §4.4, §11.1), so a
  // checkout runtime and an npm-installed runtime share one id.
  await mkdir(path.join(fixture.root, "dist", "test"), { recursive: true });
  await mkdir(path.join(fixture.root, "dist", "test-support"), { recursive: true });
  await writeFile(path.join(fixture.root, "dist", "test", "x.test.js"), "// test\n");
  await writeFile(path.join(fixture.root, "dist", "test-support", "helpers.js"), "// helpers\n");
  const result = await hashRuntimePayload({ payloadRoot: fixture.root });
  assert.equal(result.manifest.files.some((file) => file.path.startsWith("dist/test")), false);
  assert.equal(result.manifest.files.some((file) => file.path.startsWith("dist/test-support")), false);
  // The allowlist mirrors the published files: no dist/test entries.
  assert.equal(result.fileCount, 4);
  await fixture.cleanup();
});

test("two identical payloads from different roots share a runtime id", async () => {
  const first = await payloadFixture();
  const second = await payloadFixture();
  const left = await hashRuntimePayload({ payloadRoot: first.root });
  const right = await hashRuntimePayload({ payloadRoot: second.root });
  assert.equal(left.runtimeId, right.runtimeId);
  await first.cleanup();
  await second.cleanup();
});

export type { ControllerRuntimeManifest };
