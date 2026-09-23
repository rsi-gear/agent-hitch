import test from "node:test";
import assert from "node:assert/strict";
import { decodeDeepseekEventRows } from "../src/trajectories/providers/deepseek-codec.js";

function marker(seq: number): Record<string, unknown> {
  return { type: "session/end-seed", seq, time: 1_000 + seq, data: {} };
}

function packed(type: string, seq0 = 0, data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type, seq0, time0: 1_000,
    data: { turn: 1, step: 2, index: 3, dt: [7, -2], texts: ["a", "", "b"], ...data },
  };
}

test("DSH v0/v1 physical chunk runs preserve coordinates, timestamps, and delta boundaries", () => {
  for (const version of [0, 1]) {
    const input = [
      marker(0),
      packed("text-chunks", 1),
      packed("reasoning-chunks", 4, { index: 4 }),
      { type: "tool-call-chunks", seq0: 7, time0: 1_040, data: {
        turn: 1, step: 2, index: 5, id: "call-1", name: "bash", dt: [3], args: ["{", "}"],
      } },
      marker(9),
    ];
    const before = structuredClone(input);
    const events = decodeDeepseekEventRows(input, version);
    assert.deepEqual(events.map((event) => event.seq), Array.from({ length: 10 }, (_, seq) => seq));
    assert.deepEqual(events.slice(1, 4).map((event) => event.time), [1_000, 1_007, 1_005]);
    assert.deepEqual(events[2], { type: "assistant/chunk", seq: 2, time: 1_007,
      data: { turn: 1, step: 2, chunk: { type: "text-delta", index: 3, text: "" } } });
    assert.deepEqual(events[4]!.data, { turn: 1, step: 2, chunk: { type: "reasoning-delta", index: 4, text: "a" } });
    assert.deepEqual(events[8], { type: "assistant/chunk", seq: 8, time: 1_043,
      data: { turn: 1, step: 2, chunk: { type: "tool-call-delta", index: 5,
        id: "call-1", name: "bash", argumentsDelta: "}" } } });
    assert.deepEqual(input, before, "decoding must not mutate provider evidence");
  }
});

test("DSH packed tool runs preserve an absent tool name and a singleton payload", () => {
  const events = decodeDeepseekEventRows([{ type: "tool-call-chunks", seq0: 0, time0: 20,
    data: { turn: 1, step: 1, index: 0, id: "call-1", dt: [], args: [""] } }], 0);
  assert.deepEqual(events[0]!.data, { turn: 1, step: 1,
    chunk: { type: "tool-call-delta", index: 0, id: "call-1", argumentsDelta: "" } });
});

test("DSH all known generations expand physical source ranges without changing event metadata", () => {
  for (const version of [0, 1, 2, 3, 4]) {
    const prefix = Array.from({ length: 6 }, (_, seq) => marker(seq));
    const replacement = version >= 3
      ? { op: "replace", startSeq: 0, endSeq: 5 }
      : { op: "replace", start: 0, end: 5 };
    const row = { type: "user/message", seq: 6, time: 1_100,
      data: { id: "summary", role: "user", source: { kind: "human" }, content: [] },
      surfaceOp: replacement, sourceEventSeqs: [[0, 2], 4, 5] };
    const before = structuredClone(row);
    const event = decodeDeepseekEventRows([...prefix, row], version).at(-1)!;
    assert.deepEqual(event.sourceEventSeqs, [0, 1, 2, 4, 5]);
    assert.deepEqual(event.surfaceOp, replacement);
    assert.deepEqual(event.data, row.data);
    assert.deepEqual(row, before);
  }
});

test("DSH source references preserve non-increasing scalar order and explicit empty arrays", () => {
  const prefix = Array.from({ length: 3 }, (_, seq) => marker(seq));
  const row = { type: "user/message", seq: 3, time: 1_100, data: {}, surfaceOp: "append" };
  assert.deepEqual(decodeDeepseekEventRows([...prefix, { ...row, sourceEventSeqs: [2, 0, 1] }], 0).at(-1)!.sourceEventSeqs, [2, 0, 1]);
  assert.deepEqual(decodeDeepseekEventRows([{ ...row, seq: 0, sourceEventSeqs: [] }], 0)[0]!.sourceEventSeqs, []);
});

