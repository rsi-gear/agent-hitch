import type { SessionEvent } from "../domain/index.js";
import { BoundedTextAccumulator, projectBoundedJson } from "./content-projection.js";
import type { ContentProjectionContext } from "./content-projection.js";

const PREVIEW_BYTES = 12 * 1024;
const TAIL_BYTES = 4 * 1024;

export interface ChunkGroup {
  turn: number;
  step: number;
  attempt: number;
  retryId?: string;
  retrySeq?: number;
  firstSeq: number;
  lastSeq: number;
  count: number;
  types: Map<string, number>;
  partialAccumulator: BoundedTextAccumulator;
  partialSourceCount: number;
  usage?: { seq: number; value: unknown };
  finishReason?: { seq: number; value: unknown };
  terminalFailure: boolean;
  assembled: boolean;
}

export function chunkGroupKey(turn: number, step: number, attempt: number): string {
  return `${turn}:${step}:${attempt}`;
}

export function acceptChunk(
  groups: Map<string, ChunkGroup>,
  event: SessionEvent,
  turn: number,
  step: number,
  attempt: number,
  retryId: string | undefined,
  retrySeq: number | undefined,
  chunk: Record<string, unknown>,
  credentialValues: readonly string[],
  pathValues: readonly string[],
  redactions: Map<string, number>,
): void {
  const key = chunkGroupKey(turn, step, attempt);
  let group = groups.get(key);
  if (!group) {
    group = {
      turn,
      step,
      attempt,
      ...(retryId === undefined ? {} : { retryId }),
      ...(retrySeq === undefined ? {} : { retrySeq }),
      firstSeq: event.seq,
      lastSeq: event.seq,
      count: 0,
      types: new Map(),
      partialAccumulator: chunkAccumulator(credentialValues, pathValues, redactions),
      partialSourceCount: 0,
      terminalFailure: false,
      assembled: false,
    };
    groups.set(key, group);
  }
  group.lastSeq = event.seq;
  group.count += 1;
  const type = typeof chunk.type === "string" ? chunk.type : "unknown";
  increment(group.types, type);
  if (type === "usage") group.usage = { seq: event.seq, value: chunk.usage };
  if (type === "finish") {
    group.finishReason = { seq: event.seq, value: chunk.reason };
    group.terminalFailure = isTerminalFailure(chunk.reason);
  }
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
    attempt: group.attempt,
    ...(group.retryId === undefined ? {} : {
      retry_id: projectBoundedJson(
        group.retryId,
        contextFor(group.retrySeq ?? group.firstSeq),
        "data.retryId",
      ),
    }),
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
  if (group.assembled || group.terminalFailure) return base;
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
  return !group.assembled && !group.terminalFailure;
}

function isTerminalFailure(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const kind = (value as Record<string, unknown>).kind;
  return kind === "error" || kind === "aborted";
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
