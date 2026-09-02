import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { codexContainerAuth } from "../src/adapters/providers/codex-auth.js";
import { credentialValuesFromEnv, redactCredentialText } from "../src/foundation/index.js";

test("tool-server protocol handles idempotent snapshots, failed prepare and cancellation with cleanup", () => {
  const result = spawnSync("python3", ["test-support/benchmark_protocol_smoke.py", "integrations/harbor/hitch_benchmark.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /failure gates passed/);
});

test("Codex container auth stays outside result bundles and nested credentials are redacted", async (t) => {
  const token = "synthetic-opaque-token-long-enough";
  const encoded = JSON.stringify({ tokens: { access_token: token } });
  const env = { HITCH_HARBOR_INTERNAL: "1", HITCH_CODEX_AUTH_JSON: encoded };
  assert.throws(() => codexContainerAuth({ HITCH_CODEX_AUTH_JSON: encoded }), /managed Harbor/);
  const auth = codexContainerAuth(env)!;
  const directory = auth.CODEX_HOME!;
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await readFile(path.join(directory, "auth.json"), "utf8"), encoded);
  assert.equal((await stat(path.join(directory, "auth.json"))).mode & 0o777, 0o600);
  assert.ok(!directory.includes("runtime-home"));
  const values = credentialValuesFromEnv(["HITCH_CODEX_AUTH_JSON"], env);
  assert.ok(values.includes(token));
  assert.ok(!redactCredentialText(`value=${token}`, values).text.includes(token));
});

test("GDPval public rubric handles partial credit, penalties and invalid judge outputs", () => {
  const result = spawnSync("python3", ["test-support/benchmark_sources_smoke.py"], {encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/public rubric contract passed/);
});
