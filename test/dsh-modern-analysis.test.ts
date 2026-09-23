import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { SessionEvent, SessionHeaderLine, TrajectoryRefV2 } from "../src/domain/index.js";
import { sha256Bytes } from "../src/foundation/index.js";
import { loadCanonicalTrajectorySource, pageTrajectoryEvents, projectTrajectoryAnalysis } from "../src/trajectories/index.js";
import { iterateEmbeddedAssistantStream, validateEmbeddedAssistantStream } from "../src/trajectories/embedded-stream.js";
import { modernDshSession } from "../test-support/dsh-modern-session.js";
import { forceRemove } from "../test-support/helpers.js";

const RUN_ID = `run_${"a".repeat(32)}`;

for (const version of [2, 3, 4] as const) {
  test(`v${version} analysis preserves native surface seqs and summarizes embedded stream members`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-modern-analysis-"));
    t.after(() => forceRemove(root));
    const fixture = modernDshSession(version);
    const source = await writeSource(root, fixture.header, fixture.events);
    const result = await projectTrajectoryAnalysis(source, { credentialValues: [] });
    assert.equal(result.source.event_count, fixture.events.length);
    assert.deepEqual(result.surface.nodes.map((node) => node.seq), fixture.events.filter((event) => event.surfaceOp).map((event) => event.seq));
    assert.equal(result.surface.nodes.some((node) => node.event_type === "system/message"), version >= 3);
    assert.equal(result.surface.nodes.some((node) => node.event_type === "developer/message"), version === 4);
    assert.equal(result.chunk_summaries.length, 1);
    const assistant = fixture.events.find((event) => (event.data as Record<string, unknown>).step === 2 && event.type === "assistant/message")!;
    const summary = result.chunk_summaries[0] as Record<string, unknown>;
    assert.equal(summary.first_seq, assistant.seq);
    assert.equal(summary.last_seq, assistant.seq);
    assert.equal(summary.model_boundary_seq, assistant.seq);
    assert.equal(summary.count, 7);
    assert.equal(summary.record_count, 5);
    assert.equal(summary.stream_field, "data.stream");
    assert.equal(summary.partial, undefined);
    assert.equal(result.coverage.chunks, "coalesced");
    assert.equal(result.events.some((event) => Object.hasOwn((event as { data: object }).data, "stream")), false);
    const field = await pageTrajectoryEvents(source, { credentialValues: [], canonicalSha256: result.source.canonical_sha256,
      filter: { seq_start: assistant.seq, seq_end: assistant.seq, field: "data.stream.0.delta" } });
    assert.equal((field.events[0] as { value: { preview: string } }).value.preview, "modern final");
    const system = fixture.events.find((event) => event.type === "system/message");
    if (system) {
      const page = await pageTrajectoryEvents(source, { credentialValues: [], canonicalSha256: result.source.canonical_sha256,
        filter: { seq_start: system.seq, seq_end: system.seq, field: "message.content.0.text" } });
      assert.equal((page.events[0] as { value: string }).value, "Be helpful.");
    }
    const schema = JSON.parse(await readFile("docs/schemas/trajectory-analysis.schema.json", "utf8"));
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.equal(validate(result), true, JSON.stringify(validate.errors));
  });
}

test("embedded partial attempts keep separate block identities, bounded redaction and native drill pointers", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-modern-partial-"));
  t.after(() => forceRemove(root));
  const fixture = modernDshSession(4);
  const events = fixture.events.slice(0, fixture.events.findIndex((event) => event.type === "assistant/message"));
  const text = `prefix ${"x".repeat(80_000)}`;
  const stream = [
    { type: "chunk", time: 10, chunk: { type: "block-start", index: 0, blockType: "text" } },
    { type: "text-chunks", time0: 11, index: 0, dt: [1], texts: [text, "sk-1234567890"] },
    { type: "text-chunks", time0: 11, index: 0, dt: [], texts: ["1234567890 suffix"] },
    { type: "chunk", time: 12, chunk: { type: "block-start", index: 1, blockType: "reasoning" } },
    { type: "reasoning-chunks", time0: 13, index: 1, dt: [], texts: ["reason"] },
    { type: "chunk", time: 14, chunk: { type: "block-start", index: 2, blockType: "tool-call" } },
    { type: "tool-call-chunks", time0: 15, index: 2, id: "call", name: "read", dt: [1], args: ["{\"path\":", "\"ok\"}"] },
  ];
  const seq = events.length;
  events.push({ type: "assistant/attempt", seq, time: 100, data: { turn: 1, step: 1, stream } });
  const source = await writeSource(root, fixture.header, events);
  const credentialValues = ["sk-12345678901234567890"];
  const result = await projectTrajectoryAnalysis(source, { credentialValues, maxBytes: 64 * 1024 });
  assert.equal(result.coverage.chunks, "partial");
  assert.equal(result.surface.nodes.some((node) => node.seq === seq), false);
  assert.equal(result.surface.request_boundaries[0]?.boundary_seq, seq);
  const summary = result.chunk_summaries[0] as { partial: { source_seq_count: number; source_chunk_count: number; streams: Array<{ content: { source: { field: string }; preview: string; tail?: string; sha256: string } }> } };
  assert.equal(summary.partial.source_seq_count, 1);
  assert.equal(summary.partial.source_chunk_count, 6);
  assert.deepEqual(summary.partial.streams.map((entry) => entry.content.source.field), ["data.stream.0.delta", "data.stream.3.delta", "data.stream.5.delta"]);
  for (const entry of summary.partial.streams) {
    const page = await pageTrajectoryEvents(source, { credentialValues, canonicalSha256: result.source.canonical_sha256,
      filter: { seq_start: seq, seq_end: seq, field: entry.content.source.field } });
    assert.equal((page.events[0] as { value: { sha256: string } }).value.sha256, entry.content.sha256);
    assert.doesNotMatch(JSON.stringify(page), /sk-1234567890/);
  }
  const page = await pageTrajectoryEvents(source, { credentialValues, filter: { seq_start: seq, seq_end: seq } });
  assert.doesNotMatch(JSON.stringify(page), /sk-1234567890/);
  assert.match(JSON.stringify(page), /STREAM_DELTA_OMITTED/);
  const schema = JSON.parse(await readFile("docs/schemas/trajectory-analysis.schema.json", "utf8"));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
});

