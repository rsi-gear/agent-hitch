import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { link, mkdtemp, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SessionEvent, SessionHeaderLine, TrajectoryRefV2 } from "../src/domain/index.js";
import { HitchError, sha256Bytes } from "../src/foundation/index.js";
import {
  loadCanonicalTrajectorySource,
  pageTrajectoryEvents,
  projectTrajectoryAnalysis,
  scanCanonicalTrajectory,
} from "../src/trajectories/index.js";
import { forceRemove } from "../test-support/helpers.js";

const RUN_ID = `run_${"1".repeat(32)}`;
const OTHER_RUN_ID = `run_${"2".repeat(32)}`;
const executable = fileURLToPath(new URL("../bin/hitch.js", import.meta.url));

test("trajectory project and events CLI return compact bounded JSON", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-cli-"));
  t.after(() => forceRemove(root));
  await writeRun(root, RUN_ID, completeEvents());
  const analysis = spawnSync(process.execPath, [
    executable, "--root", root, "trajectory", "project", RUN_ID,
    "--profile", "analysis-v1", "--max-bytes", String(32 * 1024), "--json",
  ], { encoding: "utf8" });
  assert.equal(analysis.status, 0, analysis.stderr || undefined);
  assert.equal(Buffer.byteLength(analysis.stdout) <= 32 * 1024, true);
  const analysisJson = JSON.parse(analysis.stdout) as {
    kind: string;
    source: { canonical_sha256: string };
  };
  assert.equal(analysisJson.kind, "trajectory-analysis");
  const events = spawnSync(process.execPath, [
    executable, "--root", root, "trajectory", "events", RUN_ID,
    "--types", "tool/call,tool/result", "--limit", "1", "--json",
  ], { encoding: "utf8" });
  assert.equal(events.status, 0, events.stderr || undefined);
  assert.equal((JSON.parse(events.stdout) as { events: unknown[] }).events.length, 1);
  const field = spawnSync(process.execPath, [
    executable, "--root", root, "trajectory", "events", RUN_ID,
    "--seq-start", "2", "--seq-end", "2", "--field", "message.content.0.text",
    "--canonical-sha256", analysisJson.source.canonical_sha256, "--json",
  ], { encoding: "utf8" });
  assert.equal(field.status, 0, field.stderr || undefined);
  assert.equal((JSON.parse(field.stdout) as { events: Array<{ value: string }> }).events[0]?.value, "question");
  const overflow = spawnSync(process.execPath, [
    executable, "--root", root, "trajectory", "project", RUN_ID,
    "--max-bytes", "512", "--json",
  ], { encoding: "utf8" });
  assert.equal(overflow.status, 3);
  assert.equal(overflow.stdout, "");
  assert.match(overflow.stderr, /trajectory_projection_overflow/);
});

test("analysis-v1 folds the DSH surface and coalesces chunks without hiding diagnostic history", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-analysis-"));
  t.after(() => forceRemove(root));
  const source = await writeRun(root, RUN_ID, completeEvents());
  const result = await projectTrajectoryAnalysis(source, { credentialValues: [] });

  assert.equal(result.kind, "trajectory-analysis");
  assert.equal(result.source.event_count, 20);
  assert.equal(result.source.event_types["assistant/chunk"], 5);
  assert.equal(result.surface.nodes.length, 5);
  assert.deepEqual(result.surface.current_node_seqs, [14, 17]);
  assert.deepEqual(result.surface.replacements, [{ seq: 14, start: 2, end: 11, shadowed_seqs: [2, 9, 11] }]);
  assert.deepEqual(result.surface.request_boundaries, [
    { turn: 1, step: 1, boundary_seq: 4, surface_revision: 1, request_header_seq: 3 },
    { turn: 1, step: 2, boundary_seq: 17, surface_revision: 4, request_header_seq: 16 },
  ]);
  assert.deepEqual(result.header, { config: { provider: "test", model: "model-2" }, system: "system-2" });
  assert.equal(result.events.some((entry) => (entry as { seq?: number }).seq === 9), true);
  assert.equal(result.events.some((entry) => (entry as { type?: string }).type === "assistant/chunk"), false);
  assert.equal(result.chunk_summaries.length, 1);
  const summary = result.chunk_summaries[0] as Record<string, unknown>;
  assert.deepEqual(summary.types, { "block-end": 1, "block-start": 1, finish: 1, "reasoning-delta": 1, usage: 1 });
  assert.equal(summary.partial, undefined);
  assert.equal(result.omitted_event_types["assistant/chunk"], 5);
  assert.deepEqual(result.coverage, {
    surface: "complete",
    chunks: "coalesced",
    content: "complete",
    child_sessions: "unavailable",
  });
});

