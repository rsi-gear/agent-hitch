import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EvalEventSink, MAX_EVAL_EVENT_BYTES, validateEvalId } from "../src/evals/index.js";
import { EventSink, MAX_RUN_EVENT_BYTES, newRunId } from "../src/runs/index.js";
import { forceRemove } from "../test-support/helpers.js";

test("eval event sink replaces oversized payloads with bounded audit evidence", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-events-"));
  t.after(() => forceRemove(root));
  const observed: Record<string, unknown>[] = [];
  const sink = new EvalEventSink(root, validateEvalId(`eval_${"a".repeat(32)}`), (event) => observed.push(event));
  await sink.open();
  const framed = sink.emit({ type: "eval.test.oversized", secret_free_detail: "x".repeat(MAX_EVAL_EVENT_BYTES * 2) });
  await sink.close();
  assert.equal(framed.type, "eval.test.oversized");
  assert.equal(framed.truncated, true);
  assert.equal(typeof framed.original_bytes, "number");
  assert.equal("secret_free_detail" in framed, false);
  assert.deepEqual(observed, [framed]);
  const bytes = await readFile(path.join(root, "events.jsonl"));
  assert.ok(bytes.length <= MAX_EVAL_EVENT_BYTES);
  assert.deepEqual(JSON.parse(bytes.toString("utf8")), framed);
});

test("run event sink replaces oversized payloads with bounded audit evidence", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-run-events-"));
  t.after(() => forceRemove(root));
  const observed: Record<string, unknown>[] = [];
  const sink = new EventSink(root, newRunId(), (event) => observed.push(event));
  await sink.open();
  const framed = sink.emit({ type: "run.test.oversized", unbounded_detail: "x".repeat(MAX_RUN_EVENT_BYTES * 2) });
  await sink.close();
  assert.equal(framed.type, "run.test.oversized");
  assert.equal(framed.truncated, true);
  assert.equal(typeof framed.original_bytes, "number");
  assert.equal("unbounded_detail" in framed, false);
  assert.deepEqual(observed, [framed]);
  const bytes = await readFile(path.join(root, "events.jsonl"));
  assert.ok(bytes.length <= MAX_RUN_EVENT_BYTES);
  assert.deepEqual(JSON.parse(bytes.toString("utf8")), framed);
});
