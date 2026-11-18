import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedCodexInvocation } from "../src/runs/isolated-codex.js";
import { prepareAdapterProcess } from "../src/runs/adapter-process.js";
import { getAdapter } from "../src/adapters/index.js";
import type { PreparedArtifact, ResolvedRevision } from "../src/artifacts/index.js";

const targets: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin", "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc",
};

async function installation(t: import("node:test").TestContext, optional: boolean, layout: string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "hitch-codex-npm-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "node_modules/@openai/codex"), launcher = path.join(packageRoot, "bin/codex.js");
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }));
  await writeFile(launcher, '#!/usr/bin/env node\nthrow new Error("launcher must not run");\n', { mode: 0o755 });
  const platform = `${process.platform}-${process.arch}`, target = targets[platform];
  assert.ok(target);
  const vendorPackage = optional ? path.join(packageRoot, "node_modules/@openai", `codex-${platform}`) : packageRoot;
  await mkdir(vendorPackage, { recursive: true });
  if (optional) await writeFile(path.join(vendorPackage, "package.json"), JSON.stringify({ name: `@openai/codex-${platform}` }));
  const native = path.join(vendorPackage, "vendor", target, layout, process.platform === "win32" ? "codex.exe" : "codex");
  await mkdir(path.dirname(native), { recursive: true });
  await writeFile(native, "native-fixture", { mode: 0o755 });
  return { root, launcher, native };
}

for (const optional of [false, true]) for (const layout of ["bin", "codex"]) {
  test(`isolated Codex resolves ${optional ? "optional" : "bundled"} npm ${layout} layout`, async t => {
    const { launcher, native } = await installation(t, optional, layout);
    const args = ["exec", "--json", "-"];
    assert.deepEqual(await isolatedCodexInvocation({ executable: launcher, args, input: "test" }), { executable: native, args });
    assert.deepEqual(args, ["exec", "--json", "-"]);
  });
}

test("isolated Codex follows an installed npm command symlink", { skip: process.platform === "win32" }, async t => {
  const { root, launcher, native } = await installation(t, true, "bin");
  const link = path.join(root, "codex");
  await symlink(launcher, link);
  assert.deepEqual(await isolatedCodexInvocation({ executable: link, args: ["exec"], input: "" }), { executable: native, args: ["exec"] });
});

test("isolated Codex removes only the prepared npm artifact's Node entrypoint prefix", async t => {
  const { root, launcher, native } = await installation(t, true, "bin");
  const specification = await prepareAdapterProcess(getAdapter("codex"), {
    harness_ref: "codex@0.145.0", model: "test", prompt: "check", cwd: root, agent_args: [], workspace_mode: "shared", timeout_ms: 1000,
  }, { executable: process.execPath, entrypoint_args: [launcher] } as PreparedArtifact, {} as ResolvedRevision, root, root, {
    isolated: { provider_url: "http://hitch-model.invalid/run/openai" },
  });
  const invocation = await isolatedCodexInvocation(specification);
  assert.equal(invocation.executable, native);
  assert.equal(invocation.args[0], "exec");
  assert.equal(invocation.args.at(-1), "-");
  assert.deepEqual(invocation.args, specification.args.slice(1));
  assert.equal(specification.args[0], launcher);
});

test("recognized npm launchers fail closed when their native binary is missing", async t => {
  const { launcher, native } = await installation(t, false, "bin");
  await rm(native);
  await assert.rejects(isolatedCodexInvocation({ executable: launcher, args: ["exec"], input: "" }), { code: "codex_native_unavailable" });
});

test("direct custom executables retain their invocation", async t => {
  const { root } = await installation(t, false, "bin");
  const custom = path.join(root, "custom-codex");
  await writeFile(custom, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.deepEqual(await isolatedCodexInvocation({ executable: custom, args: ["exec", "-"], input: "" }), { executable: custom, args: ["exec", "-"] });
});