test("analysis-v1 emits redacted bounded partial evidence for an interrupted stream", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-partial-"));
  t.after(() => forceRemove(root));
  const events: SessionEvent[] = [
    event(0, "turn/start", { turn: 1 }),
    event(1, "step/start", { turn: 1, step: 1 }),
    surfaceEvent(2, "user/message", message("question"), "append"),
    event(3, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "block-start", index: 0, blockType: "text" },
    }),
    event(4, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "prefix sk-12345678901234567890 suffix" },
    }),
  ];
  const source = await writeRun(root, RUN_ID, events);
  const result = await projectTrajectoryAnalysis(source, { credentialValues: [] });
  const summary = result.chunk_summaries[0] as {
    partial: { status: string; content: { preview: string; bytes: number; sha256: string }; source_seq_count: number };
  };
  assert.equal(result.coverage.chunks, "partial");
  assert.equal(summary.partial.status, "incomplete");
  assert.match(summary.partial.content.preview, /\[REDACTED\]/);
  assert.doesNotMatch(summary.partial.content.preview, /sk-123456/);
  assert.equal(summary.partial.source_seq_count, 1);
  assert.match(summary.partial.content.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.ok(summary.partial.content.bytes > 0);
});

test("analysis-v1 excerpts oversized message fields and never writes beyond its total budget", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-excerpt-"));
  t.after(() => forceRemove(root));
  const hostPath = path.join(root, "runs", RUN_ID);
  const events: SessionEvent[] = [
    event(0, "turn/start", { turn: 1 }),
    event(1, "step/start", { turn: 1, step: 1 }),
    surfaceEvent(2, "user/message", message(`${hostPath}/secret ${"x".repeat(100_000)}`), "append"),
  ];
  const source = await writeRun(root, RUN_ID, events);
  const result = await projectTrajectoryAnalysis(source, { maxBytes: 256 * 1024, credentialValues: [] });
  const node = result.surface.nodes[0] as { message: { content: Array<{ text: Record<string, unknown> }> } };
  assert.equal(node.message.content[0]?.text.truncated, true);
  assert.match(String(node.message.content[0]?.text.preview), /\[REDACTED_PATH\]/);
  assert.doesNotMatch(String(node.message.content[0]?.text.preview), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(Number(node.message.content[0]?.text.bytes) > 100_000);
  assert.equal(result.coverage.content, "excerpted");
  assert.deepEqual(
    await projectTrajectoryAnalysis(source, { maxBytes: 512 * 1024, credentialValues: [] }),
    result,
  );
  const boundedEvent = await pageTrajectoryEvents(source, {
    filter: { seq_start: 2, seq_end: 2 },
    limit: 1,
    maxBytes: 4 * 1024,
    credentialValues: [],
  });
  assert.match(JSON.stringify(boundedEvent.events[0]), /"truncated":true/);
  const expandedEvent = await pageTrajectoryEvents(source, {
    filter: { seq_start: 2, seq_end: 2 },
    limit: 1,
    maxBytes: 128 * 1024,
    credentialValues: [],
  });
  const expandedText = JSON.stringify(expandedEvent.events[0]);
  assert.match(expandedText, /\[REDACTED_PATH\]/);
  assert.doesNotMatch(expandedText, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await assert.rejects(
    projectTrajectoryAnalysis(source, { maxBytes: 512, credentialValues: [] }),
    (error: unknown) => error instanceof HitchError && error.code === "trajectory_projection_overflow",
  );
});

test("trajectory events pages at the source and binds cursors to run, digest, and filter", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-events-"));
  t.after(() => forceRemove(root));
  const source = await writeRun(root, RUN_ID, completeEvents());
  const first = await pageTrajectoryEvents(source, {
    filter: { types: ["tool/result", "tool/call"] },
    limit: 1,
    credentialValues: [],
  });
  assert.equal(first.events.length, 1);
  assert.equal(first.total_matches, 2);
  assert.equal(first.eof, false);
  assert.ok(first.next_cursor);
  const second = await pageTrajectoryEvents(source, { cursor: first.next_cursor, limit: 5, credentialValues: [] });
  assert.equal(second.events.length, 1);
  assert.equal((second.events[0] as { type: string }).type, "tool/result");
  assert.equal(second.eof, true);
  await assert.rejects(
    pageTrajectoryEvents(source, {
      cursor: first.next_cursor,
      filter: { types: ["assistant/message"] },
      credentialValues: [],
    }),
    (error: unknown) => error instanceof HitchError && error.code === "invalid_trajectory_cursor",
  );
  const other = await writeRun(root, OTHER_RUN_ID, completeEvents());
  await assert.rejects(
    pageTrajectoryEvents(other, { cursor: first.next_cursor, credentialValues: [] }),
    (error: unknown) => error instanceof HitchError && error.code === "invalid_trajectory_cursor",
  );
});

