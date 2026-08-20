/**
 * Projector that turns normalized Hitch adapter events (and plain-text output
 * for `minimal` fidelity) into a canonical DSH-compatible trajectory
 * (spec §5.4, §5.5). It owns the turn/step bracket state machine and the
 * tool-call pairing invariant.
 */

import { randomUUID } from "node:crypto";
import type { NormalizedEvent } from "../adapters.js";
import type { SessionEvent, SessionHeaderLine } from "../domain/types.js";
import type { TrajectoryFidelity } from "../domain/types.js";

export interface ProjectedSession {
  header: SessionHeaderLine;
  events: SessionEvent[];
  /** Text of the last non-empty assistant message; tool-call-only or empty messages never overwrite it. */
  finalOutput: string;
  /** Native provider session id when the adapter reported one. */
  providerSessionId?: string;
  fidelity: TrajectoryFidelity;
}

export interface ProjectionOptions {
  runId: string;
  cwd: string;
  prompt: string;
  /** Provider/model identity required by current DSH assistant-message validation. */
  model: string;
  fidelity: TrajectoryFidelity;
  agentPreset?: string;
}

interface OpenToolCall {
  callId: string;
  name: string;
}

const EVENT_TYPE_KEYS = new Set([
  "turn/start", "turn/end", "step/start", "step/end",
  "user/message", "assistant/chunk", "assistant/message",
  "tool/call", "tool/result",
]);

export class TrajectoryProjector {
  private readonly header: SessionHeaderLine;
  private readonly events: SessionEvent[] = [];
  private readonly fidelity: TrajectoryFidelity;
  private readonly prompt: string;
  private readonly modelSource: { provider: string; model: string };
  private seq = 0;
  // DSH's current persistence format numbers turns from one. A zero turn is
  // reserved for an older pre-react-loop envelope and is rejected on load.
  private turn = 1;
  private step = 1;
  private stepOpen = false;
  private promptRecorded = false;
  private requestHeaderRecorded = false;
  private turnOpen = false;
  private assistantOpen = false;
  private assistantText = "";
  private assistantUsage: Record<string, unknown> | undefined;
  private lastAssistantEvent: SessionEvent | undefined;
  private readonly openCalls = new Map<string, OpenToolCall>();
  private finalOutput = "";
  private providerSessionId: string | undefined;
  private finalized = false;

  constructor(options: ProjectionOptions) {
    this.fidelity = options.fidelity;
    this.prompt = options.prompt;
    this.modelSource = parseModelSource(options.model);
    this.header = {
      type: "session",
      version: 0,
      id: options.runId,
      createdAt: Date.now(),
      cwd: options.cwd,
      delegationDepth: 0,
      ...(options.agentPreset ? { agentPreset: options.agentPreset } : {}),
    };
  }

  get sessionId(): string {
    return this.header.id;
  }

  get sessionHeader(): SessionHeaderLine {
    return this.header;
  }

  get eventCount(): number {
    return this.events.length;
  }

