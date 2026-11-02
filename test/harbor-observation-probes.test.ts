import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { observeHarborEnvironment } from "../src/backends/index.js";
import type { ExecutionObservationProbeV1 } from "../src/domain/index.js";
import { parseExecutionObservationDiagnostics } from "../src/control-plane/execution-observation-contract.js";
import { sha256JSON } from "../src/foundation/index.js";
import { forceRemove } from "../test-support/helpers.js";

// POSIX executable fixtures exercise real subprocesses, not Windows local Docker support.
const skip = process.platform === "win32";
const secret = "probe-private-token-never-publish";
async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-observation-probes-"));
  t.after(() => forceRemove(root));
  const control = path.join(root, "control.json"), count = path.join(root, "count"), calls = path.join(root, "calls.jsonl");
  const docker = path.join(root, "docker"), harbor = path.join(root, "harbor");
  await writeFile(harbor, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, 'harbor\\n'); console.log('harbor 0.21.0');\n`, { mode: 0o755 });
  await writeFile(docker, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), control = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'buildx') {
  if (control.buildxFail) { console.error(${JSON.stringify(secret)}); process.exit(9); }
  console.log('buildx v0.23.0'); process.exit(0);
}
const n = Number(fs.existsSync(${JSON.stringify(count)}) ? fs.readFileSync(${JSON.stringify(count)}, 'utf8') : 0);
fs.writeFileSync(${JSON.stringify(count)}, String(n + 1));
const mode = control.modes[Math.min(n, control.modes.length - 1)];
const info = { ID: control.engine || 'fixture-engine', ServerVersion: '28.1.0', OSType: 'linux', Architecture: 'x86_64' };
if (mode === 'nonzero') { console.log(${JSON.stringify(secret)}); console.error(${JSON.stringify(secret)}); process.exit(7); }
else if (mode === 'signal') process.kill(process.pid, 'SIGUSR2');
else if (mode === 'invalid_json') console.log('not JSON ' + ${JSON.stringify(secret)});
else if (mode === 'invalid_fields') console.log(JSON.stringify({ ...info, ServerVersion: '28.1.0junk' }));
else if (mode === 'overflow') process.stdout.write(' '.repeat(1024 * 1024 + 100) + JSON.stringify(info));
else if (mode === 'invalid_encoding') process.stdout.write(Buffer.from([0xff]));
else if (mode === 'replace') { fs.appendFileSync(__filename, '\\n// replacement\\n'); process.exit(7); }
else if (mode === 'unlink') { fs.unlinkSync(__filename); console.log(JSON.stringify(info)); }
else if (mode === 'utf8') {
  const bytes = Buffer.from(JSON.stringify({ ...info, ID: '引擎-一' }));
  const cut = bytes.indexOf(Buffer.from('引')) + 1;
  process.stdout.write(bytes.subarray(0, cut)); setTimeout(() => process.stdout.write(bytes.subarray(cut)), 20);
} else console.log(JSON.stringify(info));
`, { mode: 0o755 });
  const set = (modes: string[], extra = {}) => writeFile(control, JSON.stringify({ modes, ...extra }));
  const env = { ...process.env, HITCH_DOCKER_PATH: docker, HITCH_HARBOR_PATH: harbor, OPENAI_API_KEY: secret };
  const observe = async () => {
    const probes: ExecutionObservationProbeV1[] = [];
    const environment = await observeHarborEnvironment({ root, env, onDiagnostic: probe => probes.push(probe) });
    const diagnostics = parseExecutionObservationDiagnostics({ schema_version: "1", probes });
    const serialized = JSON.stringify({ environment, diagnostics });
    assert.equal(serialized.includes(secret), false); assert.equal(serialized.includes(root), false);
    return { environment, diagnostics, probes: probes.filter(p => p.probe === "docker_info") };
  };
  return { root, docker, count, calls, env, set, observe, countCalls: async () => Number(await readFile(count, "utf8")) };
}

