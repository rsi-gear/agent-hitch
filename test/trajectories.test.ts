import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TrajectoryProjector } from "../src/trajectories/projector.js";
import { TrajectoryWriter, readTrajectory, validateTrajectoryInvariants, trajectoryRef, loadTrajectoryRef } from "../src/trajectories/store.js";
import { encodeSegment, decodeSegment, projectKey, logPath } from "../src/trajectories/format.js";
import { TRAJECTORY_FORMAT, CONTRACT_COMMIT } from "../src/trajectories/contract.js";
import type { NormalizedEvent } from "../src/adapters.js";
import type { SessionEvent } from "../src/domain/types.js";
import { forceRemove } from "../test-support/helpers.js";
import { ProviderCaptureWriter } from "../src/trajectories/native.js";

function normalizedEvents(overrides: NormalizedEvent[] = []): NormalizedEvent[] {
  return [
    { type: "session.created", session_id: "native-1" },
    { type: "message.delta", text: "Hello " },
    { type: "message.delta", text: "world" },
    { type: "message.completed", text: "Hello world" },
    { type: "tool.started", call_id: "call_1", name: "read" },
    { type: "tool.completed", call_id: "call_1", status: "succeeded", output: "file contents" },
    { type: "usage.updated", usage: { input_tokens: 5, output_tokens: 2 } },
    ...overrides,
  ];
}

test("projector emits a closed turn with contiguous seq and paired tools", () => {
  const projector = new TrajectoryProjector({
    runId: "run_00000000000000000000000000000000",
    cwd: "/workspace",
    prompt: "please work",
    model: "deepseek/test-model",
    fidelity: "normalized",
  });
  for (const event of normalizedEvents()) projector.feed(event);
  const session = projector.finalize("succeeded");

  assert.equal(session.finalOutput, "Hello world");
  assert.equal(session.fidelity, "normalized");
  assert.equal(session.providerSessionId, "native-1");
  // seq starts at 0 and stays contiguous
  session.events.forEach((event, index) => assert.equal(event.seq, index));
  assert.equal(session.events[0]?.type, "turn/start");
  const last = session.events.at(-1);
  assert.equal(last?.type, "turn/end");
  validateTrajectoryInvariants(session.header, session.events);
});

test("projector replaces deltas with the authoritative completed text", () => {
  const projector = new TrajectoryProjector({
    runId: "run_11111111111111111111111111111111",
    cwd: "/workspace",
    prompt: "x",
    model: "deepseek/test-model",
    fidelity: "normalized",
  });
  for (const event of normalizedEvents()) projector.feed(event);
  const session = projector.finalize("succeeded");
  const assistant = session.events.find((event) => event.type === "assistant/message");
  assert.ok(assistant);
  const data = assistant.data as { message: { content: Array<{ text?: string }> } };
  assert.equal(data.message.content.map((block) => block.text ?? "").join(""), "Hello world");
});

test("tool result pairs with exactly one tool call in the same step", () => {
  const projector = new TrajectoryProjector({
    runId: "run_22222222222222222222222222222222",
    cwd: "/workspace",
    prompt: "x",
    model: "deepseek/test-model",
    fidelity: "normalized",
  });
  for (const event of normalizedEvents()) projector.feed(event);
  const session = projector.finalize("succeeded");
  const calls = session.events.filter((event) => event.type === "tool/call");
  const results = session.events.filter((event) => event.type === "tool/result");
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  const callData = calls[0]?.data as { callId: string };
  const resultData = results[0]?.data as { message: { source: { callId: string } } };
  assert.equal(resultData.message.source.callId, callData.callId);
});

test("an unpaired tool result is recorded as an ignorable event, not a fabricated call", () => {
  const projector = new TrajectoryProjector({
    runId: "run_33333333333333333333333333333333",
    cwd: "/workspace",
    prompt: "x",
    model: "deepseek/test-model",
    fidelity: "normalized",
  });
  for (const event of [
    { type: "session.created" as const, session_id: "s" },
    { type: "message.delta" as const, text: "hi" },
    { type: "tool.completed" as const, call_id: "ghost", status: "succeeded", output: "x" },
  ]) projector.feed(event);
  const session = projector.finalize("succeeded");
  const unpaired = session.events.filter((event) => event.type === "hitch/unpaired-tool-result");
  assert.equal(unpaired.length, 1);
  assert.equal(unpaired[0]?.ignorable, true);
  // No fabricated tool/call event and the trajectory still validates.
  assert.equal(session.events.some((event) => event.type === "tool/call"), false);
  validateTrajectoryInvariants(session.header, session.events);
});