  /** Feed one normalized Hitch event into the projector. */
  feed(event: NormalizedEvent): void {
    if (this.finalized) throw new Error("cannot feed a finalized trajectory");
    switch (event.type) {
      case "session.created":
        this.providerSessionId ||= event.session_id;
        this.ensureSessionOpen();
        break;
      case "message.delta":
        this.ensureStepOpen();
        this.assistantOpen = true;
        this.assistantText += event.text;
        break;
      case "message.completed":
        this.ensureStepOpen();
        this.assistantOpen = true;
        // A completed message is the authoritative final text for the step:
        // it replaces any deltas accumulated so far (the original engine
        // overwrote `finalMessage` on `message.completed`).
        this.assistantText = event.text;
        this.closeAssistantMessage();
        break;
      case "tool.started":
        this.ensureStepOpen();
        this.openCalls.set(event.call_id, { callId: event.call_id, name: event.name });
        this.append({
          type: "tool/call",
          data: {
            turn: this.turn,
            step: this.step,
            callId: event.call_id,
            name: event.name,
            arguments: event.input === undefined ? "{}" : JSON.stringify(event.input),
          },
        });
        break;
      case "tool.completed": {
        const open = this.openCalls.get(event.call_id);
        if (!open) {
          // A result without a recorded call cannot be paired; record it as a
          // namespaced informational event rather than fabricating a call.
          this.append({
            type: "hitch/unpaired-tool-result",
            data: { call_id: event.call_id, status: event.status, output: event.output ?? null },
            ignorable: true,
          });
          break;
        }
        this.openCalls.delete(event.call_id);
        const isError = event.status !== "succeeded";
        this.append({
          type: "tool/result",
          data: {
            turn: this.turn,
            step: this.step,
            message: {
              id: randomUUID(),
              role: "user",
              content: [{
                type: "tool-result",
                toolCallId: event.call_id,
                content: [{ type: "text", text: toolResultText(event.output) }],
                isError,
              }],
              source: { kind: "tool", callId: event.call_id },
            },
            ...(isError ? { error: { name: open.name, code: "tool_failed" } } : {}),
          },
          surfaceOp: "append",
        });
        break;
      }
      case "usage.updated":
        const usage = normalizeUsage(event.usage);
        if (!usage) break;
        if (this.assistantOpen) {
          this.assistantUsage = usage;
        } else if (this.lastAssistantEvent && this.lastAssistantEvent.type === "assistant/message") {
          // Some adapters (Pi, OpenCode) emit usage after `message.completed`
          // closed the assistant message. Attach it to the just-closed
          // assistant/message so the canonical record carries the accounting.
          const data = this.lastAssistantEvent.data as Record<string, unknown>;
          if (!("usage" in data)) data.usage = usage;
        }
        break;
      case "diagnostic":
        this.append({
          type: "hitch/diagnostic",
          data: { level: event.level, message: event.message },
          ignorable: true,
        });
        break;
      case "provider.event":
        this.append({
          type: "hitch/provider-event",
          data: { provider_type: event.provider_type, native: event.native },
          ignorable: true,
        });
        break;
      default:
        this.append({
          type: "hitch/unknown-event",
          data: { native: event },
          ignorable: true,
        });
    }
  }

  /** Feed raw plain-text output (minimal fidelity). */
  feedText(text: string): void {
    this.ensureStepOpen();
    this.assistantOpen = true;
    this.assistantText += text;
  }

  /**
   * Close the trajectory. `status` selects the terminal turn reason.
   * Returns the finalized projection.
   */
  finalize(status: "succeeded" | "failed" | "cancelled" | "timed_out"): ProjectedSession {
    if (this.finalized) return this.project();
    this.finalized = true;
    // A timeout/cancellation/crash with no recorded work still gets a valid
    // terminal boundary (spec §5.4): open and close the session so the log is
    // structurally complete even when nothing was emitted.
    if (this.events.length === 0 && status !== "succeeded") this.ensureSessionOpen();
    if (this.assistantOpen && this.assistantText) this.closeAssistantMessage(true);
    if (this.stepOpen) {
      // A successful run may not end with open tool calls: the harness claimed
      // to finish cleanly, so an unpaired call is evidence of a broken
      // trajectory, not an interruption. Only failed/timed_out/cancelled runs
      // may synthesize unknown-outcome results for interrupted calls (spec
      // §5.4: a completed run has no open call).
      if (status === "succeeded" && this.openCalls.size > 0) {
        const open = [...this.openCalls.values()].map((call) => call.callId).join(", ");
        throw new Error(`trajectory finalization failed: run succeeded with open tool calls: ${open}`);
      }
      for (const open of [...this.openCalls.values()]) {
        this.openCalls.delete(open.callId);
        this.append({
          type: "tool/result",
          data: {
            turn: this.turn,
            step: this.step,
            message: {
              id: randomUUID(),
              role: "user",
              content: [{
                type: "tool-result",
                toolCallId: open.callId,
                content: [{ type: "text", text: `tool call interrupted: ${open.name} outcome unknown` }],
                isError: true,
              }],
              source: { kind: "tool", callId: open.callId },
            },
            error: { name: open.name, code: "TOOL_OUTCOME_UNKNOWN" },
          },
          surfaceOp: "append",
        });
      }
      this.append({ type: "step/end", data: { turn: this.turn, step: this.step } });
      this.stepOpen = false;
    }
    if (this.turnOpen) {
      this.append({
        type: "turn/end",
        data: { turn: this.turn, reason: terminalReason(status) },
      });
      this.turnOpen = false;
    }
    return this.project();
  }