test("public observation retries once with fresh Docker info and keeps diagnostics outside the stable identity", { skip }, async t => {
  const f = await fixture(t);
  await f.set(["nonzero", "ok"]);
  const retried = await f.observe();
  assert.equal(retried.environment.docker.status, "available");
  assert.deepEqual(retried.probes.map(p => [p.attempt, p.stage, p.outcome, p.exit_code]), [[1, "command", "nonzero_exit", 7], [2, "complete", "ok", 0]]);
  assert.equal(Object.hasOwn(retried.environment, "diagnostics"), false);
  await f.set(["ok"]);
  const clean = await f.observe();
  assert.equal(clean.probes.length, 1);
  assert.equal(sha256JSON(clean.environment), sha256JSON(retried.environment));
  assert.notDeepEqual(clean.diagnostics, retried.diagnostics);
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n");
  assert.equal(calls.filter(call => call === "harbor").length, 2, "one inventoried Harbor version command per observation");
  await f.set(["ok"], { engine: "changed-engine" });
  const changed = await f.observe();
  assert.equal(changed.probes.length, 1, "a valid changed identity must not be retried until the old identity reappears");
  assert.notEqual(sha256JSON(changed.environment), sha256JSON(clean.environment));
  assert.equal(changed.environment.docker.engine_id, "changed-engine");
});

for (const [mode, stage, outcome] of [
  ["invalid_json", "parse", "invalid_json"], ["invalid_fields", "validate", "invalid_fields"], ["signal", "command", "signal_exit"],
] as const) {
  test(`public Docker observation classifies ${outcome} before a fresh successful attempt`, { skip }, async t => {
    const f = await fixture(t); await f.set([mode, "ok"]);
    const result = await f.observe();
    assert.equal(result.environment.docker.status, "available");
    assert.equal(await f.countCalls(), 2);
    assert.equal(result.probes[0]?.stage, stage); assert.equal(result.probes[0]?.outcome, outcome);
    if (mode === "signal") assert.equal(result.probes[0]?.signal, "other");
    assert.equal(result.probes[1]?.outcome, "ok");
  });
}

test("repeated Docker failures return unavailable after two attempts with safe terminal diagnostics", { skip }, async t => {
  const f = await fixture(t); await f.set(["nonzero"]);
  const result = await f.observe();
  assert.equal(result.environment.docker.status, "unavailable");
  assert.equal(result.environment.buildx.status, "unavailable");
  assert.equal(await f.countCalls(), 2);
  assert.deepEqual(result.probes.map(p => p.outcome), ["nonzero_exit", "nonzero_exit"]);
  assert.equal(result.diagnostics.probes.some(p => p.probe === "buildx_version"), false);
});

for (const [mode, stage, outcome] of [
  ["replace", "identity", "executable_changed"], ["unlink", "identity", "io_error"],
  ["overflow", "command", "output_limit"], ["invalid_encoding", "parse", "invalid_encoding"],
] as const) {
  test(`public Docker observation never retries ${outcome}`, { skip }, async t => {
    const f = await fixture(t); await f.set([mode, "ok"]);
    const result = await f.observe();
    assert.equal(result.environment.docker.status, "unavailable"); assert.equal(await f.countCalls(), 1);
    assert.equal(result.probes.length, 1);
    assert.equal(result.probes[0]?.stage, stage); assert.equal(result.probes[0]?.outcome, outcome);
  });
}

test("Docker JSON is decoded only after complete bounded UTF-8 output and buildx failure stays separate", { skip }, async t => {
  const f = await fixture(t); await f.set(["utf8"], { buildxFail: true });
  const result = await f.observe();
  assert.equal(result.environment.docker.engine_id, "引擎-一");
  assert.equal(result.environment.buildx.status, "unavailable");
  assert.equal(result.diagnostics.probes.find(p => p.probe === "buildx_version")?.outcome, "nonzero_exit");
  assert.equal(result.probes.length, 1);
});

test("missing launchers have a single resolve diagnostic and no second attempt", { skip }, async t => {
  const f = await fixture(t), probes: ExecutionObservationProbeV1[] = [];
  const result = await observeHarborEnvironment({ root: f.root,
    env: { PATH: "", HITCH_HARBOR_PATH: "/missing/harbor", HITCH_DOCKER_PATH: "/missing/docker" }, onDiagnostic: probe => probes.push(probe) });
  assert.equal(result.docker.status, "unavailable");
  assert.deepEqual(probes.map(p => [p.stage, p.outcome, p.attempt]), [["resolve", "not_found", 1], ["resolve", "not_found", 1]]);
  parseExecutionObservationDiagnostics({ schema_version: "1", probes });
});
