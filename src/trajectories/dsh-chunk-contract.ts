const CHUNK_TYPES = new Set([
  "block-start",
  "text-delta",
  "reasoning-delta",
  "tool-call-delta",
  "block-end",
  "usage",
  "finish",
]);

/** Validate one DSH model stream while allowing EOF to preserve interrupted evidence. */
export class IncrementalChunkInvariant {
  private readonly openBlocks = new Map<number, OpenBlock>();
  private usageSeen = false;
  private finished = false;
  private seen = false;

  accept(value: unknown): void {
    const chunk = record(value, "assistant/chunk chunk");
    const type = nonEmptyString(chunk.type, "assistant/chunk type");
    if (!CHUNK_TYPES.has(type)) throw new Error("assistant/chunk has an unsupported type");
    if (this.finished) throw new Error("assistant/chunk emitted data after terminal finish");
    this.seen = true;
    switch (type) {
      case "block-start": {
        const index = chunkIndex(chunk, type);
        const blockType = nonEmptyString(chunk.blockType, "block-start blockType");
        if (this.openBlocks.has(index)) throw new Error(`assistant/chunk repeated block-start index ${index}`);
        this.openBlocks.set(index, { type: blockType });
        break;
      }
      case "text-delta":
      case "reasoning-delta": {
        const expected = type === "text-delta" ? "text" : "reasoning";
        requireOpenBlock(this.openBlocks, chunkIndex(chunk, type), expected);
        if (typeof chunk.text !== "string") throw new Error(`${type} text must be a string`);
        break;
      }
      case "tool-call-delta": {
        const index = chunkIndex(chunk, type);
        if (typeof chunk.id !== "string") throw new Error("tool-call-delta id must be a string");
        const open = requireOpenBlock(this.openBlocks, index, "tool-call");
        if (open.toolCallId === undefined) open.toolCallId = chunk.id;
        else if (open.toolCallId !== chunk.id) throw new Error("tool-call-delta id changed within an open block");
        if (chunk.name !== undefined && typeof chunk.name !== "string") {
          throw new Error("tool-call-delta name must be a string");
        }
        if (typeof chunk.argumentsDelta !== "string") {
          throw new Error("tool-call-delta argumentsDelta must be a string");
        }
        break;
      }
      case "block-end": {
        const index = chunkIndex(chunk, type);
        const block = validateContentBlock(chunk.block, "block-end block");
        const open = requireOpenBlock(this.openBlocks, index, block.type as string);
        if (block.type === "tool-call" && open.toolCallId !== undefined && block.id !== open.toolCallId) {
          throw new Error("block-end tool-call id does not match its deltas");
        }
        this.openBlocks.delete(index);
        break;
      }
      case "usage":
        if (this.usageSeen) throw new Error("assistant/chunk emitted usage more than once");
        validateUsage(chunk.usage);
        this.usageSeen = true;
        break;
      case "finish": {
        const reason = validateFinishReason(chunk.reason);
        if (this.openBlocks.size > 0 && reason !== "error" && reason !== "aborted") {
          throw new Error(`assistant/chunk finished with ${this.openBlocks.size} open block(s)`);
        }
        this.finished = true;
        break;
      }
    }
  }

  assertReadyForMessage(): void {
    if (this.seen && !this.finished) throw new Error("assistant/message precedes terminal finish chunk");
  }

  assertReadyForRetry(): void {
    if (this.seen && !this.finished) throw new Error("llm/retry-started precedes terminal finish chunk");
  }
}

interface OpenBlock {
  type: string;
  toolCallId?: string;
}

export function validateContentBlock(value: unknown, label: string): Record<string, unknown> {
  const block = record(value, label);
  const type = nonEmptyString(block.type, `${label}.type`);
  switch (type) {
    case "text":
    case "reasoning":
      if (typeof block.text !== "string") throw new Error(`${label}.text must be a string`);
      break;
    case "tool-call":
      if (typeof block.id !== "string" || typeof block.name !== "string" || typeof block.arguments !== "string") {
        throw new Error(`${label} tool-call fields are invalid`);
      }
      break;
    case "tool-result":
      if (typeof block.toolCallId !== "string" || !Array.isArray(block.content)) {
        throw new Error(`${label} tool-result fields are invalid`);
      }
      if (block.isError !== undefined && typeof block.isError !== "boolean") {
        throw new Error(`${label}.isError must be a boolean`);
      }
      block.content.forEach((entry, index) => validateContentBlock(entry, `${label}.content[${index}]`));
      break;
    case "image":
      record(block.attachment, `${label}.attachment`);
      break;
  }
  return block;
}

function validateUsage(value: unknown): void {
  const usage = record(value, "usage chunk usage");
  tokenCount(usage.inputTokens, "usage.inputTokens");
  tokenCount(usage.outputTokens, "usage.outputTokens");
  for (const key of ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"]) {
    if (usage[key] !== undefined) tokenCount(usage[key], `usage.${key}`);
  }
}

function validateFinishReason(value: unknown): string {
  const reason = record(value, "finish chunk reason");
  const kind = nonEmptyString(reason.kind, "finish chunk reason.kind");
  if (kind === "error" || kind === "aborted") {
    const failure = record(reason.failure, `finish chunk ${kind} failure`);
    nonEmptyString(failure.message, `finish chunk ${kind} failure.message`);
    nonEmptyString(failure.code, `finish chunk ${kind} failure.code`);
    if (failure.status !== undefined) tokenCount(failure.status, `finish chunk ${kind} failure.status`);
    if (failure.providerRetryAfterMs !== undefined) {
      tokenCount(failure.providerRetryAfterMs, `finish chunk ${kind} failure.providerRetryAfterMs`);
    }
    if (failure.requestId !== undefined && typeof failure.requestId !== "string") {
      throw new Error(`finish chunk ${kind} failure.requestId must be a string`);
    }
  }
  return kind;
}

function chunkIndex(chunk: Record<string, unknown>, type: string): number {
  if (!Number.isSafeInteger(chunk.index) || (chunk.index as number) < 0) {
    throw new Error(`${type} index must be a non-negative safe integer`);
  }
  return chunk.index as number;
}

function requireOpenBlock(open: ReadonlyMap<number, OpenBlock>, index: number, expected: string): OpenBlock {
  const actual = open.get(index);
  if (actual?.type !== expected) {
    throw new Error(`assistant/chunk at index ${index} does not match its open block`);
  }
  return actual;
}

function tokenCount(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}
