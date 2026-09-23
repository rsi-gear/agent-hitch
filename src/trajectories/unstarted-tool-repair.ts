import type { SessionEvent } from "../domain/index.js";

const INTERRUPTED_TEXT = "The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.";

/** Recognize native repairs only for calls advertised, but never started, in this step. */
export class IncrementalUnstartedToolRepair {
  private readonly advertised = new Map<string, { turn: unknown; step: unknown }>();

  constructor(private readonly version: number) {}

  accept(event: SessionEvent): boolean {
    const data = record(event.data);
    if (event.type === "step/start" || event.type === "step/end") this.advertised.clear();
    if (event.type === "assistant/message" && (event.surfaceOp === "append" || event.surfaceOp === undefined)) {
      const content = record(data.message).content;
      for (const block of Array.isArray(content) ? content : []) {
        const call = record(block);
        if (call.type === "tool-call" && typeof call.id === "string" && call.id.length > 0) {
          this.advertised.set(call.id, { turn: data.turn, step: data.step });
        }
      }
    }
    if (event.type === "tool/call" && typeof data.callId === "string") this.advertised.delete(data.callId);
    if (event.type !== "tool/result" || event.surfaceOp !== "append") return false;
    const message = record(data.message);
    const callId = record(message.source).callId;
    if (typeof callId !== "string") return false;
    const advertised = this.advertised.get(callId);
    this.advertised.delete(callId);
    return advertised !== undefined && advertised.turn === data.turn && advertised.step === data.step
      && isExactRepair(event, data, message, callId, this.version);
  }
}

function isExactRepair(
  event: SessionEvent, data: Record<string, unknown>, message: Record<string, unknown>, callId: string, version: number,
): boolean {
  const error = record(data.error);
  if (error.name !== "ToolNotStartedError" || error.code !== "TOOL_NOT_STARTED"
    || event.sourceEventSeqs !== undefined || record(message.source).kind !== "tool") return false;
  const content = Array.isArray(message.content) ? message.content : [];
  const wrapper = record(content[0]);
  const body = version >= 4 ? content : wrapper.content;
  if (version >= 4 ? message.role !== "tool" || message.toolCallId !== callId || message.isError !== true
    : message.role !== "user" || content.length !== 1 || wrapper.type !== "tool-result"
      || wrapper.toolCallId !== callId || wrapper.isError !== true) return false;
  if (!Array.isArray(body) || body.length !== 1) return false;
  const text = record(body[0]);
  if (text.type !== "text" || typeof text.text !== "string" || typeof message.id !== "string") return false;
  const forked = version >= 4 && message.id.startsWith(`forked-tool-result-${callId}-`);
  const prefix = `${forked ? "forked" : "interrupted"}-tool-result-${callId}-`;
  const suffix = message.id.slice(prefix.length);
  if (!message.id.startsWith(prefix) || !/^(0|[1-9][0-9]*)$/.test(suffix) || !Number.isSafeInteger(Number(suffix))) return false;
  if ((forked || version < 3) && Number(suffix) !== event.seq) return false;
  return forked || text.text === INTERRUPTED_TEXT;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