test("distinct embedded settlements get distinct attempt boundaries without retry extension events", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-modern-attempts-"));
  t.after(() => forceRemove(root));
  const fixture = modernDshSession(4);
  const events = fixture.events.slice(0, fixture.events.findIndex((event) => event.type === "assistant/message"));
  for (let index = 0; index < 2; index += 1) {
    events.push({ type: "assistant/attempt", seq: events.length, time: 100 + index, data: { turn: 1, step: 1,
      stream: [{ type: "chunk", time: 99, chunk: { type: "finish", reason: { kind: "error", failure: { code: "SERVER", message: "failed" } } } }] } });
  }
  const result = await projectTrajectoryAnalysis(await writeSource(root, fixture.header, events));
  assert.deepEqual(result.surface.request_boundaries.map((boundary) => boundary.attempt), [0, 1]);
  assert.deepEqual(result.chunk_summaries.map((summary) => (summary as { attempt: number }).attempt), [0, 1]);
});

test("compact streams reconstruct signed timestamp deltas and refuse malformed records", () => {
  const valid = [
    { type: "chunk", time: 9, chunk: { type: "block-start", index: 0, blockType: "text" } },
    { type: "text-chunks", time0: 10, index: 0, dt: [-1, 3], texts: ["a", "b", "c"] },
  ];
  assert.deepEqual([...iterateEmbeddedAssistantStream(valid)].map((item) => item.time), [9, 10, 9, 12]);
  assert.doesNotThrow(() => validateEmbeddedAssistantStream(valid));
  for (const invalid of [
    [{ type: "future" }],
    [valid[0], { ...valid[1], dt: [1] }],
    [valid[0], { ...valid[1], time0: Number.MAX_SAFE_INTEGER, dt: [1, 1] }],
    [{ type: "chunk", time: 1, chunk: { type: "text-delta", index: 0, text: 123 } }],
  ]) assert.throws(() => validateEmbeddedAssistantStream(invalid));
});

test("modern compact deltas without block-start remain valid and drillable", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-modern-implicit-block-"));
  t.after(() => forceRemove(root));
  const fixture = modernDshSession(2);
  const events = fixture.events.slice(0, fixture.events.findIndex((event) => event.type === "assistant/message"));
  const seq = events.length;
  const stream = [{ type: "text-chunks", time0: 3, index: 0, dt: [1], texts: ["implicit ", "start"] }];
  assert.doesNotThrow(() => validateEmbeddedAssistantStream(stream));
  events.push({ type: "assistant/attempt", seq, time: 10, data: { turn: 1, step: 1, stream } });
  const source = await writeSource(root, fixture.header, events);
  const result = await projectTrajectoryAnalysis(source, { credentialValues: [] });
  const summary = result.chunk_summaries[0] as { partial: { content: { preview: string; source: { field: string } } } };
  assert.equal(summary.partial.content.preview, "implicit start");
  assert.equal(summary.partial.content.source.field, "data.stream.0.delta");
  const page = await pageTrajectoryEvents(source, { credentialValues: [], canonicalSha256: result.source.canonical_sha256,
    filter: { seq_start: seq, seq_end: seq, field: summary.partial.content.source.field } });
  assert.equal((page.events[0] as { value: { preview: string } }).value.preview, "implicit start");
});

async function writeSource(root: string, header: SessionHeaderLine, events: SessionEvent[]) {
  const runDirectory = path.join(root, RUN_ID);
  const relative = "trajectory/canonical/session.jsonl";
  const filename = path.join(runDirectory, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  const content = [ { ...header, id: RUN_ID }, ...events ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  await writeFile(filename, content);
  const providerRelative = "trajectory/provider/session.jsonl";
  await mkdir(path.dirname(path.join(runDirectory, providerRelative)), { recursive: true });
  await writeFile(path.join(runDirectory, providerRelative), content);
  const ref: TrajectoryRefV2 = { schema_version: "2", run_id: RUN_ID, fidelity: "provider_native", provider: "deepseek", files: [
    { role: "canonical_session", path: relative, media_type: "application/x-ndjson", sha256: sha256Bytes(content), bytes: Buffer.byteLength(content) },
    { role: "provider_events", path: providerRelative, media_type: "application/x-ndjson", sha256: sha256Bytes(content), bytes: Buffer.byteLength(content) },
  ] };
  await writeFile(path.join(runDirectory, "trajectory.ref.json"), JSON.stringify(ref));
  const source = await loadCanonicalTrajectorySource(runDirectory, RUN_ID);
  assert.ok(source);
  return source;
}
