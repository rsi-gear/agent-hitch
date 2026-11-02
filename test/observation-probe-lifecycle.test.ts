import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runObservationProbe } from "../src/backends/harbor/observation-probe.js";
import { LocalExecutionObserver } from "../src/workers/index.js";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import { forceRemove } from "../test-support/helpers.js";
import { waitObservation } from "../test-support/execution-observation.js";
import { runCommand } from "../src/foundation/index.js";

// These real POSIX process-group fixtures are deliberately skipped on Windows.
const skip = process.platform === "win32";
async function executable(t: import("node:test").TestContext, source: string) {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-probe-lifecycle-"));
  t.after(() => forceRemove(root));
  const file = path.join(root, "probe");
  await writeFile(file, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return { root, file };
}
const dead = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

test("probe timeout stays timed_out when its launcher exits zero and descendants hold pipes open", { skip }, async t => {
  const f = await executable(t, `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('descendant-ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.once('data', () => process.stdout.write('child=' + child.pid));
process.on('SIGTERM', () => { console.log('valid-looking JSON'); process.exit(0); });
setInterval(() => {}, 1000);
`);
  const result = await runObservationProbe(f.file, "docker_info", { env: process.env, signal: new AbortController().signal, timeoutMs: 1_000 });
  assert.equal(result.outcome, "timed_out"); assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
});

test("probe byte limits cannot accept a Unicode stream that fits a character limit", { skip }, async t => {
  const f = await executable(t, "process.stdout.write('€'.repeat(400_000));");
  const result = await runObservationProbe(f.file, "docker_info", { env: process.env, signal: new AbortController().signal, timeoutMs: 5_000 });
  assert.equal(result.outcome, "output_limit"); assert.equal(result.stdout, "");
});

test("probe spawn failure is classified without exposing executable paths or OS error text", async () => {
  const result = await runObservationProbe("/missing/private/probe", "docker_info", { env: process.env, signal: new AbortController().signal, timeoutMs: 1_000 });
  assert.equal(result.outcome, "spawn_error");
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("simulated Windows tree termination waits for a slow taskkill before declaring the probe drained", { skip }, async t => {
  const f = await executable(t, "setInterval(() => {}, 1000);");
  const killer = path.join(f.root, "taskkill"), marker = path.join(f.root, "tree-stopped");
  await writeFile(killer, `#!${process.execPath}\nsetTimeout(() => { process.kill(-Number(process.argv[3]), 'SIGKILL'); require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1'); }, 800);\n`, { mode: 0o755 });
  const helper = new URL("../src/backends/harbor/observation-probe.js", import.meta.url);
  const result = await runCommand(process.execPath, ["--input-type=module", "-e", `
import { runObservationProbe } from ${JSON.stringify(helper.href)};
import { readFile } from 'node:fs/promises';
process.env.PATH = ${JSON.stringify(f.root)} + ':' + process.env.PATH;
const pending = runObservationProbe(${JSON.stringify(f.file)}, 'docker_info', { env: process.env, signal: new AbortController().signal, timeoutMs: 1000 });
// The fixture has a real POSIX process group; isolate only the cleanup branch as Windows.
Object.defineProperty(process, 'platform', { value: 'win32' });
const result = await pending;
console.log(JSON.stringify({ ...result, treeStopped: await readFile(${JSON.stringify(marker)}, 'utf8') }));
`], { timeoutMs: 10_000 });
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.outcome, "timed_out"); assert.equal(receipt.treeStopped, "1");
});

test("missing Windows taskkill reports cleanup failure only after the probe itself closes", { skip }, async t => {
  const f = await executable(t, "setTimeout(() => { require('node:fs').writeFileSync(__filename + '.closed', '1'); }, 1800);");
  const helper = new URL("../src/backends/harbor/observation-probe.js", import.meta.url);
  const result = await runCommand(process.execPath, ["--input-type=module", "-e", `
import { runObservationProbe } from ${JSON.stringify(helper.href)};
import { readFile } from 'node:fs/promises';
process.env.PATH = '';
const pending = runObservationProbe(${JSON.stringify(f.file)}, 'docker_info', { env: process.env, signal: new AbortController().signal, timeoutMs: 1000 });
Object.defineProperty(process, 'platform', { value: 'win32' });
try { await pending; process.exitCode = 1; }
catch (error) { console.log(JSON.stringify({ code: error.code, closed: await readFile(${JSON.stringify(f.file + ".closed")}, 'utf8') })); }
`], { timeoutMs: 10_000 });
  assert.deepEqual(JSON.parse(result.stdout), { code: "execution_observation_cleanup_failed", closed: "1" });
});

async function cancellableFixture(t: import("node:test").TestContext) {
  const f = await executable(t, `
const fs = require('node:fs'), path = require('node:path');
const root = path.dirname(__filename), role = process.argv[2] === '--version' ? 'harbor' : 'docker';
if (!fs.existsSync(path.join(root, 'ready'))) {
  fs.writeFileSync(path.join(root, role + '.pid'), String(process.pid));
  process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);
} else if (role === 'harbor') console.log('harbor 0.21.0');
else if (process.argv[2] === 'info') console.log(JSON.stringify({ ID: 'fresh-after-cancel', ServerVersion: '28.1.0', OSType: 'linux', Architecture: 'x86_64' }));
else console.log('buildx v0.23.0');
`);
  const env = { ...process.env, HITCH_DOCKER_PATH: f.file, HITCH_HARBOR_PATH: f.file };
  const source = new LocalExecutionObserver({ root: f.root, env });
  const pids = async () => {
    try { return await Promise.all(["harbor", "docker"].map(async role => Number(await readFile(path.join(f.root, `${role}.pid`), "utf8")))); }
    catch { return null; }
  };
  const release = () => writeFile(path.join(f.root, "ready"), "1");
  return { ...f, source, env, pids, release };
}

test("external cancellation waits for both probes and releases the observation lock only after close", { skip }, async t => {
  const f = await cancellableFixture(t), controller = new AbortController();
  await f.source.initialize();
  const pending = f.source.observe(controller.signal); void pending.catch(() => {});
  t.after(async () => { controller.abort(); await pending.catch(() => {}); });
  const pids = await waitObservation(f.pids);
  await assert.rejects(f.source.observe(), { code: "execution_observation_busy" });
  const reason = new Error("caller cancelled observation"); controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.ok(pids.every(dead), "all parallel probes must be stopped before cancellation returns");
  await f.release();
  const fresh = await f.source.observe();
  assert.equal(fresh.environment.docker.engine_id, "fresh-after-cancel");
  assert.equal(fresh.diagnostics?.probes.filter(p => p.probe === "docker_info").length, 1);
});

test("disconnecting a local observation HTTP request cancels and drains its probes", { skip }, async t => {
  const f = await cancellableFixture(t), controller = new AbortController();
  const server = new DaemonServer({ root: f.root, port: 0, maxConcurrent: 1, logger: () => {}, credentialEnv: f.env, executionObserver: f.source });
  t.after(async () => { controller.abort(); await server.close(); });
  await server.start();
  const client = await daemonClient(f.root);
  const request = client.request("/v2/execution-observation", { method: "POST", signal: controller.signal,
    body: JSON.stringify({ schema_version: "2", provider: "local-docker", nonce: "a".repeat(32) }) });
  void request.catch(() => {});
  const pids = await waitObservation(f.pids);
  controller.abort(); await assert.rejects(request);
  await waitObservation(async () => pids.every(dead));
  await f.release();
  const fresh = await waitObservation(async () => {
    try { return await f.source.observe(); }
    catch (error) { if ((error as { code?: string }).code === "execution_observation_busy") return null; throw error; }
  });
  assert.equal(fresh.environment.docker.status, "available");
});
