import { HitchError } from "../foundation/index.js";
import { IncrementalRequestAttemptTracker } from "./request-attempt.js";
import { scanCanonicalTrajectory } from "./stream-reader.js";
import type { CanonicalTrajectorySource } from "./stream-reader.js";

export type ChunkDeltaField = "data.chunk.delta" | "data.chunk.text" | "data.chunk.argumentsDelta";

export interface ChunkDrillTarget {
  turn: number;
  step: number;
  attempt: number;
  firstSeq: number;
  field: string;
  deltaField: ChunkDeltaField;
  callIdentity?: string;
}

export function canonicalChunkDeltaField(field: string | undefined): ChunkDeltaField | undefined {
  const canonical = field?.startsWith("event.") ? field.slice("event.".length) : field;
  return canonical === "data.chunk.delta"
    || canonical === "data.chunk.text"
    || canonical === "data.chunk.argumentsDelta"
    ? canonical
    : undefined;
}

export function toolCallIdentity(chunk: Record<string, unknown>): string {
  if (typeof chunk.id === "string" && chunk.id.length > 0) return chunk.id;
  return Number.isSafeInteger(chunk.index) ? `index:${String(chunk.index)}` : "unknown";
}

/** Locate the selected chunk and its request attempt before projecting any delta text. */
export async function locateChunkDrillTarget(
  source: CanonicalTrajectorySource,
  filter: { types?: string[]; seq_start?: number; field?: string },
  deltaField: ChunkDeltaField,
): Promise<ChunkDrillTarget | undefined> {
  let target: ChunkDrillTarget | undefined;
  const requestAttempts = new IncrementalRequestAttemptTracker();
  await scanCanonicalTrajectory(source, (event) => {
    const requestAttempt = requestAttempts.accept(event);
    if (event.seq !== filter.seq_start || (filter.types && !filter.types.includes(event.type))) return;
    const data = event.data as Record<string, unknown>;
    if (event.type !== "assistant/chunk" || !Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step)) {
      throw new HitchError(`trajectory event ${event.seq} is not an assistant chunk`, { code: "trajectory_field_not_found", exitCode: 3 });
    }
    target = {
      turn: data.turn as number,
      step: data.step as number,
      attempt: requestAttempt?.attempt ?? requestAttempts.current(data.turn as number, data.step as number).attempt,
      firstSeq: event.seq,
      field: filter.field as string,
      deltaField,
      ...(deltaField === "data.chunk.argumentsDelta"
        ? { callIdentity: toolCallIdentity(data.chunk as Record<string, unknown>) }
        : {}),
    };
  });
  return target;
}
