import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fingerprintExecutable, inspectAgent, selectVersionLine } from "../src/registry.js";
import { writeFakeCodex } from "../test-support/helpers.js";

test("agent discovery resolves a pinned executable and fingerprints it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-registry-"));
  const target = await writeFakeCodex(directory);
  const link = path.join(directory, "codex-link");
  await symlink(target, link);

  const agent = await inspectAgent("codex", {
    env: { ...process.env, HITCH_CODEX_PATH: link },
  });

  assert.equal(agent.status, "available");
  assert.equal(agent.executable, await realpath(target));
  assert.equal(agent.version, "codex-cli 9.9.9");
  assert.match(agent.identity || "", /^sha256:[a-f0-9]{64}$/);
});

test("version selection ignores stderr warnings and prefers stdout semver", () => {
  const version = selectVersionLine(
    "codex-cli 0.145.0\n",
    "WARNING: proceeding, even though we could not create PATH aliases\n",
  );
  assert.equal(version, "codex-cli 0.145.0");
});

test("executable identity does not depend on detected version text", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-identity-"));
  const executable = await writeFakeCodex(directory);
  const first = await fingerprintExecutable(executable);
  const second = await fingerprintExecutable(executable);
  assert.equal(first, second);
});

test("agent discovery reports unavailable instead of failing", async () => {
  const agent = await inspectAgent("claude", {
    env: { ...process.env, HITCH_CLAUDE_PATH: "/definitely/missing/claude" },
  });
  assert.equal(agent.status, "unavailable");
});
