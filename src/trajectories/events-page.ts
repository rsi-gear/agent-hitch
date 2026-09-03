import type { SessionEvent } from "../domain/index.js";
import { HitchError, sha256JSON } from "../foundation/index.js";
import { DEFAULT_INLINE_CONTENT_BYTES, serializeBoundedJson } from "./analysis.js";
import {
  BoundedTextAccumulator,
  defaultCredentialValues,
  fieldSegmentForKey,
  isPublicEventType,
  isSensitiveFieldName,
  mergeRedactionCounts,
  projectBoundedJson,
  redactionEntries,
  serializedJsonExcerpt,
  sensitivePathValues,
} from "./content-projection.js";
import type { ContentProjectionContext } from "./content-projection.js";
import { canonicalRequestHeader } from "./dsh-contract.js";
import { scanCanonicalTrajectory } from "./stream-reader.js";
import type { CanonicalTrajectorySource } from "./stream-reader.js";

export const DEFAULT_EVENTS_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_EVENTS_LIMIT = 100;
export const MAX_EVENTS_LIMIT = 1_000;
export const MAX_INLINE_EVENT_BYTES = 256 * 1024;

export interface TrajectoryEventsFilter {
  types?: string[];
  seq_start?: number;
  seq_end?: number;
  field?: string;
}

export interface TrajectoryEventsPageOptions {
  filter?: TrajectoryEventsFilter;
  cursor?: string;
  limit?: number;
  maxBytes?: number;
  credentialValues?: readonly string[];
  canonicalSha256?: `sha256:${string}`;
}

export interface HitchTrajectoryEventsPageV1 {
  schema_version: "1";
  kind: "trajectory-events-page";
  run_id: string;
  canonical_sha256: `sha256:${string}`;
  filter: TrajectoryEventsFilter;
  events: unknown[];
  total_matches: number;
  next_cursor?: string;
  eof: boolean;
  redactions?: Array<{ rule_id: string; count: number }>;
}

interface CursorPayloadV1 {
  v: 1;
  run_id: string;
  canonical_sha256: `sha256:${string}`;
  filter: TrajectoryEventsFilter;
  filter_digest: `sha256:${string}`;
  next_seq: number;
}

