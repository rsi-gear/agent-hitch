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
  emptyPartialAccumulator: BoundedTextAccumulator;
  partialStreams: ChunkPartialStream[];
  openPartialStreams: Map<number, ChunkPartialStream>;
  usage?: { seq: number; value: unknown };
  finishReason?: { seq: number; value: unknown };
  terminalFailure: boolean;
  assembled: boolean;
}

interface ChunkPartialStream {
  blockIndex: number;
  blockStartSeq: number;
  kind: "text" | "reasoning" | "tool_arguments";
  accumulator: BoundedTextAccumulator;
  sourceCount: number;
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
      emptyPartialAccumulator: chunkAccumulator(credentialValues, pathValues, redactions),
      partialStreams: [],
      openPartialStreams: new Map(),
      terminalFailure: false,
      assembled: false,
    };
    groups.set(key, group);
  }
  group.lastSeq = event.seq;
  group.count += 1;
  const type = typeof chunk.type === "string" ? chunk.type : "unknown";
  increment(group.types, type);
  if (type === "block-start") {
    const kind = partialStreamKind(chunk.blockType);
    if (kind && Number.isSafeInteger(chunk.index)) {
      const stream: ChunkPartialStream = {
        blockIndex: chunk.index as number,
        blockStartSeq: event.seq,
        kind,
        accumulator: chunkAccumulator(credentialValues, pathValues, redactions),
        sourceCount: 0,
      };
      group.partialStreams.push(stream);
      group.openPartialStreams.set(stream.blockIndex, stream);
    }
  }
  if (type === "usage") group.usage = { seq: event.seq, value: chunk.usage };
  if (type === "finish") {
    group.finishReason = { seq: event.seq, value: chunk.reason };
    group.terminalFailure = isTerminalFailure(chunk.reason);
  }
  if (typeof chunk.text === "string") {
    const stream = group.openPartialStreams.get(chunk.index as number);
    stream?.accumulator.append(chunk.text);
    if (stream) stream.sourceCount += 1;
  }
  if (type === "tool-call-delta" && typeof chunk.argumentsDelta === "string") {
    const stream = group.openPartialStreams.get(chunk.index as number);
    stream?.accumulator.append(chunk.argumentsDelta);
    if (stream) stream.sourceCount += 1;
  }
  if (type === "block-end" && Number.isSafeInteger(chunk.index)) group.openPartialStreams.delete(chunk.index as number);
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
    partial: partialEvidence(group, runId),
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

function partialEvidence(group: ChunkGroup, runId: string): unknown {
  const sourceCount = group.partialStreams.reduce((total, stream) => total + stream.sourceCount, 0);
  if (group.partialStreams.length <= 1) {
    const stream = group.partialStreams[0];
    return {
      status: "incomplete",
      content: (stream?.accumulator ?? group.emptyPartialAccumulator).excerpt({
        runId,
        seq: stream?.blockStartSeq ?? group.firstSeq,
        field: "data.chunk.delta",
      }),
      source_seq_count: sourceCount,
    };
  }
  return {
    status: "incomplete",
    streams: group.partialStreams.map((stream) => ({
      block_index: stream.blockIndex,
      block_start_seq: stream.blockStartSeq,
      kind: stream.kind,
      content: stream.accumulator.excerpt({
        runId,
        seq: stream.blockStartSeq,
        field: "data.chunk.delta",
      }),
      source_seq_count: stream.sourceCount,
    })),
    source_seq_count: sourceCount,
  };
}

function partialStreamKind(value: unknown): ChunkPartialStream["kind"] | undefined {
  if (value === "text" || value === "reasoning") return value;
  return value === "tool-call" ? "tool_arguments" : undefined;
}

function sortedCounts(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}
