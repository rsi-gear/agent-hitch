import test from "node:test";
import assert from "node:assert/strict";
import { getAdapter } from "../src/adapters.js";

test("Claude adapter emits matched structured tool lifecycle events", () => {
  const adapter = getAdapter("claude");
  const started = adapter.translate({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tool_1", name: "Read", input: { file: "README.md" } }] },
  });
  const completed = adapter.translate({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tool_1", content: [{ type: "text", text: "done" }] }] },
  });

  assert.deepEqual(started, [{ type: "tool.started", call_id: "tool_1", name: "Read", input: { file: "README.md" } }]);
  assert.deepEqual(completed, [{ type: "tool.completed", call_id: "tool_1", status: "succeeded", output: "done" }]);
});

test("Claude adapter preserves every text block in order", () => {
  const events = getAdapter("claude").translate({
    type: "assistant",
    message: { content: [{ type: "text", text: "first " }, { type: "text", text: "second" }] },
  });
  assert.deepEqual(events, [
    { type: "message.delta", text: "first " },
    { type: "message.delta", text: "second" },
  ]);
});

test("Claude result exposes the authoritative complete final reply", () => {
  const events = getAdapter("claude").translate({
    type: "result",
    result: "complete final answer",
    usage: { input_tokens: 10, output_tokens: 4 },
  });
  assert.deepEqual(events, [
    { type: "message.completed", text: "complete final answer" },
    { type: "usage.updated", usage: { input_tokens: 10, output_tokens: 4 } },
  ]);
});
