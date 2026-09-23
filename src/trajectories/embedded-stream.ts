import { validateContentBlock, validateFinishReason, validateUsage } from "./dsh-chunk-contract.js";

export interface EmbeddedStreamChunk {
  chunk: Record<string, unknown>;
  time: number;
  recordIndex: number;
  memberIndex: number;
}

/** Read DSH v2-v4 compact streams without inventing Session events or sequence numbers. */
export function* iterateEmbeddedAssistantStream(value: unknown): Generator<EmbeddedStreamChunk> {
  if (!Array.isArray(value)) throw new Error("assistant settlement stream must be an array");
  for (let recordIndex = 0; recordIndex < value.length; recordIndex += 1) {
    const record = object(value[recordIndex]);
    if (record.type === "chunk") {
      exactKeys(record, ["type", "time", "chunk"]);
      safeTime(record.time);
      yield { chunk: object(record.chunk), time: record.time as number, recordIndex, memberIndex: 0 };
      continue;
    }
    if (record.type !== "text-chunks" && record.type !== "reasoning-chunks" && record.type !== "tool-call-chunks") {
      throw new Error("assistant settlement stream has an unsupported compact record");
    }
    const tool = record.type === "tool-call-chunks";
    exactKeys(record, ["type", "time0", "index", "dt", ...(tool ? ["id", "args", ...(Object.hasOwn(record, "name") ? ["name"] : [])] : ["texts"])]);
    safeTime(record.time0);
    if (!Number.isSafeInteger(record.index) || (record.index as number) < 0 || Object.is(record.index, -0)) {
      throw new Error("assistant settlement stream index must be a non-negative safe integer");
    }
    const members = tool ? record.args : record.texts;
    if (!Array.isArray(members) || members.length === 0 || members.some((member) => typeof member !== "string")) {
      throw new Error("assistant settlement compact members must be a non-empty string array");
    }
    if (!Array.isArray(record.dt) || record.dt.length !== members.length - 1 || record.dt.some((gap) => !Number.isSafeInteger(gap))) {
      throw new Error("assistant settlement compact dt must contain one fewer safe integer than members");
    }
    if (tool && (typeof record.id !== "string" || record.id.length === 0
      || (Object.hasOwn(record, "name") && (typeof record.name !== "string" || record.name.length === 0)))) {
      throw new Error("assistant settlement tool-call run identity is invalid");
    }
    let time = record.time0 as number;
    for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
      if (memberIndex > 0) time += record.dt[memberIndex - 1] as number;
      safeTime(time);
      const chunk = tool
        ? { type: "tool-call-delta", index: record.index, id: record.id, ...(Object.hasOwn(record, "name") ? { name: record.name } : {}), argumentsDelta: members[memberIndex] }
        : { type: record.type === "text-chunks" ? "text-delta" : "reasoning-delta", index: record.index, text: members[memberIndex] };
      yield { chunk, time, recordIndex, memberIndex };
    }
  }
}

/** DSH's assembler accepts implicit starts and stream stragglers; validate shape, not v0/v1 ordering. */
export function validateEmbeddedAssistantStream(value: unknown): void {
  for (const { chunk } of iterateEmbeddedAssistantStream(value)) {
    if (["block-start", "block-end", "text-delta", "reasoning-delta", "tool-call-delta"].includes(String(chunk.type))
      && (!Number.isSafeInteger(chunk.index) || (chunk.index as number) < 0 || Object.is(chunk.index, -0))) {
      throw new Error("embedded chunk index must be a non-negative safe integer");
    }
    switch (chunk.type) {
      case "block-start":
        if (typeof chunk.blockType !== "string" || chunk.blockType.length === 0) throw new Error("embedded block-start requires blockType");
        break;
      case "text-delta":
      case "reasoning-delta":
        if (typeof chunk.text !== "string") throw new Error("embedded text delta requires text");
        break;
      case "tool-call-delta":
        if (typeof chunk.id !== "string" || typeof chunk.argumentsDelta !== "string"
          || (chunk.name !== undefined && typeof chunk.name !== "string")) throw new Error("embedded tool-call delta fields are invalid");
        break;
      case "block-end": validateContentBlock(chunk.block, "embedded block-end"); break;
      case "usage": validateUsage(chunk.usage); break;
      case "finish": validateFinishReason(chunk.reason); break;
      default: throw new Error("unsupported embedded stream chunk type");
    }
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("assistant settlement stream record/chunk must be an object");
  return value as Record<string, unknown>;
}

function safeTime(value: unknown): void {
  if (!Number.isSafeInteger(value)) throw new Error("assistant settlement stream time must be a safe integer");
}

function exactKeys(record: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new Error("assistant settlement stream record fields are invalid");
  }
}