test("streamed projections reject digest changes, symlinks, and unknown required events", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-integrity-"));
  t.after(() => forceRemove(root));
  const source = await writeRun(root, RUN_ID, completeEvents());
  await writeFile(source.path, `${await readFile(source.path, "utf8")} `);
  await assert.rejects(
    projectTrajectoryAnalysis(source, { credentialValues: [] }),
    (error: unknown) => error instanceof HitchError && error.code === "trajectory_integrity_mismatch",
  );

  const symlinkRoot = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-symlink-"));
  t.after(() => forceRemove(symlinkRoot));
  const symlinkSource = await writeRun(symlinkRoot, RUN_ID, completeEvents());
  const real = `${symlinkSource.path}.real`;
  await rename(symlinkSource.path, real);
  await symlink(real, symlinkSource.path);
  await assert.rejects(
    projectTrajectoryAnalysis(symlinkSource, { credentialValues: [] }),
    (error: unknown) => error instanceof HitchError && error.code === "trajectory_integrity_mismatch",
  );

  const runSymlinkRoot = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-run-symlink-"));
  t.after(() => forceRemove(runSymlinkRoot));
  const runSymlinkSource = await writeRun(runSymlinkRoot, RUN_ID, completeEvents());
  const realRunDirectory = `${runSymlinkSource.runDirectory}.real`;
  await rename(runSymlinkSource.runDirectory, realRunDirectory);
  await symlink(realRunDirectory, runSymlinkSource.runDirectory);
  await assert.rejects(
    projectTrajectoryAnalysis(runSymlinkSource, { credentialValues: [] }),
    (error: unknown) => error instanceof HitchError && error.code === "trajectory_integrity_mismatch",
  );

  const hardlinkRoot = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-hardlink-"));
  t.after(() => forceRemove(hardlinkRoot));
  const hardlinkSource = await writeRun(hardlinkRoot, RUN_ID, completeEvents());
  await link(hardlinkSource.path, `${hardlinkSource.path}.alias`);
  await assert.rejects(
    projectTrajectoryAnalysis(hardlinkSource, { credentialValues: [] }),
    (error: unknown) => error instanceof HitchError && error.code === "trajectory_integrity_mismatch",
  );

  const siblingRoot = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-sibling-write-"));
  t.after(() => forceRemove(siblingRoot));
  const siblingSource = await writeRun(siblingRoot, RUN_ID, completeEvents());
  let siblingCreated = false;
  const siblingScan = await scanCanonicalTrajectory(siblingSource, () => {
    if (siblingCreated) return;
    siblingCreated = true;
    mkdirSync(path.join(siblingSource.runDirectory, "concurrent-verifier-evidence"));
  });
  assert.equal(siblingScan.eventCount, completeEvents().length);

  const concurrentRoot = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-concurrent-write-"));
  t.after(() => forceRemove(concurrentRoot));
  const concurrentSource = await writeRun(concurrentRoot, RUN_ID, completeEvents());
  let canonicalChanged = false;
  await assert.rejects(
    scanCanonicalTrajectory(concurrentSource, () => {
      if (canonicalChanged) return;
      canonicalChanged = true;
      appendFileSync(concurrentSource.path, " ");
    }),
    (error: unknown) => error instanceof HitchError && error.code === "trajectory_integrity_mismatch",
  );

  const { expectedSha256: _digest, ...unpinnedSource } = siblingSource;
  await assert.rejects(
    projectTrajectoryAnalysis(unpinnedSource, { credentialValues: [] }),
    (error: unknown) => error instanceof HitchError && error.code === "trajectory_integrity_mismatch",
  );

  const unknownRoot = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-unknown-"));
  t.after(() => forceRemove(unknownRoot));
  const unknown = await writeRun(unknownRoot, RUN_ID, [event(0, "future/required", { effect: true })]);
  await assert.rejects(
    projectTrajectoryAnalysis(unknown, { credentialValues: [] }),
    (error: unknown) => error instanceof HitchError && error.code === "trajectory_projection_unsupported_event",
  );
});

