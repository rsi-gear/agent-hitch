import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { importDeepseekNativeSession } from "../src/trajectories/providers/deepseek.js";
import { loadCanonicalTrajectorySource, projectTrajectoryAnalysis, loadTrajectoryRef, readTrajectory } from "../src/trajectories/index.js";
import { executeRun, newRunId } from "../src/runs/index.js";
import { modernDshSession } from "../test-support/dsh-modern-session.js";
import { forceRemove } from "../test-support/helpers.js";
import type { SessionEvent, SessionHeaderLine } from "../src/domain/index.js";

function legacyDshSession(brokenBrackets = false): { header: SessionHeaderLine; events: SessionEvent[] } {
  const header: SessionHeaderLine = { type: "session", version: 0, id: "legacy-session", createdAt: 1, delegationDepth: 0 };
  const bodies = [
    { type: "session/end-seed", data: {} },
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "request/context", data: { provider: "test", model: "legacy", contextWindow: 272000 } },
    { type: "assistant/message", data: { turn: 1, step: 1, message: {
      id: "answer", role: "assistant", source: { kind: "model", provider: "test", model: "legacy" },
      content: [{ type: "text", text: "legacy final" }],
    } }, surfaceOp: "append" as const },
    { type: "step/end", data: { turn: 1, step: 1 } },
    ...(!brokenBrackets ? [{ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }] : []),
  ];
  return { header, events: bodies.map((body, seq) => ({ ...body, seq, time: seq + 1 })) };
}