/** Source-filtered raw event page. The scan verifies the complete canonical digest. */
export async function pageTrajectoryEvents(
  source: CanonicalTrajectorySource,
  options: TrajectoryEventsPageOptions = {},
): Promise<HitchTrajectoryEventsPageV1> {
  const maxBytes = options.maxBytes ?? DEFAULT_EVENTS_MAX_BYTES;
  const limit = options.limit ?? DEFAULT_EVENTS_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENTS_LIMIT) {
    throw new HitchError(`trajectory events --limit must be between 1 and ${MAX_EVENTS_LIMIT}`, { code: "invalid_input", exitCode: 2 });
  }
  const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  if (cursor && cursor.run_id !== source.runId) throw invalidCursor("cursor belongs to another run");
  if (cursor && source.expectedSha256 !== undefined && cursor.canonical_sha256 !== source.expectedSha256) {
    throw invalidCursor("cursor belongs to another canonical trajectory digest");
  }
  const explicitFilter = options.filter === undefined ? undefined : normalizeFilter(options.filter);
  const filter = explicitFilter ?? cursor?.filter ?? {};
  const filterDigest = sha256JSON(filter);
  if (cursor && cursor.filter_digest !== filterDigest) throw invalidCursor("cursor filter does not match this request");
  const pageStart = cursor?.next_seq ?? filter.seq_start ?? 0;
  const requestedDigest = options.canonicalSha256 ?? cursor?.canonical_sha256;
  if (filter.field !== undefined && requestedDigest === undefined) {
    throw new HitchError("trajectory events --field requires --canonical-sha256 or a bound cursor", { code: "invalid_input", exitCode: 2 });
  }
  if (requestedDigest !== undefined && source.expectedSha256 !== undefined && requestedDigest !== source.expectedSha256) {
    throw invalidCursor("requested canonical digest does not match the trajectory ref");
  }
  const credentialValues = options.credentialValues ?? defaultCredentialValues();
  const pathValues = sensitivePathValues(source.path);
  const redactions = new Map<string, number>();
  if (source.redactions) mergeRedactionCounts(redactions, source.redactions);
  if (filter.types?.some((type) => !isPublicEventType(type, credentialValues, pathValues))) {
    throw new HitchError("trajectory events --types contains an unsafe public event type", { code: "invalid_input", exitCode: 2 });
  }
  const events: unknown[] = [];
  let chunkDrill: {
    turn: number;
    step: number;
    firstSeq: number;
    field: "data.chunk.delta" | "data.chunk.text" | "data.chunk.argumentsDelta";
    callIdentity?: string;
    accumulator: BoundedTextAccumulator;
    sourceCount: number;
  } | undefined;
  let totalMatches = 0;
  let hasMore = false;
  let lastSelectedSeq: number | undefined;
  const perEventBytes = filter.field === undefined
    ? Math.min(MAX_INLINE_EVENT_BYTES, Math.max(1_024, Math.floor(maxBytes / (limit + 4))))
    : Math.min(MAX_INLINE_EVENT_BYTES, Math.max(1_024, maxBytes - 4 * 1024));
  const chunkDeltaDrill = filter.field === "data.chunk.delta"
    || filter.field === "data.chunk.text"
    || filter.field === "data.chunk.argumentsDelta";

  const scan = await scanCanonicalTrajectory(source, (event) => {
    if (!isPublicEventType(event.type, credentialValues, pathValues)) {
      throw new HitchError(`trajectory event ${event.seq} has an unsafe public event type`, {
        code: "trajectory_projection_unsafe_event_type",
        exitCode: 3,
      });
    }
    if (chunkDeltaDrill) {
      if (!chunkDrill && event.seq === filter.seq_start && (!filter.types || filter.types.includes(event.type))) {
        const data = event.data as Record<string, unknown>;
        if (event.type !== "assistant/chunk" || !Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step)) {
          throw new HitchError(`trajectory event ${event.seq} is not an assistant chunk`, { code: "trajectory_field_not_found", exitCode: 3 });
        }
        chunkDrill = {
          turn: data.turn as number,
          step: data.step as number,
          firstSeq: event.seq,
          field: filter.field as "data.chunk.delta" | "data.chunk.text" | "data.chunk.argumentsDelta",
          ...(filter.field === "data.chunk.argumentsDelta"
            ? { callIdentity: toolCallIdentity(data.chunk as Record<string, unknown>) }
            : {}),
          accumulator: new BoundedTextAccumulator(
            Math.floor(perEventBytes / 3),
            Math.floor(perEventBytes / 6),
            credentialValues,
            pathValues,
            redactions,
          ),
          sourceCount: 0,
        };
      }
      if (chunkDrill && event.type === "assistant/chunk") {
        const data = event.data as Record<string, unknown>;
        if (data.turn === chunkDrill.turn && data.step === chunkDrill.step) {
          const chunk = data.chunk as Record<string, unknown>;
          let accepted = false;
          if ((chunkDrill.field === "data.chunk.delta" || chunkDrill.field === "data.chunk.text")
            && typeof chunk.text === "string") {
            chunkDrill.accumulator.append(chunk.text);
            accepted = true;
          }
          if ((chunkDrill.field === "data.chunk.delta"
            || (chunkDrill.field === "data.chunk.argumentsDelta"
              && toolCallIdentity(chunk) === chunkDrill.callIdentity))
            && typeof chunk.argumentsDelta === "string") {
            chunkDrill.accumulator.append(chunk.argumentsDelta);
            accepted = true;
          }
          if (accepted) chunkDrill.sourceCount += 1;
        }
      }
      return;
    }
    if (!matchesFilter(event, filter)) return;
    totalMatches += 1;
    if (event.seq < pageStart) return;
    if (events.length >= limit) {
      hasMore = true;
      return;
    }
    events.push(projectRawEvent(event, source.runId, perEventBytes, credentialValues, pathValues, redactions, filter.field));
    lastSelectedSeq = event.seq;
  });
  if (chunkDrill) {
    totalMatches = 1;
    lastSelectedSeq = chunkDrill.firstSeq;
    events.push({
      type: "assistant/chunk-group",
      seq: chunkDrill.firstSeq,
      field: chunkDrill.field,
      value: chunkDrill.accumulator.excerpt({
        runId: source.runId,
        seq: chunkDrill.firstSeq,
        field: chunkDrill.field,
      }),
      source_seq_count: chunkDrill.sourceCount,
    });
  }
  if (cursor && cursor.canonical_sha256 !== scan.sha256) throw invalidCursor("cursor canonical digest no longer matches the source");
  if (requestedDigest !== undefined && requestedDigest !== scan.sha256) throw invalidCursor("requested canonical digest no longer matches the source");
  const result: HitchTrajectoryEventsPageV1 = {
    schema_version: "1",
    kind: "trajectory-events-page",
    run_id: source.runId,
    canonical_sha256: scan.sha256,
    filter,
    events,
    total_matches: totalMatches,
    ...(hasMore && lastSelectedSeq !== undefined ? {
      next_cursor: encodeCursor({
        v: 1,
        run_id: source.runId,
        canonical_sha256: scan.sha256,
        filter,
        filter_digest: filterDigest,
        next_seq: lastSelectedSeq + 1,
      }),
    } : {}),
    eof: !hasMore,
    ...(redactions.size === 0 ? {} : { redactions: redactionEntries(redactions) }),
  };
  serializeBoundedJson(result, maxBytes, "trajectory_events_page_overflow");
  return result;
}