test("analysis redacts sensitive keys, JSON keys, host paths, and split chunk credentials before hashing", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-redaction-"));
  t.after(() => forceRemove(root));
  const context = JSON.parse(JSON.stringify({
    password: "do-not-print",
    token: "opaque-token-value",
    sessionToken: "opaque-session-value",
    auth: "opaque-auth-value",
    apiToken: "opaque-api-value",
    ordinary: "/opt/harbor/private-workspace",
    windows: "C:\\Users\\runner\\secret.txt",
    windowsForward: "C:/Users/runner/secret.txt",
    fileUri: "file:///Users/runner/secret.txt",
    fileUnc: "file://server/share/secret.txt",
    bracketed: "[/Users/runner/secret.txt]",
    forwardUnc: "//server/share/secret.txt",
    __proto__: "preserved-without-prototype-mutation",
  })) as Record<string, unknown>;
  Object.defineProperty(context, "__proto__", {
    value: "preserved-without-prototype-mutation",
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const source = await writeRun(root, RUN_ID, [
    event(0, "turn/start", { turn: 1 }),
    event(1, "request/context", context),
    event(2, "step/start", { turn: 1, step: 1 }),
    event(3, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "block-start", index: 0, blockType: "text" },
    }),
    event(4, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "known " },
    }),
    event(5, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "credential" },
    }),
  ]);
  const result = await projectTrajectoryAnalysis(source, { credentialValues: ["known credential"] });
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /do-not-print|password|opaque-|known credential|private-workspace|Users|server\/share|C:/);
  assert.match(json, /REDACTED_FIELD/);
  assert.match(json, /REDACTED_PATH/);
  assert.match(json, /__proto__/);
  const partial = (result.chunk_summaries[0] as {
    partial: { content: { preview: string; bytes: number; sha256: string } };
  }).partial.content;
  assert.equal(partial.sha256, sha256Bytes(partial.preview));
  assert.equal(partial.bytes, Buffer.byteLength(partial.preview));
  assert.ok(source.expectedSha256);
  const drill = await pageTrajectoryEvents(source, {
    filter: { seq_start: 3, seq_end: 3, field: "data.chunk.text" },
    canonicalSha256: source.expectedSha256,
    limit: 1,
    maxBytes: 32 * 1024,
    credentialValues: ["known credential"],
  });
  const drilled = drill.events[0] as { value: { sha256: string }; source_seq_count: number };
  assert.equal(drilled.value.sha256, partial.sha256);
  assert.equal(drilled.source_seq_count, 2);
  await assert.rejects(
    pageTrajectoryEvents(source, {
      filter: { seq_start: 1, seq_end: 1, field: "event.data.token" },
      canonicalSha256: source.expectedSha256,
      credentialValues: [],
    }),
    (error: unknown) => error instanceof HitchError && error.code === "invalid_input",
  );
});