for (const brokenBrackets of [false, true]) {
  test(`native v0 metadata preserves evidence and ${brokenBrackets ? "rejects an open turn" : "imports successfully"}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-dsh-v0-metadata-"));
    t.after(() => forceRemove(root));
    const runtimeHome = path.join(root, "runtime");
    const runDirectory = path.join(root, "run");
    const { header, events } = legacyDshSession(brokenBrackets);
    const rows = [header, ...events];
    await writeSession(runtimeHome, "session.jsonl", rows);
    const importing = importDeepseekNativeSession({ runtimeHome, runDirectory, runId: newRunId(), status: "succeeded" });
    if (brokenBrackets) {
      await assert.rejects(importing, /open turn/);
    } else {
      const imported = await importing;
      assert.ok(imported);
      assert.equal(imported.header.version, 0);
      assert.equal(imported.finalOutput, "legacy final");
      assert.deepEqual(imported.events, events.map((event) =>
        ["request/context", "session/end-seed"].includes(event.type) ? { ...event, ignorable: true } : event));
      const canonical = path.join(root, "canonical.jsonl");
      await writeFile(canonical, [imported.header, ...imported.events].map((row) => JSON.stringify(row)).join("\n"));
      assert.deepEqual((await readTrajectory(canonical)).events, imported.events);
    }
    const provider = await readFile(path.join(runDirectory, "trajectory/provider/deepseek-session.jsonl"), "utf8");
    assert.deepEqual(provider.trim().split("\n").map((line) => JSON.parse(line)), rows);
  });
}

async function writeSession(runtimeHome: string, filename: string, rows: unknown[], directory = "primary"): Promise<void> {
  const target = path.join(runtimeHome, "sessions", directory, filename);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

for (const version of [2, 3, 4] as const) {
  test(`native v${version} import selects the current generation and preserves child evidence`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-dsh-generation-"));
    t.after(() => forceRemove(root));
    const fixture = modernDshSession(version);
    const end = fixture.events.pop()!;
    fixture.events.push({ type: "request/context", seq: end.seq, time: end.time,
      data: { provider: "test", model: "modern", contextWindow: 272000 } }, { ...end, seq: end.seq + 1 });
    const runtimeHome = path.join(root, "runtime");
    // A predecessor, an unsupported temporary publication, and a child are not extra roots.
    await writeSession(runtimeHome, "session.jsonl.zstd", [{ version: 0 }]);
    await writeSession(runtimeHome, "session.v99.jsonl.tmp", [{}]);
    await writeSession(runtimeHome, `session.v${version}.jsonl`, [fixture.header, ...fixture.events]);
    await writeSession(runtimeHome, `session.v${version}.jsonl`, [
      { ...fixture.header, id: "child", parentSession: fixture.header.id, origin: "subagent", delegationDepth: 1 },
    ], "child");
    const runDirectory = path.join(root, "run");
    const imported = await importDeepseekNativeSession({ runtimeHome, runDirectory, runId: newRunId(), status: "succeeded" });
    assert.ok(imported);
    assert.equal(imported.header.version, version);
    assert.equal(imported.header.isSeeded, false);
    assert.equal(imported.finalOutput, "modern final");
    assert.equal(imported.effectiveModel, "deepseek-v4-flash");
    assert.deepEqual(imported.events, fixture.events);
    assert.equal(imported.providerFiles.length, 2);
    const provider = await readFile(path.join(runDirectory, "trajectory/provider/deepseek-session.jsonl"), "utf8");
    assert.deepEqual(provider.trim().split("\n").map((line) => JSON.parse(line)), [fixture.header, ...fixture.events]);
  });
}

for (const failure of ["future", "mismatch", "corrupt", "compressed"] as const) {
  test(`native discovery refuses ${failure} current generation without falling back`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-dsh-refusal-"));
    t.after(() => forceRemove(root));
    const fixture = modernDshSession(3);
    const runtimeHome = path.join(root, "runtime");
    const runDirectory = path.join(root, "run");
    await writeSession(runtimeHome, "session.v3.jsonl", [fixture.header, ...fixture.events]);
    const filename = failure === "future" ? "session.v5.jsonl" : failure === "compressed" ? "session.v4.jsonl.zstd" : "session.v4.jsonl";
    await writeSession(runtimeHome, filename, [
      { ...fixture.header, version: failure === "future" ? 5 : failure === "mismatch" ? 3 : 4 },
      ...(failure === "corrupt" ? [{ type: "turn/start", seq: 9, time: 1, data: { turn: 1 } }] : fixture.events),
    ]);
    await assert.rejects(importDeepseekNativeSession({ runtimeHome, runDirectory, runId: newRunId(), status: "succeeded" }),
      /unsupported session format|filename version|seq gap|compressed native session/);
    if (failure !== "compressed") {
      const provider = await readFile(path.join(runDirectory, "trajectory/provider/deepseek-session.jsonl"), "utf8");
      assert.equal(JSON.parse(provider.split("\n")[0]!).version, failure === "future" ? 5 : failure === "mismatch" ? 3 : 4);
    }
  });
}

for (const version of [0, 3, 4] as const) {
  test(`DeepSeek v${version} execution captures native output and produces a readable analysis`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-dsh-modern-run-"));
    t.after(() => forceRemove(root));
    const fixture = version === 0 ? legacyDshSession() : modernDshSession(version);
    const executable = path.join(root, "dsh.cjs");
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('${version === 0 ? "0.1.1-rc.2" : "0.1.7-rc.1"}'); process.exit(0); }
const patch = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--patch') + 1], 'utf8'));
const persistence = patch.find(row => row.id === 'session-persistence-jsonl').config;
if ('packChunks' in persistence || persistence.compression !== 'none') process.exit(7);
const target = path.join(persistence.root, 'primary', '${version === 0 ? "session.jsonl" : `session.v${version}.jsonl`}');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, ${JSON.stringify([fixture.header, ...fixture.events].map((row) => JSON.stringify(row)).join("\n") + "\n")});
console.log('stdout fallback');
`, { mode: 0o755 });
    const previous = process.env.HITCH_DEEPSEEK_PATH;
    process.env.HITCH_DEEPSEEK_PATH = executable;
    t.after(() => { if (previous === undefined) delete process.env.HITCH_DEEPSEEK_PATH; else process.env.HITCH_DEEPSEEK_PATH = previous; });
    const runId = newRunId();
    const runsRoot = path.join(root, "runs");
    const runDirectory = path.join(runsRoot, runId);
    const result = await executeRun({ runId, runsRoot, request: {
      agent: "deepseek", cwd: root, prompt: "hello", timeout_ms: 5_000, agent_args: [],
    } });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(result.output, version === 0 ? "legacy final" : "modern final");
    const ref = await loadTrajectoryRef(runDirectory);
    assert.ok(ref);
    assert.equal(ref.fidelity, "provider_native");
    const canonical = await readTrajectory(ref.path);
    assert.equal(canonical.header.version, version);
    assert.deepEqual(canonical.events, fixture.events.map((event) =>
      version === 0 && ["request/context", "session/end-seed"].includes(event.type) ? { ...event, ignorable: true } : event));
    const source = await loadCanonicalTrajectorySource(runDirectory, runId);
    assert.ok(source);
    const analysis = await projectTrajectoryAnalysis(source);
    assert.equal(analysis.surface.fidelity, "exact");
    if (version >= 3) assert.ok(analysis.surface.nodes.some((node) => node.event_type === "system/message"));
    if (version === 4) assert.ok(analysis.surface.nodes.some((node) => node.event_type === "developer/message"));
    if (version >= 3) assert.ok(analysis.chunk_summaries.length > 0);
  });
}
