import { HitchError } from "../foundation/index.js";
import { IncrementalRequestAttemptTracker } from "./request-attempt.js";
import { scanCanonicalTrajectory } from "./stream-reader.js";
import type { CanonicalTrajectorySource } from "./stream-reader.js";

export type ChunkDeltaField = "data.chunk.delta" | "data.chunk.text" | "data.chunk.argumentsDelta";

export type ChunkStreamKind = "text" | "reasoning" | "tool_arguments";

export interface ChunkStreamIdentity {
  turn: number;
  step: number;
  attempt: number;
  blockIndex: number;
  blockStartSeq: number;
  streamKind: ChunkStreamKind;
}

export interface ChunkDrillTarget extends ChunkStreamIdentity {
  firstSeq: number;
  field: string;
  deltaField: ChunkDeltaField;
}

export function canonicalChunkDeltaField(field: string | undefined): ChunkDeltaField | undefined {
  const canonical = field?.startsWith("event.") ? field.slice("event.".length) : field;
  return canonical === "data.chunk.delta"
    || canonical === "data.chunk.text"
    || canonical === "data.chunk.argumentsDelta"
    ? canonical
    : undefined;
}

/** Track independently redacted content streams within one request attempt. */
export class IncrementalChunkStreamTracker {
  private readonly openBlocks = new Map<string, ChunkStreamIdentity>();

  accept(event: { seq: number; type: string; data?: unknown }, attempt: number): ChunkStreamIdentity | undefined {
    if (event.type !== "assistant/chunk") return undefined;
    const data = event.data as Record<string, unknown>;
    const chunk = data.chunk as Record<string, unknown>;
    if (!Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step) || !Number.isSafeInteger(chunk.index)) {
      return undefined;
    }
    const key = streamKey(data.turn as number, data.step as number, attempt, chunk.index as number);
    if (chunk.type === "block-start") {
      const streamKind = chunk.blockType === "text" || chunk.blockType === "reasoning"
        ? chunk.blockType
        : chunk.blockType === "tool-call" ? "tool_arguments" : undefined;
      if (!streamKind) return undefined;
      const identity: ChunkStreamIdentity = {
        turn: data.turn as number,
        step: data.step as number,
        attempt,
        blockIndex: chunk.index as number,
        blockStartSeq: event.seq,
        streamKind,
      };
      this.openBlocks.set(key, identity);
      return identity;
    }
    const identity = this.openBlocks.get(key);
    if (chunk.type === "block-end") this.openBlocks.delete(key);
    return identity;
  }
}

/** Locate the selected chunk and its request attempt before projecting any delta text. */
export async function locateChunkDrillTarget(
  source: CanonicalTrajectorySource,
  filter: { types?: string[]; seq_start?: number; field?: string },
  deltaField: ChunkDeltaField,
): Promise<ChunkDrillTarget | undefined> {
  let target: ChunkDrillTarget | undefined;
  const requestAttempts = new IncrementalRequestAttemptTracker();
  const chunkStreams = new IncrementalChunkStreamTracker();
  await scanCanonicalTrajectory(source, (event) => {
    const requestAttempt = requestAttempts.accept(event);
    const data = event.data as Record<string, unknown>;
    const attempt = requestAttempt?.attempt
      ?? (Number.isSafeInteger(data.turn) && Number.isSafeInteger(data.step)
        ? requestAttempts.current(data.turn as number, data.step as number).attempt
        : 0);
    const stream = chunkStreams.accept(event, attempt);
    if (event.seq !== filter.seq_start || (filter.types && !filter.types.includes(event.type))) return;
    if (event.type !== "assistant/chunk" || !Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step)) {
      throw new HitchError(`trajectory event ${event.seq} is not an assistant chunk`, { code: "trajectory_field_not_found", exitCode: 3 });
    }
    if (!stream || !fieldMatchesStream(deltaField, stream.streamKind)) {
      throw new HitchError(`trajectory event ${event.seq} does not identify the requested chunk stream`, {
        code: "trajectory_field_not_found",
        exitCode: 3,
      });
    }
    target = {
      ...stream,
      firstSeq: event.seq,
      field: filter.field as string,
      deltaField,
    };
  });
  return target;
}

export function sameChunkStream(left: ChunkStreamIdentity, right: ChunkStreamIdentity): boolean {
  return left.turn === right.turn && left.step === right.step && left.attempt === right.attempt
    && left.blockIndex === right.blockIndex && left.blockStartSeq === right.blockStartSeq
    && left.streamKind === right.streamKind;
}

function fieldMatchesStream(field: ChunkDeltaField, kind: ChunkStreamKind): boolean {
  if (field === "data.chunk.text") return kind === "text" || kind === "reasoning";
  if (field === "data.chunk.argumentsDelta") return kind === "tool_arguments";
  return true;
}

function streamKey(turn: number, step: number, attempt: number, index: number): string {
  return `${turn}:${step}:${attempt}:${index}`;
}