test("analysis canonicalizes request headers and suppresses sparse-index deltas after assembly", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-canonical-header-"));
  t.after(() => forceRemove(root));
  const source = await writeRun(root, RUN_ID, [
    event(0, "turn/start", { turn: 1 }),
    event(1, "step/start", { turn: 1, step: 1 }),
    event(2, "request/header", {
      reason: "initial",
      header: {
        config: { provider: "test", model: "model" },
        adapterDefaults: {},
        system: "",
        tools: [],
      },
    }),
    event(3, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "block-start", index: 2, blockType: "reasoning" },
    }),
    event(4, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "reasoning-delta", index: 2, text: "covered-reasoning" },
    }),
    event(5, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "block-end", index: 2, block: { type: "reasoning", text: "covered-reasoning" } },
    }),
    event(6, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "block-start", index: 99, blockType: "tool-call" },
    }),
    event(7, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "tool-call-delta", index: 99, id: "complete", name: "bash", argumentsDelta: "covered-args" },
    }),
    event(8, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "block-end", index: 99, block: { type: "tool-call", id: "complete", name: "bash", arguments: "covered-args" } },
    }),
    event(9, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
    }),
    event(10, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "finish", reason: { kind: "tool-calls" } },
    }),
    surfaceEvent(11, "assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "assistant-empty",
        role: "assistant",
        content: [
          { type: "reasoning", text: "covered-reasoning" },
          { type: "tool-call", id: "complete", name: "bash", arguments: "covered-args" },
        ],
        source: { kind: "model", provider: "test", model: "model" },
      },
    }, "append", [3, 4, 5, 6, 7, 8, 9, 10]),
    event(12, "tool/call", { turn: 1, step: 1, callId: "complete", name: "bash", arguments: "covered-args" }),
  ]);
  const result = await projectTrajectoryAnalysis(source, { credentialValues: [] });
  assert.deepEqual(result.header, { config: { provider: "test", model: "model" } });
  assert.equal(result.coverage.chunks, "coalesced");
  assert.equal((result.chunk_summaries[0] as { partial?: unknown }).partial, undefined);
  assert.doesNotMatch(JSON.stringify(result.chunk_summaries), /covered-reasoning|covered-args/);
});

test("events field drill-down binds the canonical digest and reproduces excerpt evidence", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-field-"));
  t.after(() => forceRemove(root));
  const source = await writeRun(root, RUN_ID, [
    event(0, "turn/start", { turn: 1 }),
    event(1, "step/start", { turn: 1, step: 1 }),
    surfaceEvent(2, "user/message", message("x".repeat(100_000)), "append"),
  ]);
  const analysis = await projectTrajectoryAnalysis(source, { maxBytes: 256 * 1024, credentialValues: [] });
  const excerpt = (analysis.surface.nodes[0] as {
    message: { content: Array<{ text: { sha256: string } }> };
  }).message.content[0]?.text;
  assert.ok(excerpt);
  assert.ok(source.expectedSha256);
  const page = await pageTrajectoryEvents(source, {
    filter: { seq_start: 2, seq_end: 2, field: "message.content.0.text" },
    canonicalSha256: source.expectedSha256,
    limit: 1,
    maxBytes: 32 * 1024,
    credentialValues: [],
  });
  const value = (page.events[0] as { value: { sha256: string } }).value;
  assert.equal(value.sha256, excerpt.sha256);
  await assert.rejects(
    pageTrajectoryEvents(source, {
      filter: { seq_start: 2, seq_end: 2, field: "message.content.0.text" },
      limit: 1,
      credentialValues: [],
    }),
    (error: unknown) => error instanceof HitchError && error.code === "invalid_input",
  );
});

test("excerpt sources resolve ordinary JSON keys that need encoded path segments", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-encoded-field-"));
  t.after(() => forceRemove(root));
  const source = await writeRun(root, RUN_ID, [
    event(0, "turn/start", { turn: 1 }),
    event(1, "request/context", { "ordinary.key with space": "z".repeat(100_000) }),
  ]);
  const analysis = await projectTrajectoryAnalysis(source, { maxBytes: 256 * 1024, credentialValues: [] });
  const diagnostic = analysis.events.find((entry) => (entry as { seq?: number }).seq === 1) as {
    data: Record<string, { sha256: string; source: { field: string } }>;
  };
  const excerpt = diagnostic.data["ordinary.key with space"];
  assert.ok(excerpt);
  assert.match(excerpt.source.field, /^event\.data\.\[field:[a-f0-9]{12}\]$/);
  assert.ok(source.expectedSha256);
  const page = await pageTrajectoryEvents(source, {
    filter: { seq_start: 1, seq_end: 1, field: excerpt.source.field },
    canonicalSha256: source.expectedSha256,
    credentialValues: [],
  });
  assert.equal((page.events[0] as { value: { sha256: string } }).value.sha256, excerpt.sha256);
});

