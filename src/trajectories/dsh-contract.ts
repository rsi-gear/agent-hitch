import type { SessionEvent } from "../domain/index.js";
import { IncrementalChunkInvariant, validateContentBlock } from "./dsh-chunk-contract.js";
import { validateEmbeddedAssistantStream } from "./embedded-stream.js";

const EVENT_ENVELOPE_KEYS = new Set(["type", "seq", "time", "data", "surfaceOp", "sourceEventSeqs", "ignorable"]);
const ADAPTER_DEFAULT_KEYS = new Set(["reasoningEffort", "maxTokens"]);

/** Canonical counterpart of DSH canonicalHeader(). Validation happens before normalization. */
export function canonicalRequestHeader(value: unknown, version = 0): Record<string, unknown> {
  const header = record(value, "request header");
  if (version >= 3 && Object.hasOwn(header, "system")) throw new Error("request header must not contain retired system field");
  const config = record(header.config, "request header config");
  nonEmptyString(config.provider, "request header config.provider");
  nonEmptyString(config.model, "request header config.model");
  if (config.reasoningEffort !== undefined) nonEmptyString(config.reasoningEffort, "request header config.reasoningEffort");
  const adapterDefaults = validateAdapterDefaults(header.adapterDefaults, config);
  if (header.system !== undefined && typeof header.system !== "string") throw new Error("request header system must be a string");
  if (header.tools !== undefined && !Array.isArray(header.tools)) throw new Error("request header tools must be an array");
  return {
    config,
    ...(adapterDefaults?.reasoningEffort === true || adapterDefaults?.maxTokens === true ? { adapterDefaults } : {}),
    ...(typeof header.system === "string" && header.system.length > 0 ? { system: header.system } : {}),
    ...(Array.isArray(header.tools) && header.tools.length > 0 ? { tools: header.tools } : {}),
  };
}

/** Validate DSH's current replay boundary without retaining prior events. */
export class IncrementalDshInvariant {
  private openTurn: number | null = null;
  private openStep: number | null = null;
  private nextTurn = 1;
  private nextStep = 1;
  private readonly pendingCalls = new Set<string>();
  private readonly scheduledRetries = new Set<string>();
  private chunkStream: IncrementalChunkInvariant | null = null;
  private inheritedMarker = false;

  constructor(private readonly version = 0, private readonly isSeeded?: boolean) {}

  finish(): void {
    if (this.version >= 2 && this.isSeeded !== undefined && this.isSeeded !== this.inheritedMarker) {
      throw new Error("session isSeeded disagrees with its inherited session/end-seed marker");
    }
  }

