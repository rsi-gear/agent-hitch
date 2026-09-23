import type { SessionEvent, SessionHeaderLine } from "../src/domain/index.js";

/** Writer shapes reviewed at DSH 0.1.7-rc.1 (46a7f68b0922371ce7144b668b90e377d8e799f4). */
export function modernDshSession(version: 2 | 3 | 4): { header: SessionHeaderLine; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  const add = (type: string, data: Record<string, unknown>, extra: Partial<SessionEvent> = {}): number => {
    const seq = events.length;
    events.push({ type, seq, time: 1_700_000_000_000 + seq, data, ...extra });
    return seq;
  };
  const text = (value: string) => [{ type: "text", text: value }];
  const model = { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" };
  add("turn/start", { turn: 1 });
  add("step/start", { turn: 1, step: 1 });
  if (version >= 3) add("system/message", {
    turn: 1, step: 1,
    message: { id: "system", role: "system", content: text("Be helpful."),
      source: version === 4 ? { kind: "system-prompt" } : { kind: "plugin", plugin: "system-prompt" } },
  }, { surfaceOp: "append" });
  add("user/message", { id: "user", role: "user", source: { kind: "user" }, content: text("hello") }, { surfaceOp: "append" });
  add("request/header", {
    header: { config: { provider: model.provider, model: model.model }, ...(version === 2 ? { system: "Be helpful." } : {}) },
    reason: "initial",
  });
  if (version === 4) add("developer/message", {
    turn: 1, step: 1,
    message: { id: "developer", role: "developer", source: { kind: "agent-settings" }, content: text("Use tools when needed.") },
  }, { surfaceOp: "append" });
  add("assistant/message", {
    turn: 1, step: 1, stream: [],
    message: { id: "assistant-tool", role: "assistant", source: model,
      content: [{ type: "tool-call", id: "call-1", name: "read", arguments: "{}" }] },
  }, { surfaceOp: "append" });
  const callSeq = add("tool/call", { turn: 1, step: 1, callId: "call-1", name: "read", arguments: "{}" });
  const resultMessage = (value: string) => ({
    id: "tool-result", role: version === 4 ? "tool" : "user", source: { kind: "tool", callId: "call-1" },
    ...(version === 4 ? { toolCallId: "call-1", isError: false, content: text(value) }
      : { content: [{ type: "tool-result", toolCallId: "call-1", isError: false, content: text(value) }] }),
  });
  const resultSeq = add("tool/result", { turn: 1, step: 1, message: resultMessage("original") },
    { surfaceOp: "append", sourceEventSeqs: [callSeq] });
  add("step/end", { turn: 1, step: 1 });
  add("step/start", { turn: 1, step: 2 });
  add("tool/result", { turn: 1, step: 1, message: resultMessage("compressed") }, {
    surfaceOp: version >= 3 ? { op: "replace", startSeq: resultSeq, endSeq: resultSeq }
      : { op: "replace", start: resultSeq, end: resultSeq },
    sourceEventSeqs: [resultSeq],
  });
  const content = text("modern final");
  add("assistant/message", {
    turn: 1, step: 2,
    message: { id: "assistant-final", role: "assistant", source: model, content },
    usage: { inputTokens: 20, outputTokens: 3 },
    stream: [
      { type: "chunk", time: 100, chunk: { type: "block-start", index: 0, blockType: "text" } },
      { type: "text-chunks", time0: 101, index: 0, dt: [-1, 3], texts: ["modern", " ", "final"] },
      { type: "chunk", time: 104, chunk: { type: "block-end", index: 0, block: content[0] } },
      { type: "chunk", time: 105, chunk: { type: "usage", usage: { inputTokens: 20, outputTokens: 3 } } },
      { type: "chunk", time: 106, chunk: { type: "finish", reason: { kind: "stop" } } },
    ],
  }, { surfaceOp: "append" });
  add("step/end", { turn: 1, step: 2 });
  add("turn/end", { turn: 1, reason: { kind: "completed" } });
  return { header: { type: "session", version, id: "session-modern", createdAt: 1_700_000_000_000,
    delegationDepth: 0, isSeeded: false }, events };
}