test("streamed projection validates known chunk variants and stream grammar", async (t) => {
  const malformed = [
    { type: "text-delta", index: 0, text: "without start" },
    { type: "block-start", index: -1, blockType: "text" },
    { type: "usage", usage: { inputTokens: 1 } },
    { type: "finish", reason: "stop" },
  ];
  for (const [index, chunk] of malformed.entries()) {
    const root = await mkdtemp(path.join(tmpdir(), `hitch-trajectory-bad-chunk-${index}-`));
    t.after(() => forceRemove(root));
    const source = await writeRun(root, RUN_ID, [
      event(0, "turn/start", { turn: 1 }),
      event(1, "step/start", { turn: 1, step: 1 }),
      event(2, "assistant/chunk", { turn: 1, step: 1, chunk }),
    ]);
    await assert.rejects(
      projectTrajectoryAnalysis(source, { credentialValues: [] }),
      (error: unknown) => error instanceof HitchError && error.code === "trajectory_integrity_mismatch",
    );
  }
});

test("chunk validation starts a new stream attempt at llm/retry-started", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-retry-stream-"));
  t.after(() => forceRemove(root));
  const source = await writeRun(root, RUN_ID, [
    event(0, "turn/start", { turn: 1 }),
    event(1, "step/start", { turn: 1, step: 1 }),
    event(2, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "finish", reason: { kind: "error", failure: { message: "retry", code: "SERVER" } } },
    }),
    event(3, "llm/retry", {
      retryId: "retry-1",
      turn: 1,
      step: 1,
      provider: "test",
      mode: "normal",
      policyKey: "test-normal",
      retry: 1,
      maxRetries: 1,
      delayMs: 0,
      failure: { message: "retry", code: "SERVER" },
    }),
    event(4, "llm/retry-started", { retryId: "retry-1", turn: 1, step: 1, retry: 1 }),
    event(5, "assistant/chunk", { turn: 1, step: 1, chunk: { type: "block-start", index: 7, blockType: "text" } }),
    event(6, "assistant/chunk", { turn: 1, step: 1, chunk: { type: "text-delta", index: 7, text: "recovered" } }),
    event(7, "assistant/chunk", { turn: 1, step: 1, chunk: { type: "block-end", index: 7, block: { type: "text", text: "recovered" } } }),
    event(8, "assistant/chunk", { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } } }),
    event(9, "assistant/chunk", { turn: 1, step: 1, chunk: { type: "finish", reason: { kind: "stop" } } }),
    surfaceEvent(10, "assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "retry-answer",
        role: "assistant",
        content: [{ type: "text", text: "recovered" }],
        source: { kind: "model", provider: "test", model: "model" },
      },
    }, "append", [2, 5, 6, 7, 8, 9]),
  ]);
  const result = await projectTrajectoryAnalysis(source, { credentialValues: [] });
  assert.equal(result.coverage.chunks, "coalesced");
  assert.equal((result.chunk_summaries[0] as { count: number }).count, 6);

  const forgedRoot = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-forged-retry-"));
  t.after(() => forceRemove(forgedRoot));
  const forged = await writeRun(forgedRoot, RUN_ID, [
    event(0, "turn/start", { turn: 1 }),
    event(1, "step/start", { turn: 1, step: 1 }),
    event(2, "llm/retry-started", { retryId: "missing", turn: 1, step: 1, retry: 1 }),
  ]);
  await assert.rejects(
    projectTrajectoryAnalysis(forged, { credentialValues: [] }),
    (error: unknown) => error instanceof HitchError && error.code === "trajectory_integrity_mismatch",
  );
});

