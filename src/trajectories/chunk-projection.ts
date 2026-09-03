import type { SessionEvent } from "../domain/index.js";
import { BoundedTextAccumulator, projectBoundedJson } from "./content-projection.js";
import type { ContentProjectionContext } from "./content-projection.js";

const PREVIEW_BYTES = 12 * 1024;
const TAIL_BYTES = 4 * 1024;

export interface ChunkGroup {
  turn: number;
  step: number;
  firstSeq: number;
  lastSeq: number;
  count: number;
  types: Map<string, number>;
  partialAccumulator: BoundedTextAccumulator;
  partialSourceCount: number;
  usage?: { seq: number; value: unknown };
  finishReason?: { seq: number; value: unknown };
  assembled: boolean;
}

export function acceptChunk(
  groups: Map<string, ChunkGroup>,
  event: SessionEvent,
  turn: number,
  step: number,
  chunk: Record<string, unknown>,
  credentialValues: readonly string[],
  pathValues: readonly string[],
  redactions: Map<string, number>,
): void {
  const key = `${turn}:${step}`;
  let group = groups.get(key);
  if (!group) {
    group = {
      turn,
      step,
      firstSeq: event.seq,
      lastSeq: event.seq,
      count: 0,
      types: new Map(),
      partialAccumulator: chunkAccumulator(credentialValues, pathValues, redactions),
      partialSourceCount: 0,
      assembled: false,
    };
    groups.set(key, group);
  }
  group.lastSeq = event.seq;
  group.count += 1;
  const type = typeof chunk.type === "string" ? chunk.type : "unknown";
  increment(group.types, type);
  if (type === "usage") group.usage = { seq: event.seq, value: chunk.usage };
  if (type === "finish") group.finishReason = { seq: event.seq, value: chunk.reason };
  if (typeof chunk.text === "string") {
    group.partialAccumulator.append(chunk.text);
    group.partialSourceCount += 1;
  }
  if (type === "tool-call-delta" && typeof chunk.argumentsDelta === "string") {
    group.partialAccumulator.append(chunk.argumentsDelta);
    group.partialSourceCount += 1;
  }
}

export function chunkSummary(
  group: ChunkGroup,
  runId: string,
  contextFor: (seq: number) => ContentProjectionContext,
): unknown {
  const base = {
    turn: group.turn,
    step: group.step,
    first_seq: group.firstSeq,
    last_seq: group.lastSeq,
    count: group.count,
    types: sortedCounts(Object.fromEntries(group.types)),
    model_boundary_seq: group.firstSeq,
    ...(group.usage === undefined ? {} : {
      usage: projectBoundedJson(group.usage.value, contextFor(group.usage.seq), "data.chunk.usage"),
    }),
    ...(group.finishReason === undefined ? {} : {
      finish_reason: projectBoundedJson(group.finishReason.value, contextFor(group.finishReason.seq), "data.chunk.reason"),
    }),
  };
  if (group.assembled) return base;
  return {
    ...base,
    partial: {
      status: "incomplete",
      content: group.partialAccumulator.excerpt({
        runId,
        seq: group.firstSeq,
        field: "data.chunk.delta",
      }),
      source_seq_count: group.partialSourceCount,
    },
  };
}

export function groupHasPartialEvidence(group: ChunkGroup): boolean {
  return !group.assembled;
}

function chunkAccumulator(
  credentialValues: readonly string[],
  pathValues: readonly string[],
  redactions: Map<string, number>,
): BoundedTextAccumulator {
  return new BoundedTextAccumulator(PREVIEW_BYTES, TAIL_BYTES, credentialValues, pathValues, redactions);
}

function sortedCounts(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}