test("timeout finalization emits a terminal aborted boundary with recorded work preserved", () => {
  const projector = new TrajectoryProjector({
    runId: "run_44444444444444444444444444444444",
    cwd: "/workspace",
    prompt: "x",
    model: "deepseek/test-model",
    fidelity: "normalized",
  });
  for (const event of [
    { type: "session.created" as const, session_id: "s" },
    { type: "message.delta" as const, text: "partial " },
  ]) projector.feed(event);
  const session = projector.finalize("timed_out");
  const last = session.events.at(-1);
  assert.equal(last?.type, "turn/end");
  const reason = last?.data as { reason: { kind?: string } };
  assert.equal(reason.reason.kind, "aborted");
  // Recorded work is preserved (the partial text became an interrupted message).
  const assistant = session.events.find((event) => event.type === "assistant/message");
  assert.ok(assistant);
  assert.equal((assistant.data as { interrupted?: true }).interrupted, true);
  validateTrajectoryInvariants(session.header, session.events);
});

test("an interrupted run with an open tool call closes a valid trajectory", () => {
  const projector = new TrajectoryProjector({
    runId: "run_99999999999999999999999999999999",
    cwd: "/workspace",
    prompt: "x",
    model: "deepseek/test-model",
    fidelity: "normalized",
  });
  for (const event of [
    { type: "session.created" as const, session_id: "s" },
    { type: "tool.started" as const, call_id: "call_open", name: "bash" },
  ]) projector.feed(event);
  // finalize() must pair the open tool call with a failed/unknown result
  // before closing the step, so the log validates (spec §5.4).
  const session = projector.finalize("timed_out");
  validateTrajectoryInvariants(session.header, session.events);
  const results = session.events.filter((event) => event.type === "tool/result");
  assert.equal(results.length, 1);
  const resultData = results[0]?.data as { message: { source: { callId: string } }; error?: { code: string } };
  assert.equal(resultData.message.source.callId, "call_open");
  assert.equal(resultData.error?.code, "TOOL_OUTCOME_UNKNOWN");
  // The turn closes with an aborted reason after the paired result.
  const last = session.events.at(-1);
  assert.equal(last?.type, "turn/end");
  const reason = last?.data as { reason: { kind?: string } };
  assert.equal(reason.reason.kind, "aborted");
});

test("empty interrupted runs still close a valid terminal boundary", () => {
  const projector = new TrajectoryProjector({
    runId: "run_55555555555555555555555555555555",
    cwd: "/workspace",
    prompt: "x",
    model: "deepseek/test-model",
    fidelity: "minimal",
  });
  const session = projector.finalize("cancelled");
  assert.equal(session.events.at(-1)?.type, "turn/end");
  validateTrajectoryInvariants(session.header, session.events);
});

test("a successful run with an open tool call fails finalization", () => {
  const projector = new TrajectoryProjector({
    runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    cwd: "/workspace",
    prompt: "x",
    model: "deepseek/test-model",
    fidelity: "normalized",
  });
  for (const event of [
    { type: "session.created" as const, session_id: "s" },
    { type: "message.delta" as const, text: "done" },
    { type: "tool.started" as const, call_id: "call_left_open", name: "bash" },
  ]) projector.feed(event);
  // Only failed/timed_out/cancelled runs may synthesize unknown-outcome
  // results; a success with an open call is a broken trajectory and must
  // fail finalization instead of being recorded as completed (spec §5.4).
  assert.throws(
    () => projector.finalize("succeeded"),
    /run succeeded with open tool calls/,
  );
});

test("late usage.updated after message.completed is attached to the assistant message", () => {
  const projector = new TrajectoryProjector({
    runId: "run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    cwd: "/workspace",
    prompt: "x",
    model: "deepseek/test-model",
    fidelity: "normalized",
  });
  // Pi/OpenCode emit usage after the assistant message completes.
  for (const event of [
    { type: "session.created" as const, session_id: "s" },
    { type: "message.delta" as const, text: "hello" },
    { type: "message.completed" as const, text: "hello" },
    { type: "usage.updated" as const, usage: { input_tokens: 7, output_tokens: 3 } },
  ]) projector.feed(event);
  const session = projector.finalize("succeeded");
  const assistant = session.events.find((event) => event.type === "assistant/message");
  assert.ok(assistant);
  const data = assistant.data as { usage?: { inputTokens: number; outputTokens: number } };
  assert.equal(data.usage?.inputTokens, 7);
  assert.equal(data.usage?.outputTokens, 3);
});