test("DSH modern generations refuse historical packed top-level rows", () => {
  for (const version of [2, 3, 4]) {
    for (const type of ["text-chunks", "reasoning-chunks", "tool-call-chunks"]) {
      assert.throws(() => decodeDeepseekEventRows([packed(type)], version), /does not support packed top-level/);
    }
  }
});

test("DSH packed rows reject malformed framing before returning a partial decode", () => {
  const malformed = [
    { ...packed("text-chunks"), surprise: true },
    packed("text-chunks", 0, { surprise: true }),
    packed("text-chunks", 0, { texts: [] }),
    packed("text-chunks", 0, { texts: ["a", 5, "b"] }),
    packed("text-chunks", 0, { dt: [1] }),
    packed("text-chunks", 0, { dt: [0.5, 1] }),
    packed("text-chunks", 0, { index: -1 }),
    packed("text-chunks", 0, { step: -0 }),
    { ...packed("text-chunks", 0, { dt: [1, 1] }), time0: Number.MAX_SAFE_INTEGER },
    { ...packed("text-chunks"), time0: NaN },
    { type: "tool-call-chunks", seq0: 0, time0: 1_000,
      data: { turn: 1, step: 1, index: 0, id: "", dt: [], args: ["{}"] } },
    { type: "tool-call-chunks", seq0: 0, time0: 1_000,
      data: { turn: 1, step: 1, index: 0, id: "call", name: 4, dt: [], args: ["{}"] } },
  ];
  for (const row of malformed) assert.throws(() => decodeDeepseekEventRows([row], 0));
});

test("DSH scalar and packed rows must have one dense sequence starting at zero", () => {
  for (const rows of [
    [marker(1)], [marker(0), marker(0)], [marker(0), marker(2)],
    [packed("text-chunks", 1)], [packed("text-chunks"), marker(2)],
    [{ ...marker(0), seq: Number.MAX_SAFE_INTEGER, sourceEventSeqs: [[0, Number.MAX_SAFE_INTEGER - 1]] }],
  ]) assert.throws(() => decodeDeepseekEventRows(rows, 0), /seq gap/);
  for (const seq of [-0, -1, 0.5, Infinity]) {
    assert.throws(() => decodeDeepseekEventRows([{ ...marker(0), seq }], 0));
  }
  for (const time of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => decodeDeepseekEventRows([{ ...marker(0), time }], 0));
  }
});

test("DSH ranges reject out-of-bounds, duplicate, malformed, and noncanonical references", () => {
  const prefix = Array.from({ length: 4 }, (_, seq) => marker(seq));
  const invalid = [
    "0", [null], [[0]], [[0, 1, 2]], [[2, 1]], [[0, Number.MAX_SAFE_INTEGER]],
    [[-1, 0]], [[0.5, 1]], [[0, 4]], [4], [-0], [0, 0], [[0, 1], 1],
    [3, [0, 1]], [[0, 2], [2, 3]], [0, 1, 2, 3, 0], [[0, Infinity]],
  ];
  for (const version of [0, 1, 2, 3, 4]) {
    for (const sourceEventSeqs of invalid) {
      assert.throws(() => decodeDeepseekEventRows([
        ...prefix, { ...marker(4), sourceEventSeqs },
      ], version), /sourceEventSeqs/);
    }
  }
});

test("DSH row decoder rejects unsupported generations and malformed event envelopes", () => {
  for (const version of [-1, 5, 0.5, NaN]) assert.throws(() => decodeDeepseekEventRows([], version), /unsupported/);
  for (const row of [null, [], "event", { ...marker(0), extra: 1 }, { ...marker(0), ignorable: false }]) {
    assert.throws(() => decodeDeepseekEventRows([row], 0));
  }
});
