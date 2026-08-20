import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MessageFeedbackService, MessageFeedbackError } from "../src/feedback/service.js";
import type { FeedbackSessionIdentity } from "../src/feedback/service.js";
import { forceRemove } from "../test-support/helpers.js";

const identity: FeedbackSessionIdentity = { sessionId: "session-1", createdAt: 1_700_000_000_000, cwd: "/workspace" };

async function serviceFixture(): Promise<{ service: MessageFeedbackService; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-feedback-"));
  const service = new MessageFeedbackService({
    root,
    validateTarget: async () => true,
  });
  return { service, cleanup: () => forceRemove(root) };
}

test("put creates an item with a fresh version and list returns it in creation order", async (t) => {
  const { service, cleanup } = await serviceFixture();
  t.after(cleanup);
  const created = await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "positive", ifVersion: null },
    identity,
    { messageId: "m1" },
  );
  assert.equal(created.rating, "positive");
  assert.equal(created.createdAt, created.updatedAt);
  assert.match(created.version, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  const items = await service.list({ sessionId: identity.sessionId }, identity);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.messageId, "m1");
});

test("ifVersion:null fails with version-conflict when the item already exists", async (t) => {
  const { service, cleanup } = await serviceFixture();
  t.after(cleanup);
  await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "positive", ifVersion: null },
    identity,
    { messageId: "m1" },
  );
  await assert.rejects(
    service.put(
      { sessionId: identity.sessionId, messageId: "m1", rating: "negative", ifVersion: null },
      identity,
      { messageId: "m1" },
    ),
    (error: unknown) => {
      const typed = error as MessageFeedbackError;
      return typed.code === "version-conflict" && typed.current?.rating === "positive";
    },
  );
});

test("matching-version no-op returns the existing item unchanged", async (t) => {
  const { service, cleanup } = await serviceFixture();
  t.after(cleanup);
  const created = await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "positive", ifVersion: null },
    identity,
    { messageId: "m1" },
  );
  const noop = await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "positive", ifVersion: created.version },
    identity,
    { messageId: "m1" },
  );
  assert.equal(noop.version, created.version);
  assert.equal(noop.updatedAt, created.updatedAt);
});

test("a stale version conflicts and reports the authoritative current item", async (t) => {
  const { service, cleanup } = await serviceFixture();
  t.after(cleanup);
  const created = await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "positive", ifVersion: null },
    identity,
    { messageId: "m1" },
  );
  await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "negative", note: "updated", ifVersion: created.version },
    identity,
    { messageId: "m1" },
  );
  await assert.rejects(
    service.put(
      { sessionId: identity.sessionId, messageId: "m1", rating: "positive", ifVersion: created.version },
      identity,
      { messageId: "m1" },
    ),
    (error: unknown) => {
      const typed = error as MessageFeedbackError;
      return typed.code === "version-conflict" && typed.current?.rating === "negative";
    },
  );
});

test("material updates preserve createdAt, rotate version, and never move updatedAt backward", async (t) => {
  const { service, cleanup } = await serviceFixture();
  t.after(cleanup);
  const created = await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "positive", ifVersion: null },
    identity,
    { messageId: "m1" },
  );
  const updated = await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "negative", note: "now negative", ifVersion: created.version },
    identity,
    { messageId: "m1" },
  );
  assert.equal(updated.createdAt, created.createdAt);
  assert.notEqual(updated.version, created.version);
  assert.ok(updated.updatedAt >= created.updatedAt);
  assert.equal(updated.note, "now negative");
});

test("omitting note clears an existing note on a material update", async (t) => {
  const { service, cleanup } = await serviceFixture();
  t.after(cleanup);
  const created = await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "positive", note: "keep?", ifVersion: null },
    identity,
    { messageId: "m1" },
  );
  const updated = await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "positive", ifVersion: created.version },
    identity,
    { messageId: "m1" },
  );
  assert.equal(updated.note, undefined);
});

test("note validation rejects blank and oversized notes before touching persistence", async (t) => {
  const { service, cleanup } = await serviceFixture();
  t.after(cleanup);
  await assert.rejects(
    service.put(
      { sessionId: identity.sessionId, messageId: "m1", rating: "positive", note: "   ", ifVersion: null },
      identity,
      { messageId: "m1" },
    ),
    (error: unknown) => (error as MessageFeedbackError).code === "note-blank",
  );
  const service2 = new MessageFeedbackService({ root: path.dirname("unused"), maxNoteBytes: 4, validateTarget: async () => true });
  await assert.rejects(
    service2.put(
      { sessionId: identity.sessionId, messageId: "m1", rating: "positive", note: "12345", ifVersion: null },
      identity,
      { messageId: "m1" },
    ),
    (error: unknown) => {
      const typed = error as MessageFeedbackError;
      return typed.code === "note-too-large" && typed.maxBytes === 4 && typed.actualBytes === 5;
    },
  );
});

test("delete removes an item; delete-absent is a stable no-op regardless of version", async (t) => {
  const { service, cleanup } = await serviceFixture();
  t.after(cleanup);
  const created = await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "positive", ifVersion: null },
    identity,
    { messageId: "m1" },
  );
  assert.deepEqual(await service.delete(
    { sessionId: identity.sessionId, messageId: "m1", ifVersion: created.version },
    identity,
  ), { absent: true });
  assert.deepEqual(await service.delete(
    { sessionId: identity.sessionId, messageId: "m1", ifVersion: "wrong-version" },
    identity,
  ), { absent: true });
  assert.equal((await service.list({ sessionId: identity.sessionId }, identity)).length, 0);
});