  accept(event: SessionEvent, raw: unknown): void {
    const envelope = record(raw, `session event at seq ${event.seq}`);
    if (!event.ignorable
      && (!/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)+$/.test(event.type) || event.type.length > 128)) {
      throw new Error(`session event at seq ${event.seq} has an invalid event type`);
    }
    if (event.ignorable && event.type.length > 1_024) {
      throw new Error(`session event at seq ${event.seq} has an event type longer than 1024 characters`);
    }
    if (Object.keys(envelope).some((key) => !EVENT_ENVELOPE_KEYS.has(key))) {
      throw new Error(`session event at seq ${event.seq} has an invalid event envelope`);
    }
    if (envelope.ignorable !== undefined && envelope.ignorable !== true) {
      throw new Error(`session event at seq ${event.seq} has an invalid ignorable marker`);
    }
    if (event.sourceEventSeqs?.some((seq) => !Number.isSafeInteger(seq) || seq < 0)) {
      throw new Error(`session event at seq ${event.seq} has invalid sourceEventSeqs`);
    }
    const rawSurfaceOp = envelope.surfaceOp;
    if (rawSurfaceOp !== undefined && rawSurfaceOp !== "append") {
      const op = record(rawSurfaceOp, `session event at seq ${event.seq} surfaceOp`);
      const start = this.version >= 3 ? op.startSeq : op.start;
      const end = this.version >= 3 ? op.endSeq : op.end;
      const keys = this.version >= 3 ? "endSeq,op,startSeq" : "end,op,start";
      if (Object.keys(op).sort().join(",") !== keys || op.op !== "replace"
        || !Number.isSafeInteger(start) || (start as number) < 0 || (start as number) >= event.seq
        || !Number.isSafeInteger(end) || (end as number) < 0 || (end as number) >= event.seq) {
        throw new Error(`session event at seq ${event.seq} has an invalid replace surfaceOp`);
      }
    }
    if (event.type === "request/header-delta") throw new Error("legacy request/header-delta is unsupported");
    this.validateShape(event);
    this.validateRelations(event);
  }

  private validateShape(event: SessionEvent): void {
    const data = record(event.data, `${event.type} data`);
    switch (event.type) {
      case "session/end-seed":
        if (this.version >= 2 && data.inherited !== undefined) {
          if (data.inherited !== true) throw new Error("session/end-seed inherited must be true when present");
          this.inheritedMarker = true;
        }
        break;
      case "request/header": {
        const reasons = this.version >= 3 ? ["initial", "resume", "change", "series"] : ["initial", "resume", "change"];
        if (!reasons.includes(String(data.reason))) throw new Error(`request/header reason must be ${reasons.join(", ")}`);
        if (data.startsSeries !== undefined && (this.version < 3 || data.startsSeries !== true)) {
          throw new Error("request/header has an invalid startsSeries marker");
        }
        canonicalRequestHeader(data.header, this.version);
        break;
      }
      case "user/message":
        validateMessage(data, "user", "user/message", this.version);
        break;
      case "assistant/message":
        stepIdentity(data, "assistant/message");
        validateMessage(record(data.message, "assistant/message message"), "assistant", "assistant/message", this.version);
        validateModelSource(record(data.message, "assistant/message message").source);
        if (this.version >= 2) {
          if (event.sourceEventSeqs !== undefined) throw new Error("assistant/message embeds its stream and cannot carry sourceEventSeqs");
          validateEmbeddedAssistantStream(data.stream);
        } else this.chunkStream?.assertReadyForMessage();
        break;
      case "assistant/attempt":
        if (this.version < 2) throw new Error("assistant/attempt requires session format v2 or later");
        stepIdentity(data, event.type);
        validateEmbeddedAssistantStream(data.stream);
        break;
      case "system/message":
      case "developer/message": {
        const role = event.type === "system/message" ? "system" : "developer";
        if (this.version < (role === "system" ? 3 : 4)) throw new Error(`${event.type} is unsupported in session format v${this.version}`);
        stepIdentity(data, event.type);
        const message = record(data.message, `${event.type} message`);
        validateMessage(message, role, event.type, this.version);
        const source = record(message.source, `${event.type} source`);
        if (role === "system") {
          const expected = this.version >= 4 ? "system-prompt" : "plugin";
          if (source.kind !== expected) throw new Error(`system/message requires ${expected} source`);
          if (this.version === 3) nonEmptyString(source.plugin, "system/message source.plugin");
        } else {
          const additions = (message.content as Array<Record<string, unknown>>).some((block) => block.type === "tool-addition");
          if (additions) {
            if (nonNegativeInteger(data.headerSeq, "developer/message headerSeq") >= event.seq) throw new Error("developer/message headerSeq must reference an earlier request/header");
          } else if (data.headerSeq !== undefined) throw new Error("developer/message must omit headerSeq without tool additions");
        }
        break;
      }
      case "tool/result": {
        stepIdentity(data, "tool/result");
        const message = record(data.message, "tool/result message");
        validateMessage(message, this.version >= 4 ? "tool" : "user", "tool/result", this.version);
        const source = record(message.source, "tool/result source");
        if (source.kind !== "tool") throw new Error("tool/result message must have tool source");
        const callId = nonEmptyString(source.callId, "tool/result source.callId");
        const content = message.content as unknown[];
        if (this.version >= 4) {
          if (message.toolCallId !== callId) throw new Error("tool/result toolCallId must match its tool source");
          if (message.isError !== undefined && typeof message.isError !== "boolean") throw new Error("tool/result isError must be boolean");
          if (data.error !== undefined && message.isError !== true) throw new Error("tool/result error metadata requires an error result");
        } else {
          const block = content.length === 1 ? record(content[0], "tool/result content block") : null;
          if (!block || block.type !== "tool-result" || !Array.isArray(block.content) || block.toolCallId !== callId) {
            throw new Error("tool/result message must contain one matching tool-result block");
          }
          if (data.error !== undefined && block.isError !== true) throw new Error("tool/result error metadata requires an error result");
        }
        break;
      }
      case "assistant/chunk": {
        if (this.version >= 2) throw new Error("assistant/chunk is retired in session format v2 and later");
        stepIdentity(data, "assistant/chunk");
        this.chunkStream?.accept(data.chunk);
        break;
      }
      case "llm/retry":
        stepIdentity(data, "llm/retry");
        nonEmptyString(data.retryId, "llm/retry retryId");
        if (!Number.isSafeInteger(data.retry) || (data.retry as number) < 1) {
          throw new Error("llm/retry retry must be a positive safe integer");
        }
        break;
      case "llm/retry-started":
        stepIdentity(data, "llm/retry-started");
        nonEmptyString(data.retryId, "llm/retry-started retryId");
        if (!Number.isSafeInteger(data.retry) || (data.retry as number) < 1) {
          throw new Error("llm/retry-started retry must be a positive safe integer");
        }
        break;
      case "turn/start":
      case "turn/end":
        nonNegativeInteger(data.turn, `${event.type} turn`);
        break;
      case "step/start":
      case "step/end":
        stepIdentity(data, event.type);
        break;
      case "tool/call":
        stepIdentity(data, "tool/call");
        nonEmptyString(data.callId, "tool/call callId");
        nonEmptyString(data.name, "tool/call name");
        if (typeof data.arguments !== "string") throw new Error("tool/call arguments must be a string");
        break;
    }
  }

  private validateRelations(event: SessionEvent): void {
    const data = event.data as Record<string, unknown>;
    switch (event.type) {
      case "turn/start": {
        const turn = data.turn as number;
        if (this.openTurn !== null) throw new Error(`turn/start ${turn} while turn ${this.openTurn} is open`);
        if (turn !== this.nextTurn) throw new Error(`turn/start expected turn ${this.nextTurn}, got ${turn}`);
        this.openTurn = turn;
        this.nextStep = 1;
        break;
      }
      case "turn/end": {
        const turn = data.turn as number;
        if (this.openTurn !== turn || this.openStep !== null) throw new Error(`turn/end ${turn} does not close the current turn`);
        this.openTurn = null;
        this.nextTurn += 1;
        break;
      }
      case "step/start": {
        const { turn, step } = data as { turn: number; step: number };
        if (this.openTurn !== turn || this.openStep !== null || step !== this.nextStep) {
          throw new Error(`step/start ${turn}/${step} does not match the current turn/next step`);
        }
        this.openStep = step;
        this.chunkStream = new IncrementalChunkInvariant();
        break;
      }
      case "step/end": {
        this.requireOpenStep(event.type, data.turn as number, data.step as number);
        this.pendingCalls.clear();
        this.scheduledRetries.clear();
        this.openStep = null;
        this.chunkStream = null;
        this.nextStep += 1;
        break;
      }
      case "assistant/chunk":
      case "assistant/message":
      case "assistant/attempt":
      case "system/message":
      case "developer/message":
        this.requireOpenStep(event.type, data.turn as number, data.step as number);
        break;
      case "llm/retry": {
        this.requireOpenStep(event.type, data.turn as number, data.step as number);
        const key = retryKey(data);
        if (this.scheduledRetries.has(key)) throw new Error("llm/retry repeats a scheduled retry attempt");
        this.scheduledRetries.add(key);
        break;
      }
      case "llm/retry-started": {
        this.requireOpenStep(event.type, data.turn as number, data.step as number);
        const key = retryKey(data);
        if (!this.scheduledRetries.delete(key)) throw new Error("llm/retry-started pairs no prior scheduled attempt");
        this.chunkStream?.assertReadyForRetry();
        this.chunkStream = new IncrementalChunkInvariant();
        break;
      }
      case "tool/call": {
        this.requireOpenStep(event.type, data.turn as number, data.step as number);
        const callId = data.callId as string;
        this.pendingCalls.add(callId);
        break;
      }
      case "tool/result": {
        if (event.surfaceOp !== "append") {
          if (this.openTurn === null) throw new Error("tool/result replacement is outside an open turn");
          break;
        }
        this.requireOpenStep(event.type, data.turn as number, data.step as number);
        const message = data.message as Record<string, unknown>;
        const source = message.source as Record<string, unknown>;
        const callId = source.callId as string;
        const content = message.content as Array<Record<string, unknown>>;
        const synthetic = (this.version >= 4 ? message.isError === true : content[0]?.isError === true)
          && (data.error as Record<string, unknown> | undefined)?.code === "TOOL_NOT_STARTED";
        if (!this.pendingCalls.has(callId) && !synthetic) throw new Error("tool/result has no prior tool/call in this step");
        this.pendingCalls.delete(callId);
        break;
      }
      case "request/header":
      case "request/context":
      case "todo/write":
        if (this.openTurn === null) throw new Error(`${event.type} is outside an open turn`);
        break;
    }
  }

  private requireOpenStep(kind: string, turn: number, step: number): void {
    if (this.openTurn !== turn || this.openStep !== step) {
      throw new Error(`${kind} names turn ${turn}/step ${step} but open is ${this.openTurn}/step ${this.openStep}`);
    }
  }
}

