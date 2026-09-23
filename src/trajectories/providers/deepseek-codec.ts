import type { SessionEvent } from "../../domain/index.js";
import { parseEventLine } from "../format.js";

const PACKED_TYPES = new Set(["text-chunks", "reasoning-chunks", "tool-call-chunks"]);

/** Decode DSH physical rows without changing logical event coordinates or payloads. */
export function decodeDeepseekEventRows(rows: readonly unknown[], version: number): SessionEvent[] {
  if (!Number.isSafeInteger(version) || version < 0 || version > 4) {
    throw new Error(`unsupported DSH session format version ${version}`);
  }
  const events: SessionEvent[] = [];
  for (const [index, value] of rows.entries()) {
    const row = record(value, `DSH row ${index}`);
    if (typeof row.type === "string" && PACKED_TYPES.has(row.type)) {
      if (version >= 2) throw new Error(`DSH session format v${version} does not support packed top-level rows`);
      decodePackedRow(row, index, events, version);
      continue;
    }
    const seq = count(row.seq, `DSH row ${index} seq`);
    assertNextSeq(seq, events.length);
    const decoded = row.sourceEventSeqs === undefined ? row : {
      ...row,
      sourceEventSeqs: decodeSourceEventSeqs(row.sourceEventSeqs, seq),
    };
    events.push(parseEventLine(decoded, version));
  }
  return events;
}

function decodePackedRow(row: Record<string, unknown>, rowIndex: number, events: SessionEvent[], version: number): void {
  const label = `DSH ${String(row.type)} row ${rowIndex}`;
  exactKeys(row, ["type", "seq0", "time0", "data"], [], label);
  const seq0 = count(row.seq0, `${label} seq0`);
  // Check the starting coordinate before expanding any attacker-controlled count.
  assertNextSeq(seq0, events.length);
  const time0 = safeInteger(row.time0, `${label} time0`);
  const data = record(row.data, `${label} data`);
  const isTool = row.type === "tool-call-chunks";
  exactKeys(data, isTool
    ? ["turn", "step", "index", "id", "dt", "args"]
    : ["turn", "step", "index", "dt", "texts"], isTool ? ["name"] : [], `${label} data`);
  const payload = data[isTool ? "args" : "texts"];
  if (!Array.isArray(payload) || payload.length === 0 || payload.some((item) => typeof item !== "string")) {
    throw new Error(`${label} payload must be a non-empty string array`);
  }
  const gaps = data.dt;
  if (!Array.isArray(gaps) || gaps.length !== payload.length - 1) {
    throw new Error(`${label} dt length must match its payload`);
  }
  const turn = count(data.turn, `${label} turn`);
  const step = count(data.step, `${label} step`);
  const index = count(data.index, `${label} index`);
  if (isTool && (typeof data.id !== "string" || data.id.length === 0
    || (data.name !== undefined && typeof data.name !== "string"))) {
    throw new Error(`${label} id must be non-empty and optional name must be a string`);
  }
  count(seq0 + payload.length - 1, `${label} final seq`);
  // Validate the complete packed row before emitting any of its logical events.
  let time = time0;
  for (const gap of gaps) {
    time = safeInteger(time + safeInteger(gap, `${label} dt member`), `${label} member time`);
  }
  time = time0;
  for (let member = 0; member < payload.length; member += 1) {
    if (member > 0) time += gaps[member - 1] as number;
    const chunk = isTool ? {
      type: "tool-call-delta", index, id: data.id,
      ...(data.name === undefined ? {} : { name: data.name }),
      argumentsDelta: payload[member],
    } : {
      type: row.type === "text-chunks" ? "text-delta" : "reasoning-delta", index, text: payload[member],
    };
    events.push(parseEventLine({ type: "assistant/chunk", seq: seq0 + member, time, data: { turn, step, chunk } }, version));
  }
}

function decodeSourceEventSeqs(value: unknown, seq: number): number[] {
  if (!Array.isArray(value)) throw new Error("sourceEventSeqs must be an array");
  const hasRange = value.some(Array.isArray);
  const result: number[] = [];
  const seen = new Set<number>();
  for (const entry of value) {
    let start: number;
    let end: number;
    if (Array.isArray(entry)) {
      if (entry.length !== 2) throw new Error("sourceEventSeqs range must be a [start, end] pair");
      start = count(entry[0], "sourceEventSeqs range start");
      end = count(entry[1], "sourceEventSeqs range end");
    } else {
      start = end = count(entry, "sourceEventSeqs member");
    }
    // Bound expansion by already decoded events, never by an untrusted row seq.
    if (start > end || end >= seq || end - start + 1 > seq - result.length) {
      throw new Error("sourceEventSeqs range exceeds its event seq");
    }
    if (hasRange && result.length > 0 && start <= result[result.length - 1]!) {
      throw new Error("sourceEventSeqs ranges must be strictly increasing");
    }
    for (let source = start; source <= end; source += 1) {
      if (seen.has(source)) throw new Error("sourceEventSeqs must contain unique earlier seqs");
      seen.add(source);
      result.push(source);
    }
  }
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[], label: string): void {
  const keys = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !keys.has(key))) {
    throw new Error(`${label} has invalid fields`);
  }
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
  return value;
}

function count(value: unknown, label: string): number {
  const integer = safeInteger(value, label);
  if (integer < 0 || Object.is(integer, -0)) throw new Error(`${label} must be non-negative`);
  return integer;
}

function assertNextSeq(actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`DSH session seq gap: expected ${expected}, got ${actual}`);
}