test("unknown ignorable event names remain forward compatible", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-ignorable-name-"));
  t.after(() => forceRemove(root));
  const source = await writeRun(root, RUN_ID, [{
    ...event(0, "Future Plugin Event With Spaces", { value: true }),
    ignorable: true,
  }]);
  const result = await projectTrajectoryAnalysis(source, { credentialValues: [] });
  assert.deepEqual(result.omitted_event_types, { "Future Plugin Event With Spaces": 1 });
  const page = await pageTrajectoryEvents(source, {
    filter: { types: ["Future Plugin Event With Spaces"] },
    credentialValues: [],
  });
  assert.equal(page.total_matches, 1);
});

test("public projections reject event types that could leak paths or credentials", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-unsafe-type-"));
  t.after(() => forceRemove(root));
  const source = await writeRun(root, RUN_ID, [{
    ...event(0, "/Users/runner/log", { value: true }),
    ignorable: true,
  }]);
  await assert.rejects(
    projectTrajectoryAnalysis(source, { credentialValues: [] }),
    (error: unknown) => error instanceof HitchError && error.code === "trajectory_projection_unsafe_event_type",
  );
  await assert.rejects(
    pageTrajectoryEvents(source, { filter: { types: ["/Users/runner/log"] }, credentialValues: [] }),
    (error: unknown) => error instanceof HitchError && error.code === "invalid_input",
  );

  const surfaceRoot = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-unsafe-type-error-"));
  t.after(() => forceRemove(surfaceRoot));
  const surfaceSource = await writeRun(surfaceRoot, RUN_ID, [{
    ...event(0, "/Users/runner/private", { value: true }),
    ignorable: true,
    surfaceOp: "append",
  }]);
  await assert.rejects(
    projectTrajectoryAnalysis(surfaceSource, { credentialValues: [] }),
    (error: unknown) => error instanceof HitchError
      && error.code === "trajectory_integrity_mismatch"
      && !error.message.includes("/Users/runner/private"),
  );

  const chunkRoot = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-unsafe-chunk-error-"));
  t.after(() => forceRemove(chunkRoot));
  const chunkSource = await writeRun(chunkRoot, RUN_ID, [
    event(0, "turn/start", { turn: 1 }),
    event(1, "step/start", { turn: 1, step: 1 }),
    event(2, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "/Users/runner/private" },
    }),
  ]);
  await assert.rejects(
    projectTrajectoryAnalysis(chunkSource, { credentialValues: [] }),
    (error: unknown) => error instanceof HitchError
      && error.code === "trajectory_integrity_mismatch"
      && !error.message.includes("/Users/runner/private"),
  );
});

test("unknown ignorable events cannot smuggle DSH surface metadata", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-unknown-surface-"));
  t.after(() => forceRemove(root));
  const bad = {
    ...event(0, "future/ignorable", { value: true }),
    ignorable: true as const,
    surfaceOp: "append" as const,
  };
  const source = await writeRun(root, RUN_ID, [bad]);
  await assert.rejects(
    projectTrajectoryAnalysis(source, { credentialValues: [] }),
    (error: unknown) => error instanceof HitchError && error.code === "trajectory_integrity_mismatch",
  );
});

test("child-session coverage is unavailable until an explicit parent-child source exists", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-child-"));
  t.after(() => forceRemove(root));
  const source = await writeRun(root, RUN_ID, [
    event(0, "subagent/descriptor", { sessionId: "child-session", agent: "worker" }),
  ]);
  const result = await projectTrajectoryAnalysis(source, { credentialValues: [] });
  assert.equal(result.coverage.child_sessions, "unavailable");
});

test("streamed projection rejects malformed DSH message relations", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-relation-"));
  t.after(() => forceRemove(root));
  const source = await writeRun(root, RUN_ID, [
    surfaceEvent(0, "assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "outside step" }],
        source: { kind: "model", provider: "test", model: "model" },
      },
    }, "append"),
  ]);
  await assert.rejects(
    projectTrajectoryAnalysis(source, { credentialValues: [] }),
    (error: unknown) => error instanceof HitchError && error.code === "trajectory_integrity_mismatch",
  );
});