function toolCallIdentity(chunk: Record<string, unknown>): string {
  if (typeof chunk.id === "string" && chunk.id.length > 0) return chunk.id;
  return Number.isSafeInteger(chunk.index) ? `index:${String(chunk.index)}` : "unknown";
}

function projectRawEvent(
  event: SessionEvent,
  runId: string,
  perEventBytes: number,
  credentialValues: readonly string[],
  pathValues: readonly string[],
  redactions: Map<string, number>,
  field?: string,
): unknown {
  const baseContext: ContentProjectionContext = {
    runId,
    seq: event.seq,
    maxInlineBytes: field === undefined ? perEventBytes : DEFAULT_INLINE_CONTENT_BYTES,
    previewBytes: field === undefined ? Math.floor(perEventBytes / 3) : 12 * 1024,
    tailBytes: field === undefined ? Math.floor(perEventBytes / 6) : 4 * 1024,
    credentialValues,
    pathValues,
    redactions,
  };
  const selected = field === undefined || field === "event"
    ? event
    : readEventField(event, field, credentialValues, pathValues);
  const projected = projectBoundedJson(selected, baseContext, field ?? "event");
  if ((field === undefined || field === "event") && isContentExcerpt(projected)) {
    return { type: event.type, seq: event.seq, time: event.time, event_excerpt: projected };
  }
  const wrapped = field === undefined || field === "event" ? projected : {
    type: event.type,
    seq: event.seq,
    time: event.time,
    field,
    value: projected,
  };
  const evidence = serializedJsonExcerpt(wrapped, {
    run_id: runId,
    seq: event.seq,
    field: field ?? "event",
  }, Math.floor(perEventBytes / 3), Math.floor(perEventBytes / 6));
  if (evidence.bytes <= perEventBytes) return wrapped;
  return {
    type: event.type,
    seq: event.seq,
    time: event.time,
    event_excerpt: evidence,
  };
}

function isContentExcerpt(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.truncated === true && typeof record.bytes === "number" && typeof record.sha256 === "string"
    && record.source !== undefined;
}

function matchesFilter(event: SessionEvent, filter: TrajectoryEventsFilter): boolean {
  if (filter.types && !filter.types.includes(event.type)) return false;
  if (filter.seq_start !== undefined && event.seq < filter.seq_start) return false;
  if (filter.seq_end !== undefined && event.seq > filter.seq_end) return false;
  return true;
}

function normalizeFilter(filter: TrajectoryEventsFilter): TrajectoryEventsFilter {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)
    || Object.keys(filter).some((key) => !["types", "seq_start", "seq_end", "field"].includes(key))) {
    throw new HitchError("trajectory events filter is invalid", { code: "invalid_input", exitCode: 2 });
  }
  if (filter.types !== undefined && (!Array.isArray(filter.types) || filter.types.some((entry) => typeof entry !== "string"))) {
    throw new HitchError("trajectory events --types must be a list of event types", { code: "invalid_input", exitCode: 2 });
  }
  const types = filter.types === undefined
    ? undefined
    : [...new Set(filter.types.filter((entry) => entry.length > 0))].sort();
  if (types?.length === 0) throw new HitchError("trajectory events --types must include at least one event type", { code: "invalid_input", exitCode: 2 });
  if (types?.some((type) => type.length > 1_024)) {
    throw new HitchError("trajectory events --types contains an event type longer than 1024 characters", { code: "invalid_input", exitCode: 2 });
  }
  for (const [name, value] of [["--seq-start", filter.seq_start], ["--seq-end", filter.seq_end]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new HitchError(`trajectory events ${name} must be a non-negative safe integer`, { code: "invalid_input", exitCode: 2 });
    }
  }
  if (filter.seq_start !== undefined && filter.seq_end !== undefined && filter.seq_start > filter.seq_end) {
    throw new HitchError("trajectory events --seq-start must not exceed --seq-end", { code: "invalid_input", exitCode: 2 });
  }
  if (filter.field !== undefined) {
    const fieldSegment = String.raw`(?:[A-Za-z0-9_-]+|\[field:[a-f0-9]{12}\])`;
    const fieldPath = new RegExp(`^${fieldSegment}(?:\\.${fieldSegment})*$`);
    if (typeof filter.field !== "string" || filter.field.length === 0 || filter.field.length > 1_024
      || !fieldPath.test(filter.field)) {
      throw new HitchError("trajectory events --field must be a dot-separated JSON field path", { code: "invalid_input", exitCode: 2 });
    }
    if (filter.field.split(".").some((segment) => !segment.startsWith("[field:") && isSensitiveFieldName(segment))) {
      throw new HitchError("trajectory events --field cannot select a sensitive field", { code: "invalid_input", exitCode: 2 });
    }
    if (filter.seq_start === undefined || filter.seq_start !== filter.seq_end) {
      throw new HitchError("trajectory events --field requires one exact --seq-start/--seq-end", { code: "invalid_input", exitCode: 2 });
    }
  }
  return {
    ...(types === undefined ? {} : { types }),
    ...(filter.seq_start === undefined ? {} : { seq_start: filter.seq_start }),
    ...(filter.seq_end === undefined ? {} : { seq_end: filter.seq_end }),
    ...(filter.field === undefined ? {} : { field: filter.field }),
  };
}

