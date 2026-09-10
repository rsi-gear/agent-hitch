import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observeHarborEnvironment } from "../src/backends/index.js";
import { LocalExecutionObserver } from "../src/workers/index.js";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import { fingerprintExecutable, runCommand, sha256JSON, statePaths } from "../src/foundation/index.js";
import { forceRemove } from "../test-support/helpers.js";

const cli = fileURLToPath(new URL("../bin/hitch.js", import.meta.url));
const nonce = "a".repeat(32);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-execution-observation-"));
  const harbor = path.join(root, "harbor"), docker = path.join(root, "docker");
  const observed = path.join(root, "docker-info.json"), calls = path.join(root, "calls.jsonl");
  await writeFile(observed, JSON.stringify({ ID: "fixture-engine-1", ServerVersion: "28.1.0", OSType: "linux", Architecture: "x86_64" }));
  await writeFile(harbor, `#!${process.execPath}\nconsole.log('harbor 0.21.0');\n`, { mode: 0o755 });
  await writeFile(docker, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'info') process.stdout.write(fs.readFileSync(${JSON.stringify(observed)}));
else if (args.join(' ') === 'buildx version') console.log('github.com/docker/buildx v0.23.0 abc123');
else process.exit(42);
`, { mode: 0o755 });
  const env = { ...process.env, HITCH_HARBOR_PATH: harbor, HITCH_DOCKER_PATH: docker, OPENAI_API_KEY: "fixture-private-credential" };
  return { root, harbor, docker, observed, calls, env };
}

test("environment observation uses actual read-only commands and excludes secrets, paths and runtime load", async t => {
  const f = await fixture(); t.after(() => forceRemove(f.root));
  const first = await observeHarborEnvironment({ root: f.root, env: f.env });
  assert.deepEqual(first.harbor, { status: "available", version: "0.21.0", executable_digest: await fingerprintExecutable(f.harbor) });
  assert.deepEqual(first.docker, { status: "available", version: "28.1.0", executable_digest: await fingerprintExecutable(f.docker),
    engine_id: "fixture-engine-1", os: "linux", architecture: "x86_64" });
  assert.deepEqual(first.buildx, { status: "available", version: "0.23.0" });
  assert.deepEqual(first.sandbox, { status: "unverified" });
  assert.equal(JSON.stringify(first).includes(f.root), false);
  assert.equal(JSON.stringify(first).includes(f.env.OPENAI_API_KEY), false);
  const info = JSON.parse(await readFile(f.observed, "utf8"));
  await writeFile(f.observed, JSON.stringify({ ...info, ContainersRunning: 25, NCPU: 99, Name: "private-host" }));
  assert.deepEqual(await observeHarborEnvironment({ root: f.root, env: f.env }), first);
  await writeFile(f.observed, JSON.stringify({ ...info, ID: "fixture-engine-2" }));
  assert.notEqual(sha256JSON(await observeHarborEnvironment({ root: f.root, env: f.env })), sha256JSON(first));
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(calls.every(args => JSON.stringify(args) === JSON.stringify(["info", "--format", "{{json .}}"])
    || JSON.stringify(args) === JSON.stringify(["buildx", "version"])));
});

test("failed version exits and malformed Docker observations cannot advertise an available environment", async t => {
  const f = await fixture(); t.after(() => forceRemove(f.root));
  await writeFile(f.harbor, `#!${process.execPath}\nconsole.log('harbor 0.21.0'); console.error('fixture-private-credential'); process.exit(1);\n`);
  await writeFile(f.observed, JSON.stringify({ ServerVersion: "28.1.0", OSType: "linux", Architecture: "x86_64" }));
  const result = await observeHarborEnvironment({ root: f.root, env: f.env });
  assert.equal(result.harbor.status, "unavailable"); assert.equal(result.docker.status, "unavailable");
  assert.equal(JSON.stringify(result).includes("fixture-private-credential"), false);
  const missing = await observeHarborEnvironment({ root: f.root, env: { PATH: "", HITCH_HARBOR_PATH: "/not/installed/harbor", HITCH_DOCKER_PATH: "/not/installed/docker" } });
  assert.equal(missing.harbor.status, "unavailable"); assert.equal(missing.docker.status, "unavailable");
});

test("daemon observation requires admin authentication and returns fresh nonce-bound environment through the CLI", async t => {
  const f = await fixture();
  const server = new DaemonServer({ root: f.root, port: 0, maxConcurrent: 1, logger: () => {}, credentialEnv: f.env,
    executionObserver: new LocalExecutionObserver({ root: f.root, env: f.env }) });
  t.after(async () => { await server.close(); await forceRemove(f.root); });
  await server.start();
  const body = JSON.stringify({ schema_version: "2", provider: "local-docker", nonce });
  const denied = await fetch(`http://127.0.0.1:${server.port}/v2/execution-observation`, { method: "POST", body });
  assert.equal(denied.status, 401);
  await assert.rejects(readFile(f.calls), { code: "ENOENT" });
  const client = await daemonClient(f.root);
  await assert.rejects(client.request("/v2/execution-observation", { method: "POST", body: JSON.stringify({ schema_version: "2", provider: "local-docker", nonce, command: "anything" }) }), { code: "invalid_input" });
  await assert.rejects(client.request("/v2/execution-observation", { method: "POST", body: JSON.stringify({ schema_version: "2", provider: "remote", nonce }) }), { code: "execution_observation_unsupported" });
  const invoke = async (requestNonce: string) => JSON.parse((await runCommand(process.execPath,
    [cli, "--root", f.root, "worker", "observe", "local-docker", "--nonce", requestNonce, "--json"], { timeoutMs: 30_000 })).stdout);
  const first = await invoke(nonce);
  const listing = await client.request("/v1/workers") as { workers: { worker_id: string; collision_domain_id: string }[] };
  assert.equal(first.nonce, nonce); assert.equal(first.daemon_instance_id, server.instanceId);
  assert.equal(first.worker_id, listing.workers[0]?.worker_id); assert.equal(first.collision_domain_id, listing.workers[0]?.collision_domain_id);
  assert.equal(first.daemon_runtime.unchanged, true);
  assert.equal(first.environment_digest, sha256JSON(first.environment));
  assert.equal(first.environment.docker.engine_id, "fixture-engine-1");
  await writeFile(f.observed, JSON.stringify({ ID: "fixture-engine-2", ServerVersion: "28.1.0", OSType: "linux", Architecture: "x86_64" }));
  const second = await invoke("b".repeat(32));
  assert.equal(second.nonce, "b".repeat(32)); assert.equal(second.environment.docker.engine_id, "fixture-engine-2");
  assert.notEqual(second.environment_digest, first.environment_digest);
  assert.equal(JSON.stringify(second).includes(f.env.OPENAI_API_KEY), false);
  // A replaced/stale state file cannot make the CLI accept another daemon's observation.
  const stateFile = statePaths(f.root).daemon;
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  await writeFile(stateFile, JSON.stringify({ ...state, instance_id: "c".repeat(32) }));
  await assert.rejects(invoke(nonce), /requested daemon\/provider\/nonce/);
  await writeFile(stateFile, JSON.stringify(state));
});