function validateAdapterDefaults(value: unknown, config: Record<string, unknown>): Record<string, true> | undefined {
  if (value === undefined) return undefined;
  const defaults = record(value, "request header adapterDefaults");
  if (Object.keys(defaults).some((key) => !ADAPTER_DEFAULT_KEYS.has(key))
    || Object.values(defaults).some((marker) => marker !== true)
    || (defaults.reasoningEffort === true && config.reasoningEffort === undefined)
    || (defaults.maxTokens === true && config.maxTokens === undefined)) {
    throw new Error("request header adapterDefaults are invalid");
  }
  return defaults as Record<string, true>;
}

function validateMessage(message: Record<string, unknown>, role: "user" | "assistant" | "system" | "developer" | "tool", label: string, version: number): void {
  nonEmptyString(message.id, `${label} message.id`);
  if (message.role !== role) throw new Error(`${label} message must have role ${role}`);
  const source = record(message.source, `${label} message.source`);
  nonEmptyString(source.kind, `${label} message.source.kind`);
  if (version >= 4 && source.kind === "plugin") throw new Error(`${label} requires a producer-owned source kind`);
  if (!Array.isArray(message.content)) throw new Error(`${label} message content must be an array`);
  message.content.forEach((entry, index) => {
    const block = validateContentBlock(entry, `${label} message.content[${index}]`);
    if (version >= 4 && block.type === "tool-result") throw new Error(`${label} must not contain a retired tool-result wrapper`);
    if (block.type === "tool-addition" || block.type === "tool-removal") {
      if (version < 4 || role !== "developer") throw new Error("tool-change content requires a v4 developer message");
      nonEmptyString(block.toolName, `${label} toolName`);
      if (block.type === "tool-addition" && Object.hasOwn(block, "tool")) throw new Error("tool-addition must omit inline tool definitions");
    }
  });
}

function validateModelSource(value: unknown): void {
  const source = record(value, "assistant/message source");
  if (source.kind !== "model") throw new Error("assistant/message must have model source");
  nonEmptyString(source.provider, "assistant/message source.provider");
  nonEmptyString(source.model, "assistant/message source.model");
}

function stepIdentity(data: Record<string, unknown>, label: string): void {
  nonNegativeInteger(data.turn, `${label} turn`);
  nonNegativeInteger(data.step, `${label} step`);
}

function retryKey(data: Record<string, unknown>): string {
  return `${String(data.retryId)}\u0000${String(data.retry)}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value as number;
}