function encodeCursor(cursor: CursorPayloadV1): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): CursorPayloadV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch (error) {
    throw invalidCursor(`cursor is not valid base64url JSON: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalidCursor("cursor payload is invalid");
  const cursor = raw as Record<string, unknown>;
  const keys = Object.keys(cursor).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["canonical_sha256", "filter", "filter_digest", "next_seq", "run_id", "v"])) {
    throw invalidCursor("cursor payload fields are invalid");
  }
  if (cursor.v !== 1 || typeof cursor.run_id !== "string" || !/^run_[a-f0-9]{32}$/.test(cursor.run_id)
    || typeof cursor.canonical_sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(cursor.canonical_sha256)
    || typeof cursor.filter_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(cursor.filter_digest)
    || !Number.isSafeInteger(cursor.next_seq) || (cursor.next_seq as number) < 0
    || !cursor.filter || typeof cursor.filter !== "object" || Array.isArray(cursor.filter)) {
    throw invalidCursor("cursor payload is invalid");
  }
  const filterRecord = cursor.filter as Record<string, unknown>;
  if (Object.keys(filterRecord).some((key) => !["types", "seq_start", "seq_end", "field"].includes(key))) {
    throw invalidCursor("cursor filter fields are invalid");
  }
  let filter: TrajectoryEventsFilter;
  try {
    filter = normalizeFilter(filterRecord as TrajectoryEventsFilter);
  } catch (error) {
    throw invalidCursor(`cursor filter is invalid: ${(error as Error).message}`);
  }
  const normalized: CursorPayloadV1 = {
    v: 1,
    run_id: cursor.run_id,
    canonical_sha256: cursor.canonical_sha256 as `sha256:${string}`,
    filter,
    filter_digest: cursor.filter_digest as `sha256:${string}`,
    next_seq: cursor.next_seq as number,
  };
  if (normalized.filter_digest !== sha256JSON(normalized.filter)) throw invalidCursor("cursor filter digest is invalid");
  return normalized;
}

function readEventField(
  event: SessionEvent,
  field: string,
  credentialValues: readonly string[],
  pathValues: readonly string[],
): unknown {
  const segments = field.split(".");
  let value: unknown;
  if (segments[0] === "message") {
    value = event.type === "user/message"
      ? event.data
      : (event.data as Record<string, unknown>).message;
    segments.shift();
  } else if (segments[0] === "header") {
    if (event.type !== "request/header") {
      throw new HitchError(`trajectory event ${event.seq} has no requested field`, { code: "trajectory_field_not_found", exitCode: 3 });
    }
    value = canonicalRequestHeader((event.data as Record<string, unknown>).header);
    segments.shift();
  } else {
    value = event;
    if (segments[0] === "event") segments.shift();
  }
  for (const segment of segments) {
    if (!value || typeof value !== "object") {
      throw new HitchError(`trajectory event ${event.seq} has no requested field`, { code: "trajectory_field_not_found", exitCode: 3 });
    }
    const target = value as Record<string, unknown>;
    const key = Object.hasOwn(target, segment)
      ? segment
      : resolveEncodedField(target, segment, credentialValues, pathValues);
    if (key === null) {
      throw new HitchError(`trajectory event ${event.seq} has no requested field`, { code: "trajectory_field_not_found", exitCode: 3 });
    }
    value = target[key];
  }
  return value;
}

function resolveEncodedField(
  value: Record<string, unknown>,
  segment: string,
  credentialValues: readonly string[],
  pathValues: readonly string[],
): string | null {
  if (!/^\[field:[a-f0-9]{12}\]$/.test(segment)) return null;
  const matches = Object.keys(value).filter((key) => fieldSegmentForKey(key, credentialValues, pathValues) === segment);
  return matches.length === 1 ? matches[0] as string : null;
}

function invalidCursor(message: string): HitchError {
  return new HitchError(`invalid trajectory cursor: ${message}`, { code: "invalid_trajectory_cursor", exitCode: 2 });
}