test("writer persists a header plus events and reads them back with invariants", async () => {
  const runDirectory = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-store-"));
  try {
    const projector = new TrajectoryProjector({
      runId: "run_66666666666666666666666666666666",
      cwd: "/workspace",
      prompt: "hello",
      model: "deepseek/test-model",
      fidelity: "normalized",
    });
    for (const event of normalizedEvents()) projector.feed(event);
    const projected = projector.finalize("succeeded");

    const writer = await TrajectoryWriter.open({
      runDirectory,
      cwd: "/workspace",
      sessionId: projected.header.id,
      fidelity: projected.fidelity,
      header: projected.header,
    });
    for (const event of projected.events) writer.append(event);
    const writtenPath = await writer.close();

    const read = await readTrajectory(writtenPath);
    assert.equal(read.header.id, projected.header.id);
    assert.equal(read.header.cwd, "/workspace");
    assert.equal(read.events.length, projected.events.length);
    assert.match(read.sha256, /^sha256:[0-9a-f]{64}$/);
  } finally {
    await forceRemove(runDirectory);
  }
});

test("writer rejects non-contiguous sequence numbers", async () => {
  const runDirectory = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-seq-"));
  try {
    const projector = new TrajectoryProjector({
      runId: "run_77777777777777777777777777777777",
      cwd: "/workspace",
      prompt: "x",
      model: "deepseek/test-model",
      fidelity: "minimal",
    });
    const projected = projector.finalize("succeeded");
    const writer = await TrajectoryWriter.open({
      runDirectory,
      cwd: "/workspace",
      sessionId: projected.header.id,
      fidelity: projected.fidelity,
      header: projected.header,
    });
    const dup: SessionEvent = { type: "turn/end", seq: 99, time: Date.now(), data: { turn: 1 } };
    assert.throws(() => writer.append(dup), /seq must be contiguous/);
    await writer.close();
  } finally {
    await forceRemove(runDirectory);
  }
});

test("trajectory ref pins the DSH contract and path encoding is reversible", () => {
  const ref = trajectoryRef(
    "run_88888888888888888888888888888888",
    "session-1",
    "normalized",
    "/tmp/run/trajectory/session.jsonl",
    "sha256:" + "a".repeat(64),
    "provider-1",
  );
  assert.equal(ref.schema_version, "1");
  assert.equal(ref.format.family, "dsh-session");
  assert.equal(ref.format.version, 0);
  assert.equal(ref.format.contract_commit, CONTRACT_COMMIT);
  assert.equal(ref.format.compression, "none");
  assert.equal(ref.format.pack_chunks, false);
  assert.equal(TRAJECTORY_FORMAT.compression, "none");

  assert.equal(decodeSegment(encodeSegment("../evil/name")), "../evil/name");
  assert.equal(encodeSegment(".."), "~002E~002E");
  assert.equal(encodeSegment("."), "~002E");
  assert.equal(projectKey("/workspace/example"), "--workspace-example--");
  const p = logPath("/root", "/workspace", "session id!");
  assert.ok(p.startsWith(path.join("/root", "--workspace--")));
  assert.ok(p.endsWith("session.jsonl"));
});

test("loadTrajectoryRef returns null when no ref exists", async () => {
  const runDirectory = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-noref-"));
  try {
    assert.equal(await loadTrajectoryRef(runDirectory), null);
  } finally {
    await forceRemove(runDirectory);
  }
});

test("provider capture preserves native event shape while recording explicit redactions", async () => {
  const runDirectory = await mkdtemp(path.join(tmpdir(), "hitch-provider-capture-"));
  try {
    const writer = await ProviderCaptureWriter.open({ runDirectory, structured: true });
    writer.appendJSON({ type: "response.created", id: "evt-1", access_token: "secret-value", text: "Bearer abcdefghijklmnop" });
    const captured = await writer.close();
    assert.equal(captured.file.role, "provider_events");
    assert.equal(path.isAbsolute(captured.file.path), false);
    assert.deepEqual(captured.redactions, [
      { rule_id: "authorization-bearer-v1", count: 1 },
      { rule_id: "sensitive-field-v1", count: 1 },
    ]);
    const event = JSON.parse(await readFile(path.join(runDirectory, ...captured.file.path.split("/")), "utf8")) as Record<string, unknown>;
    assert.equal(event.type, "response.created");
    assert.equal(event.id, "evt-1");
    assert.equal(event.access_token, "[REDACTED]");
    assert.equal(event.text, "Bearer [REDACTED]");
  } finally {
    await forceRemove(runDirectory);
  }
});

test("reader rejects an open turn at the end of the log", () => {
  const header = {
    type: "session" as const,
    version: 0,
    id: "s",
    createdAt: Date.now(),
    delegationDepth: 0,
  };
  const events: SessionEvent[] = [
    { type: "turn/start", seq: 0, time: Date.now(), data: { turn: 1 } },
  ];
  assert.throws(() => validateTrajectoryInvariants(header, events), /open turn/);
});