test("delete requires the exact current version when the item exists", async (t) => {
  const { service, cleanup } = await serviceFixture();
  t.after(cleanup);
  await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "positive", ifVersion: null },
    identity,
    { messageId: "m1" },
  );
  await assert.rejects(
    service.delete({ sessionId: identity.sessionId, messageId: "m1", ifVersion: "stale" }, identity),
    (error: unknown) => (error as MessageFeedbackError).code === "version-conflict",
  );
});

test("recreate after delete moves the item to the end", async (t) => {
  const { service, cleanup } = await serviceFixture();
  t.after(cleanup);
  const a = await service.put(
    { sessionId: identity.sessionId, messageId: "a", rating: "positive", ifVersion: null },
    identity,
    { messageId: "a" },
  );
  const b = await service.put(
    { sessionId: identity.sessionId, messageId: "b", rating: "negative", ifVersion: null },
    identity,
    { messageId: "b" },
  );
  await service.delete({ sessionId: identity.sessionId, messageId: "a", ifVersion: a.version }, identity);
  await service.put(
    { sessionId: identity.sessionId, messageId: "a", rating: "positive", ifVersion: null },
    identity,
    { messageId: "a" },
  );
  const items = await service.list({ sessionId: identity.sessionId }, identity);
  assert.deepEqual(items.map((item) => item.messageId), ["b", "a"]);
});

test("a lifecycle identity mismatch is treated as absence and fences id reuse", async (t) => {
  const { service, cleanup } = await serviceFixture();
  t.after(cleanup);
  await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "positive", ifVersion: null },
    identity,
    { messageId: "m1" },
  );
  const differentIdentity: FeedbackSessionIdentity = { ...identity, createdAt: 1_800_000_000_000 };
  const items = await service.list({ sessionId: identity.sessionId }, differentIdentity);
  assert.equal(items.length, 0);
  // A put with the new identity may replace the stale row bound to the old identity.
  const created = await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "negative", ifVersion: null },
    differentIdentity,
    { messageId: "m1" },
  );
  assert.equal(created.rating, "negative");
  const refreshed = await service.list({ sessionId: identity.sessionId }, differentIdentity);
  assert.equal(refreshed.length, 1);
});

test("forks do not inherit feedback (distinct session ids have independent rows)", async (t) => {
  const { service, cleanup } = await serviceFixture();
  t.after(cleanup);
  await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "positive", ifVersion: null },
    identity,
    { messageId: "m1" },
  );
  const forkIdentity: FeedbackSessionIdentity = {
    sessionId: "fork-session",
    createdAt: identity.createdAt,
    ...(identity.cwd !== undefined ? { cwd: identity.cwd } : {}),
  };
  const items = await service.list({ sessionId: forkIdentity.sessionId }, forkIdentity);
  assert.equal(items.length, 0);
});

test("target-not-found when the validator rejects the message id", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-feedback-target-"));
  const service = new MessageFeedbackService({
    root,
    validateTarget: async (_sessionId, messageId) => messageId === "valid-message",
  });
  await assert.rejects(
    service.put(
      { sessionId: identity.sessionId, messageId: "ghost", rating: "positive", ifVersion: null },
      identity,
      { messageId: "ghost" },
    ),
    (error: unknown) => (error as MessageFeedbackError).code === "target-not-found",
  );
  await forceRemove(root);
});

test("per-session queue serializes concurrent mutations with one material success", async (t) => {
  const { service, cleanup } = await serviceFixture();
  t.after(cleanup);
  const attempts = await Promise.allSettled([
    service.put(
      { sessionId: identity.sessionId, messageId: "m1", rating: "positive", ifVersion: null },
      identity,
      { messageId: "m1" },
    ),
    service.put(
      { sessionId: identity.sessionId, messageId: "m1", rating: "negative", ifVersion: null },
      identity,
      { messageId: "m1" },
    ),
    service.put(
      { sessionId: identity.sessionId, messageId: "m1", rating: "positive", ifVersion: null },
      identity,
      { messageId: "m1" },
    ),
  ]);
  const successes = attempts.filter((result) => result.status === "fulfilled");
  const conflicts = attempts.filter((result) => result.status === "rejected"
    && (result.reason as MessageFeedbackError).code === "version-conflict");
  assert.equal(successes.length, 1);
  assert.equal(conflicts.length, 2);
  const items = await service.list({ sessionId: identity.sessionId }, identity);
  assert.equal(items.length, 1);
});

test("feedback does not alter the underlying session row bytes", async (t) => {
  const { service, cleanup } = await serviceFixture();
  t.after(cleanup);
  await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "positive", note: "note", ifVersion: null },
    identity,
    { messageId: "m1" },
  );
  await service.put(
    { sessionId: identity.sessionId, messageId: "m1", rating: "negative", ifVersion: "any" },
    identity,
    { messageId: "m1" },
  ).catch(() => {});
  const items = await service.list({ sessionId: identity.sessionId }, identity);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.rating, "positive");
  assert.equal(items[0]?.note, "note");
});