  private ensureSessionOpen(): void {
    if (this.turnOpen) return;
    this.turnOpen = true;
    this.append({
      type: "turn/start",
      data: { turn: this.turn },
    });
  }

  private appendPrompt(): void {
    if (this.promptRecorded) return;
    this.append({
      type: "user/message",
      data: {
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: this.prompt }],
        source: { kind: "user" },
      },
      surfaceOp: "append",
    });
    this.promptRecorded = true;
  }

  private ensureStepOpen(): void {
    this.ensureSessionOpen();
    if (this.stepOpen) return;
    this.stepOpen = true;
    this.append({ type: "step/start", data: { turn: this.turn, step: this.step } });
    this.appendPrompt();
    if (!this.requestHeaderRecorded) {
      this.append({
        type: "request/header",
        data: {
          header: { config: { ...this.modelSource } },
          reason: "initial",
        },
      });
      this.requestHeaderRecorded = true;
    }
  }

  private closeAssistantMessage(interrupted = false): void {
    if (!this.assistantOpen) return;
    const text = this.assistantText;
    if (text) this.finalOutput = text;
    this.lastAssistantEvent = this.append({
      type: "assistant/message",
      data: {
        turn: this.turn,
        step: this.step,
        message: {
          id: randomUUID(),
          role: "assistant",
          content: [{ type: "text", text }],
          source: { kind: "model", ...this.modelSource },
        },
        ...(this.assistantUsage ? { usage: this.assistantUsage } : {}),
        ...(interrupted ? { interrupted: true } : {}),
      },
      sourceEventSeqs: [],
      surfaceOp: "append",
    });
    this.assistantOpen = false;
    this.assistantText = "";
    this.assistantUsage = undefined;
  }

  private append(event: Omit<SessionEvent, "seq" | "time">): SessionEvent {
    const framed: SessionEvent = {
      ...event,
      seq: this.seq,
      time: Date.now(),
    };
    this.seq += 1;
    this.events.push(framed);
    return framed;
  }

  private project(): ProjectedSession {
    const result: ProjectedSession = {
      header: { ...this.header },
      events: [...this.events],
      finalOutput: this.finalOutput,
      fidelity: this.fidelity,
    };
    if (this.providerSessionId) result.providerSessionId = this.providerSessionId;
    return result;
  }
}

function parseModelSource(model: string): { provider: string; model: string } {
  const separator = model.indexOf("/");
  if (separator > 0 && separator < model.length - 1) {
    return { provider: model.slice(0, separator), model: model.slice(separator + 1) };
  }
  return { provider: "hitch", model: model || "unknown" };
}

/** Convert native harness accounting into the canonical DSH usage envelope. */
function normalizeUsage(usage: Record<string, unknown>): Record<string, number> | undefined {
  const cache = usage.cache && typeof usage.cache === "object" ? usage.cache as Record<string, unknown> : {};
  const number = (...values: unknown[]): number => {
    for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
    return 0;
  };
  const input = number(usage.inputTokens, usage.uncachedInputTokens, usage.input_tokens, usage.input);
  const output = number(usage.outputTokens, usage.output_tokens, usage.output);
  const cacheRead = number(usage.cacheReadTokens, usage.cached_input_tokens, usage.cacheRead, cache.read);
  const cacheWrite = number(usage.cacheWriteTokens, usage.cache_write_input_tokens, usage.cacheWrite, cache.write);
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}

function toolResultText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function terminalReason(status: "succeeded" | "failed" | "cancelled" | "timed_out"): { kind: string; reason?: unknown; error?: unknown } {
  switch (status) {
    case "succeeded":
      return { kind: "completed" };
    case "cancelled":
      return { kind: "aborted", reason: { kind: "user" } };
    case "timed_out":
      return { kind: "aborted", reason: { kind: "hook", reason: "timeout" } };
    case "failed":
      return { kind: "error", error: { message: "agent process failed", code: "UNKNOWN" } };
  }
}

export { EVENT_TYPE_KEYS };