function completeEvents(): SessionEvent[] {
  return [
    event(0, "turn/start", { turn: 1 }),
    event(1, "step/start", { turn: 1, step: 1 }),
    surfaceEvent(2, "user/message", message("question"), "append"),
    event(3, "request/header", {
      header: { config: { provider: "test", model: "model" }, system: "system" },
      reason: "initial",
    }),
    event(4, "assistant/chunk", { turn: 1, step: 1, chunk: { type: "block-start", index: 0, blockType: "reasoning" } }),
    event(5, "assistant/chunk", { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "thinking" } }),
    event(6, "assistant/chunk", { turn: 1, step: 1, chunk: { type: "block-end", index: 0, block: { type: "reasoning", text: "thinking" } } }),
    event(7, "assistant/chunk", { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 3, outputTokens: 1 } } }),
    event(8, "assistant/chunk", { turn: 1, step: 1, chunk: { type: "finish", reason: { kind: "tool-calls" } } }),
    surfaceEvent(9, "assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        source: { kind: "model", provider: "test", model: "model" },
      },
    }, "append", [4, 5, 6, 7, 8]),
    event(10, "tool/call", { turn: 1, step: 1, callId: "call-1", name: "read", arguments: "{}" }),
    surfaceEvent(11, "tool/result", {
      turn: 1,
      step: 1,
      message: {
        id: "tool-result",
        role: "user",
        source: { kind: "tool", callId: "call-1" },
        content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "result" }] }],
      },
    }, "append"),
    event(12, "step/end", { turn: 1, step: 1 }),
    event(13, "compaction/summary", { summary: "summary", shadowedRange: { start: 2, end: 11 } }),
    surfaceEvent(14, "user/message", message("compacted"), { op: "replace", start: 2, end: 11 }, [2, 9, 11, 13]),
    event(15, "step/start", { turn: 1, step: 2 }),
    event(16, "request/header", {
      header: {
        config: { provider: "test", model: "model-2" },
        adapterDefaults: {},
        system: "system-2",
        tools: [],
      },
      reason: "change",
    }),
    surfaceEvent(17, "assistant/message", {
      turn: 1,
      step: 2,
      message: {
        id: "assistant-2",
        role: "assistant",
        content: [{ type: "text", text: "after compaction" }],
        source: { kind: "model", provider: "test", model: "model-2" },
      },
    }, "append", []),
    event(18, "step/end", { turn: 1, step: 2 }),
    event(19, "turn/end", { turn: 1, reason: { kind: "completed" } }),
  ];
}

function message(text: string): Record<string, unknown> {
  return { id: `message-${text.length}`, role: "user", content: [{ type: "text", text }], source: { kind: "user" } };
}

function event(seq: number, type: string, data: Record<string, unknown>): SessionEvent {
  return { type, seq, time: 1_800_000_000_000 + seq, data };
}

function surfaceEvent(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  surfaceOp: "append" | { op: "replace"; start: number; end: number },
  sourceEventSeqs?: number[],
): SessionEvent {
  return { ...event(seq, type, data), surfaceOp, ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }) };
}

async function writeRun(root: string, runId: string, events: SessionEvent[]) {
  const runDirectory = path.join(root, "runs", runId);
  const relative = `trajectory/canonical/--workspace--/${runId}/session.jsonl`;
  const file = path.join(runDirectory, ...relative.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  const header: SessionHeaderLine = {
    type: "session",
    version: 0,
    id: runId,
    createdAt: 1_800_000_000_000,
    delegationDepth: 0,
  };
  const content = `${[header, ...events].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await writeFile(file, content, { mode: 0o600 });
  const ref: TrajectoryRefV2 = {
    schema_version: "2",
    run_id: runId,
    fidelity: "normalized",
    provider: "deepseek",
    files: [{
      role: "canonical_session",
      path: relative,
      media_type: "application/x-ndjson",
      sha256: sha256Bytes(content),
      bytes: Buffer.byteLength(content),
    }],
  };
  await writeFile(path.join(runDirectory, "trajectory.ref.json"), `${JSON.stringify(ref)}\n`, { mode: 0o600 });
  const source = await loadCanonicalTrajectorySource(runDirectory, runId);
  assert.ok(source);
  return source;
}
