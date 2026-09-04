import type { SessionEvent } from "../domain/index.js";
import { IncrementalChunkInvariant, validateContentBlock } from "./dsh-chunk-contract.js";

const EVENT_ENVELOPE_KEYS = new Set(["type", "seq", "time", "data", "surfaceOp", "sourceEventSeqs", "ignorable"]);
const ADAPTER_DEFAULT_KEYS = new Set(["reasoningEffort", "maxTokens"]);

/** Canonical counterpart of DSH canonicalHeader(). Validation happens before normalization. */
export function canonicalRequestHeader(value: unknown): Record<string, unknown> {
  const header = record(value, "request header");
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
      if (Object.keys(op).sort().join(",") !== "end,op,start" || op.op !== "replace"
        || !Number.isSafeInteger(op.start) || (op.start as number) < 0
        || !Number.isSafeInteger(op.end) || (op.end as number) < 0) {
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
      case "request/header": {
        if (!new Set(["initial", "resume", "change"]).has(String(data.reason))) {
          throw new Error("request/header reason must be initial, resume, or change");
        }
        canonicalRequestHeader(data.header);
        break;
      }
      case "user/message":
        validateMessage(data, "user", "user/message");
        break;
      case "assistant/message":
        stepIdentity(data, "assistant/message");
        validateMessage(record(data.message, "assistant/message message"), "assistant", "assistant/message");
        validateModelSource(record(data.message, "assistant/message message").source);
        this.chunkStream?.assertReadyForMessage();
        break;
      case "tool/result": {
        stepIdentity(data, "tool/result");
        const message = record(data.message, "tool/result message");
        validateMessage(message, "user", "tool/result");
        const source = record(message.source, "tool/result source");
        if (source.kind !== "tool") throw new Error("tool/result message must have tool source");
        const callId = nonEmptyString(source.callId, "tool/result source.callId");
        const content = message.content as unknown[];
        const block = content.length === 1 ? record(content[0], "tool/result content block") : null;
        if (!block || block.type !== "tool-result" || !Array.isArray(block.content) || block.toolCallId !== callId) {
          throw new Error("tool/result message must contain one matching tool-result block");
        }
        break;
      }
      case "assistant/chunk": {
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
        const synthetic = content[0]?.isError === true
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

function validateMessage(message: Record<string, unknown>, role: "user" | "assistant", label: string): void {
  nonEmptyString(message.id, `${label} message.id`);
  if (message.role !== role) throw new Error(`${label} message must have role ${role}`);
  const source = record(message.source, `${label} message.source`);
  nonEmptyString(source.kind, `${label} message.source.kind`);
  if (!Array.isArray(message.content)) throw new Error(`${label} message content must be an array`);
  message.content.forEach((entry, index) => validateContentBlock(entry, `${label} message.content[${index}]`));
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
