import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionEvent, SessionHeaderLine } from "../src/domain/index.js";
import { CONTRACT_COMMIT, READER_CONTRACT_COMMIT, TRAJECTORY_FORMAT } from "../src/trajectories/contract.js";
import { parseEventLine, parseHeaderLine } from "../src/trajectories/format.js";
import { finalizeInterruptedTrajectory, readTrajectory, validateTrajectoryInvariants } from "../src/trajectories/store.js";
import { IncrementalSurfaceFold, surfaceReplacementRange } from "../src/trajectories/surface-fold.js";

function header(version: number): SessionHeaderLine {
  return { type: "session", version, id: "modern-session", createdAt: 1, delegationDepth: 0,
    ...(version >= 2 ? { isSeeded: false } : {}) };
}

function fixture(version: 3 | 4): SessionEvent[] {
  const events: SessionEvent[] = [];
  const append = (type: string, data: unknown, surfaceOp?: SessionEvent["surfaceOp"]): number => {
    const seq = events.length;
    events.push({ type, seq, time: seq + 1, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) });
    return seq;
  };
  append("turn/start", { turn: 1 });
  append("step/start", { turn: 1, step: 1 });
  append("system/message", { turn: 1, step: 1, message: {
    id: "system", role: "system", content: [{ type: "text", text: "Answer precisely" }],
    source: version === 3 ? { kind: "plugin", plugin: "system-prompt" } : { kind: "system-prompt" },
  } }, "append");
  const headerSeq = append("request/header", {
    reason: "series", startsSeries: true,
    header: { config: { provider: "deepseek", model: "deepseek-chat" }, tools: [{ name: "read" }] },
  });
  append("user/message", { id: "user", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Read the file" }] }, "append");
  if (version === 4) append("developer/message", { turn: 1, step: 1, headerSeq, message: {
    id: "developer", role: "developer", source: { kind: "tool-catalog" },
    content: [{ type: "tool-addition", toolName: "read" }],
  } }, "append");
  append("assistant/attempt", { turn: 1, step: 1, stream: [] });
  append("assistant/message", { turn: 1, step: 1, stream: [], message: {
    id: "assistant", role: "assistant", source: { kind: "model", provider: "deepseek", model: "deepseek-chat" },
    content: [{ type: "tool-call", id: "call", name: "read", arguments: "{}" }],
  } }, "append");
  append("tool/call", { turn: 1, step: 1, callId: "call", name: "read", arguments: "{}" });
  const result = (text: string): Record<string, unknown> => ({
    turn: 1, step: 1, message: {
      id: "result", source: { kind: "tool", callId: "call" },
      ...(version === 4 ? { role: "tool", toolCallId: "call", content: [{ type: "text", text }] }
        : { role: "user", content: [{ type: "tool-result", toolCallId: "call", content: [{ type: "text", text }] }] }),
    },
  });
  const resultSeq = append("tool/result", result("original"), "append");
  const replacement = append("tool/result", result("compacted"), { op: "replace", startSeq: resultSeq, endSeq: resultSeq });
  events[replacement]!.sourceEventSeqs = [resultSeq];
  append("step/end", { turn: 1, step: 1 });
  append("turn/end", { turn: 1, reason: { kind: "completed" } });
  return events;
}

test("reader accepts v0-v4 headers while the normalized writer stays pinned to v0", () => {
  for (const version of [0, 1, 2, 3, 4]) assert.deepEqual(parseHeaderLine(header(version)), header(version));
  assert.equal(TRAJECTORY_FORMAT.version, 0);
  assert.equal(TRAJECTORY_FORMAT.contract_commit, CONTRACT_COMMIT);
  assert.equal(READER_CONTRACT_COMMIT, "46a7f68b0922371ce7144b668b90e377d8e799f4");
  assert.throws(() => parseHeaderLine(header(5)), /unsupported session format/);
  assert.throws(() => parseHeaderLine({ ...header(3), isSeeded: undefined }), /isSeeded/);
  assert.throws(() => parseHeaderLine({ ...header(4), seedLength: 1 }), /seedLength/);
  assert.equal(parseHeaderLine({ ...header(2), isSeeded: true }).isSeeded, true);
});

for (const version of [3, 4] as const) {
  test(`v${version} reads native messages and replacements without changing their shape`, async () => {
    const events = fixture(version);
    validateTrajectoryInvariants(header(version), events);
    const fold = new IncrementalSurfaceFold(version);
    for (const event of events) fold.accept(event);
    const replacement = events.find((event) => typeof event.surfaceOp === "object")!;
    assert.deepEqual(parseEventLine(replacement, version), replacement);
    assert.equal(surfaceReplacementRange(replacement.surfaceOp)?.start, replacement.seq - 1);
    assert.equal(fold.currentNodeSeqs.includes(replacement.seq - 1), false);
    const root = await mkdtemp(path.join(tmpdir(), "hitch-dsh-contract-"));
    try {
      const file = path.join(root, "session.jsonl");
      await writeFile(file, [header(version), ...events].map((row) => JSON.stringify(row)).join("\n"));
      const result = await readTrajectory(file);
      assert.deepEqual(result.header, header(version));
      assert.deepEqual(result.events, events);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test(`v${version} rejects obsolete header and surface syntax`, () => {
    const events = fixture(version);
    const request = events.find((event) => event.type === "request/header")!;
    (request.data as { header: Record<string, unknown> }).header.system = "obsolete";
    assert.throws(() => validateTrajectoryInvariants(header(version), events), /retired system/);
    const row = { type: "user/message", seq: 2, time: 1, data: {}, surfaceOp: { op: "replace", start: 0, end: 0 } };
    assert.throws(() => parseEventLine(row, version), /startSeq/);
    assert.throws(() => parseEventLine({ ...row, surfaceOp: { op: "replace", startSeq: 0, endSeq: 0, start: 0 } }, version), /exactly/);
  });

  test(`v${version} rejects assistant provenance and missing embedded streams`, () => {
    const events = fixture(version);
    const assistant = events.find((event) => event.type === "assistant/message")!;
    assistant.sourceEventSeqs = [];
    assert.throws(() => validateTrajectoryInvariants(header(version), events), /cannot carry sourceEventSeqs/);
    delete assistant.sourceEventSeqs;
    delete (assistant.data as Record<string, unknown>).stream;
    assert.throws(() => validateTrajectoryInvariants(header(version), events), /stream must be an array/);
  });
}

test("v4 rejects retired wrapper results and producer attribution", () => {
  const events = fixture(4);
  const result = events.find((event) => event.type === "tool/result")!;
  (result.data as { message: Record<string, unknown> }).message = {
    id: "result", role: "user", source: { kind: "tool", callId: "call" },
    content: [{ type: "tool-result", toolCallId: "call", content: [] }],
  };
  assert.throws(() => validateTrajectoryInvariants(header(4), events), /role tool/);
  const sourceEvents = fixture(4);
  const user = sourceEvents.find((event) => event.type === "user/message")!;
  (user.data as Record<string, unknown>).source = { kind: "plugin", plugin: "user" };
  assert.throws(() => validateTrajectoryInvariants(header(4), sourceEvents), /producer-owned/);
});

test("system head cannot be shadowed by a compaction replacement", () => {
  const fold = new IncrementalSurfaceFold(3);
  for (const event of fixture(3).slice(0, 5)) fold.accept(event);
  assert.throws(() => fold.accept({
    type: "user/message", seq: 20, time: 30, data: {}, sourceEventSeqs: [2, 4],
    surfaceOp: { op: "replace", startSeq: 2, endSeq: 4 },
  }), /protected system head/);
});

test("interrupted v4 native sessions get first-class tool-role recovery results", () => {
  const events = fixture(4);
  const call = events.findIndex((event) => event.type === "tool/call");
  const finalized = finalizeInterruptedTrajectory(header(4), events.slice(0, call + 1), "timed_out");
  const result = finalized.find((event) => event.type === "tool/result")!;
  const message = (result.data as { message: Record<string, unknown> }).message;
  assert.equal(message.role, "tool");
  assert.equal(message.toolCallId, "call");
  assert.equal(message.isError, true);
  validateTrajectoryInvariants(header(4), finalized);
});

test("modern event clocks preserve signed safe integers and reject future provenance", () => {
  const event = { type: "user/message", seq: 1, time: -1, data: {}, surfaceOp: "append" };
  for (const version of [1, 2, 3, 4]) assert.equal(parseEventLine(event, version).time, -1);
  assert.throws(() => parseEventLine({ ...event, sourceEventSeqs: [1] }, 3), /unique earlier/);
  assert.throws(() => parseEventLine({ ...event, sourceEventSeqs: [0, 0] }, 3), /unique earlier/);
});

test("modern lineage metadata agrees with inherited seed markers", () => {
  const events = fixture(4);
  assert.throws(() => validateTrajectoryInvariants({ ...header(4), isSeeded: true }, events), /isSeeded disagrees/);
  events.push({ type: "session/end-seed", seq: events.length, time: 100, data: { inherited: true } });
  validateTrajectoryInvariants({ ...header(4), isSeeded: true }, events);
  assert.throws(() => validateTrajectoryInvariants(header(4), events), /isSeeded disagrees/);
});

function notStartedRepair(version: 3 | 4): { events: SessionEvent[]; result: SessionEvent } {
  const original = fixture(version);
  const events = original.slice(0, original.findIndex((event) => event.type === "tool/call"));
  const text = [{ type: "text", text: "The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed." }];
  const result: SessionEvent = {
    type: "tool/result", seq: events.length, time: events.length + 1, surfaceOp: "append",
    data: { turn: 1, step: 1, error: { name: "ToolNotStartedError", code: "TOOL_NOT_STARTED" }, message: {
      id: `interrupted-tool-result-call-${events.length}`, source: { kind: "tool", callId: "call" },
      ...(version === 4 ? { role: "tool", toolCallId: "call", isError: true, content: text }
        : { role: "user", content: [{ type: "tool-result", toolCallId: "call", isError: true, content: text }] }),
    } },
  };
  events.push(result);
  events.push({ type: "step/end", seq: events.length, time: events.length + 1, data: { turn: 1, step: 1 } });
  events.push({ type: "turn/end", seq: events.length, time: events.length + 1, data: { turn: 1, reason: { kind: "completed" } } });
  return { events, result };
}

for (const version of [3, 4] as const) {
  test(`v${version} accepts exact native repairs of advertised tools that never started`, () => {
    const { events, result } = notStartedRepair(version);
    validateTrajectoryInvariants(header(version), events);
    // Migration preserves historical identity suffixes while changing event coordinates.
    (result.data as { message: Record<string, unknown> }).message.id = "interrupted-tool-result-call-200";
    validateTrajectoryInvariants(header(version), events);
  });

  test(`v${version} rejects orphaned, repeated, and fabricated not-started repairs`, () => {
    for (const invalid of ["orphan", "duplicate", "wrong-call", "wrong-error", "wrong-id", "wrong-content", "provenance"] as const) {
      const { events, result } = notStartedRepair(version);
      const data = result.data as Record<string, unknown>;
      const message = data.message as Record<string, unknown>;
      const content = message.content as Array<Record<string, unknown>>;
      if (invalid === "orphan") {
        const assistant = events.find((event) => event.type === "assistant/message")!;
        (assistant.data as { message: Record<string, unknown> }).message.content = [];
      } else if (invalid === "duplicate") {
        events.splice(result.seq + 1, 0, structuredClone(result));
        events.forEach((event, seq) => { event.seq = seq; });
      } else if (invalid === "wrong-call") {
        message.source = { kind: "tool", callId: "other" };
        message.id = `interrupted-tool-result-other-${result.seq}`;
        if (version === 4) message.toolCallId = "other";
        else content[0]!.toolCallId = "other";
      } else if (invalid === "wrong-error") data.error = { name: "OtherError", code: "TOOL_NOT_STARTED" };
      else if (invalid === "wrong-id") message.id = "interrupted-tool-result-call-01";
      else if (invalid === "wrong-content") {
        const body = version === 4 ? content : content[0]!.content as Array<Record<string, unknown>>;
        body[0]!.text = "fabricated repair";
      } else result.sourceEventSeqs = [result.seq - 1];
      assert.throws(() => validateTrajectoryInvariants(header(version), events), /matching open tool call/, invalid);
    }
  });
}

test("v4 accepts fork-generated not-started repairs only at their original sequence", () => {
  const { events, result } = notStartedRepair(4);
  const message = (result.data as { message: Record<string, unknown> }).message;
  message.id = `forked-tool-result-call-${result.seq}`;
  message.content = [{ type: "text", text: "The fork cut interrupted this tool before it started." }];
  validateTrajectoryInvariants(header(4), events);
  message.id = `forked-tool-result-call-${result.seq - 1}`;
  assert.throws(() => validateTrajectoryInvariants(header(4), events), /matching open tool call/);
});
