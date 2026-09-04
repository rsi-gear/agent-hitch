import type { SessionEvent } from "../domain/index.js";
import { HitchError, sha256JSON } from "../foundation/index.js";
import {
  acceptChunk,
  chunkGroupKey,
  chunkSummary,
  groupHasPartialEvidence,
} from "./chunk-projection.js";
import type { ChunkGroup } from "./chunk-projection.js";
import {
  defaultCredentialValues,
  isPublicEventType,
  mergeRedactionCounts,
  projectBoundedJson,
  redactionEntries,
  sensitivePathValues,
} from "./content-projection.js";
import type { ContentExcerpt, ContentProjectionContext } from "./content-projection.js";
import { canonicalRequestHeader } from "./dsh-contract.js";
import { IncrementalRequestAttemptTracker } from "./request-attempt.js";
import type { RequestAttempt } from "./request-attempt.js";
import { scanCanonicalTrajectory } from "./stream-reader.js";
import type { CanonicalTrajectorySource } from "./stream-reader.js";
import { deriveSurfaceMessage, IncrementalSurfaceFold, isSurfaceEvent } from "./surface-fold.js";

export const DEFAULT_ANALYSIS_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_INLINE_CONTENT_BYTES = 64 * 1024;
const DEFAULT_PREVIEW_BYTES = 12 * 1024;
const DEFAULT_TAIL_BYTES = 4 * 1024;

const KNOWN_EVENT_TYPES = new Set([
  "agent-preset/selected", "agent/inbox/spliced", "approval/asked", "approval/decided", "approval/policy",
  "assistant/chunk", "assistant/message", "command/done", "command/run", "compaction/end", "compaction/prune",
  "compaction/start", "compaction/summary", "feedback/record", "goal/change", "hook/invoked", "hook/result",
  "llm/retry", "llm/retry-started", "permission/preset", "plan/mode", "request/context", "request/header",
  "sandbox/mode", "schedule/change", "session/end-seed", "session/title", "session/title-llm-request", "step/end",
  "step/start", "subagent/descriptor", "todo/write", "tool-workflow/agent-end", "tool-workflow/agent-start",
  "tool-workflow/run-end", "tool-workflow/run-start", "tool/call", "tool/code-dispatch", "tool/code-dispatch-start",
  "tool/result", "turn/end", "turn/start", "user/message", "web/deepseek-search-llm-request",
]);

interface SurfaceNodeV1 {
  seq: number;
  event_type: "user/message" | "assistant/message" | "tool/result";
  surface_op: "append" | { op: "replace"; start: number; end: number };
  message: unknown;
}

interface RequestBoundaryV1 {
  turn: number;
  step: number;
  attempt: number;
  retry_id?: unknown;
  boundary_seq: number;
  surface_revision: number;
  request_header_seq?: number;
}

export interface HitchTrajectoryAnalysisV1 {
  schema_version: "1";
  kind: "trajectory-analysis";
  run_id: string;
  source: {
    fidelity: "provider_native" | "normalized" | "minimal";
    provider?: string;
    session_id: string;
    canonical_sha256: `sha256:${string}`;
    canonical_bytes: number;
    event_count: number;
    event_types: Record<string, number>;
  };
  header: unknown;
  surface: {
    fidelity: "exact" | "normalized" | "partial";
    nodes: SurfaceNodeV1[];
    current_node_seqs: number[];
    replacements: Array<{ seq: number; start: number; end: number; shadowed_seqs: number[] }>;
    request_boundaries: RequestBoundaryV1[];
    request_headers: Array<{ seq: number; header: unknown }>;
  };
  events: unknown[];
  chunk_summaries: unknown[];
  omitted_event_types: Record<string, number>;
  coverage: {
    surface: "complete" | "partial";
    chunks: "coalesced" | "omitted" | "partial";
    content: "complete" | "excerpted" | "partial";
    child_sessions: "complete" | "partial" | "none" | "unavailable";
  };
  redactions?: Array<{ rule_id: string; count: number }>;
}

export interface TrajectoryAnalysisOptions {
  maxBytes?: number;
  credentialValues?: readonly string[];
}

/** Build the bounded trajectory analysis schema v1 surface and diagnostic projection in one scan. */
export async function projectTrajectoryAnalysis(
  source: CanonicalTrajectorySource,
  options: TrajectoryAnalysisOptions = {},
): Promise<HitchTrajectoryAnalysisV1> {
  const maxBytes = options.maxBytes ?? DEFAULT_ANALYSIS_MAX_BYTES;
  assertByteLimit(maxBytes);
  const maxInlineBytes = DEFAULT_INLINE_CONTENT_BYTES;
  const credentialValues = options.credentialValues ?? defaultCredentialValues();
  const pathValues = sensitivePathValues(source.path);
  const redactions = new Map<string, number>();
  if (source.redactions) mergeRedactionCounts(redactions, source.redactions);
  const fold = new IncrementalSurfaceFold();
  const nodes: SurfaceNodeV1[] = [];
  const diagnostics: unknown[] = [];
  const requestHeaders: Array<{ seq: number; header: unknown }> = [];
  const requestBoundaries: RequestBoundaryV1[] = [];
  const boundaryKeys = new Set<string>();
  const chunkGroups = new Map<string, ChunkGroup>();
  const requestAttempts = new IncrementalRequestAttemptTracker();
  const omitted = new Map<string, number>();
  let latestHeader: unknown = null;
  let latestHeaderSeq: number | undefined;

  const contextFor = (seq: number): ContentProjectionContext => ({
    runId: source.runId,
    seq,
    maxInlineBytes,
    previewBytes: Math.min(DEFAULT_PREVIEW_BYTES, maxInlineBytes),
    tailBytes: Math.min(DEFAULT_TAIL_BYTES, Math.floor(maxInlineBytes / 2)),
    credentialValues,
    pathValues,
    redactions,
  });
  const recordBoundary = (event: SessionEvent, turn: number, step: number, requestAttempt: RequestAttempt): void => {
    const key = chunkGroupKey(turn, step, requestAttempt.attempt);
    if (boundaryKeys.has(key)) return;
    boundaryKeys.add(key);
    requestBoundaries.push({
      turn,
      step,
      attempt: requestAttempt.attempt,
      ...(requestAttempt.retryId === undefined ? {} : {
        retry_id: projectBoundedJson(
          requestAttempt.retryId,
          contextFor(requestAttempt.retrySeq ?? event.seq),
          "data.retryId",
        ),
      }),
      boundary_seq: event.seq,
      surface_revision: fold.revision,
      ...(latestHeaderSeq === undefined ? {} : { request_header_seq: latestHeaderSeq }),
    });
  };

  const scan = await scanCanonicalTrajectory(source, (event) => {
    if (!isPublicEventType(event.type, credentialValues, pathValues)) {
      throw new HitchError(`trajectory event ${event.seq} has an unsafe public event type`, {
        code: "trajectory_projection_unsafe_event_type",
        exitCode: 3,
      });
    }
    const step = eventStep(event);
    const requestAttempt = requestAttempts.accept(event);
    if ((event.type === "assistant/message" || event.type === "llm/retry") && step && requestAttempt) {
      recordBoundary(event, step.turn, step.step, requestAttempt);
    }
    try {
      fold.accept(event);
    } catch (error) {
      throw new HitchError(`invalid DSH surface at seq ${event.seq}: ${(error as Error).message}`, {
        code: "trajectory_projection_invalid_surface",
        exitCode: 3,
        cause: error,
      });
    }
    if (!KNOWN_EVENT_TYPES.has(event.type)) {
      if (event.ignorable) {
        increment(omitted, event.type);
        return;
      }
      throw new HitchError(`unsupported required trajectory event ${event.type} at seq ${event.seq}`, {
        code: "trajectory_projection_unsupported_event",
        exitCode: 3,
      });
    }
    if (event.type === "assistant/chunk") {
      const { turn, step, chunk } = chunkData(event);
      const attempt = requestAttempt ?? requestAttempts.current(turn, step);
      recordBoundary(event, turn, step, attempt);
      acceptChunk(
        chunkGroups,
        event,
        turn,
        step,
        attempt.attempt,
        attempt.retryId,
        attempt.retrySeq,
        chunk,
        credentialValues,
        pathValues,
        redactions,
      );
      increment(omitted, event.type);
      return;
    }
    if (isSurfaceEvent(event)) {
      nodes.push({
        seq: event.seq,
        event_type: event.type as SurfaceNodeV1["event_type"],
        surface_op: event.surfaceOp as SurfaceNodeV1["surface_op"],
        message: projectBoundedJson(deriveSurfaceMessage(event), contextFor(event.seq), "message"),
      });
      if (event.type === "assistant/message" && step && requestAttempt) {
        const group = chunkGroups.get(chunkGroupKey(step.turn, step.step, requestAttempt.attempt));
        if (group) group.assembled = true;
      }
    }
    if (event.type === "request/header") {
      const data = event.data as Record<string, unknown>;
      latestHeader = projectBoundedJson(canonicalRequestHeader(data.header), contextFor(event.seq), "header");
      latestHeaderSeq = event.seq;
      requestHeaders.push({ seq: event.seq, header: latestHeader });
    }
    diagnostics.push(projectDiagnosticEvent(event, contextFor(event.seq)));
  });

  const chunkSummaries = [...chunkGroups.values()]
    .sort((left, right) => left.firstSeq - right.firstSeq)
    .map((group) => chunkSummary(group, source.runId, contextFor));
  const hasPartialChunks = [...chunkGroups.values()].some(groupHasPartialEvidence);
  const result: HitchTrajectoryAnalysisV1 = {
    schema_version: "1",
    kind: "trajectory-analysis",
    run_id: source.runId,
    source: {
      fidelity: source.fidelity,
      ...(source.provider === undefined ? {} : { provider: source.provider }),
      session_id: scan.header.id,
      canonical_sha256: scan.sha256,
      canonical_bytes: scan.bytes,
      event_count: scan.eventCount,
      event_types: sortedCounts(scan.eventTypes),
    },
    header: latestHeader,
    surface: {
      fidelity: "exact",
      nodes,
      current_node_seqs: fold.currentNodeSeqs,
      replacements: fold.replacements,
      request_boundaries: requestBoundaries,
      request_headers: requestHeaders,
    },
    events: diagnostics,
    chunk_summaries: chunkSummaries,
    omitted_event_types: sortedCounts(Object.fromEntries(omitted)),
    coverage: {
      surface: "complete",
      chunks: chunkGroups.size === 0 ? "omitted" : hasPartialChunks ? "partial" : "coalesced",
      content: containsExcerpt({ nodes, diagnostics, requestBoundaries, requestHeaders, chunkSummaries })
        ? "excerpted"
        : "complete",
      child_sessions: "unavailable",
    },
    ...(redactions.size === 0 ? {} : { redactions: redactionEntries(redactions) }),
  };
  assertAnalysisBudget(result, maxBytes);
  return result;
}

export function serializeBoundedJson(value: unknown, maxBytes: number, errorCode = "trajectory_projection_overflow"): string {
  assertByteLimit(maxBytes);
  const output = `${JSON.stringify(value)}\n`;
  const bytes = Buffer.byteLength(output);
  if (bytes > maxBytes) {
    throw new HitchError(`${errorCode}: projected JSON requires ${bytes} bytes, exceeding --max-bytes ${maxBytes}; use trajectory events with a narrower filter`, {
      code: errorCode,
      exitCode: 3,
    });
  }
  return output;
}

function assertAnalysisBudget(result: HitchTrajectoryAnalysisV1, maxBytes: number): void {
  try {
    serializeBoundedJson(result, maxBytes, "trajectory_projection_overflow");
  } catch (error) {
    if (!(error instanceof HitchError) || error.code !== "trajectory_projection_overflow") throw error;
    const filter = {};
    const cursor = Buffer.from(JSON.stringify({
      v: 1,
      run_id: result.run_id,
      canonical_sha256: result.source.canonical_sha256,
      filter,
      filter_digest: sha256JSON(filter),
      next_seq: 0,
    }), "utf8").toString("base64url");
    throw new HitchError(`${error.message}; suggested_cursor=${cursor}`, {
      code: "trajectory_projection_overflow",
      exitCode: 3,
      cause: error,
    });
  }
}

function assertByteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("trajectory output byte limit must be a positive safe integer");
}

function chunkData(event: SessionEvent): { turn: number; step: number; chunk: Record<string, unknown> } {
  const data = event.data as Record<string, unknown>;
  if (!isNonNegativeInteger(data.turn) || !isNonNegativeInteger(data.step)
    || !data.chunk || typeof data.chunk !== "object" || Array.isArray(data.chunk)) {
    throw new HitchError(`invalid assistant/chunk data at seq ${event.seq}`, { code: "trajectory_projection_invalid_event", exitCode: 3 });
  }
  return { turn: data.turn, step: data.step, chunk: data.chunk as Record<string, unknown> };
}

function eventStep(event: SessionEvent): { turn: number; step: number } | null {
  const data = event.data as Record<string, unknown>;
  return isNonNegativeInteger(data.turn) && isNonNegativeInteger(data.step) ? { turn: data.turn, step: data.step } : null;
}

function projectDiagnosticEvent(event: SessionEvent, context: ContentProjectionContext): unknown {
  const data = event.data as Record<string, unknown>;
  let projectedData: unknown;
  if (event.type === "request/header") {
    projectedData = { reason: data.reason, request_header_seq: event.seq };
  } else if (event.type === "user/message") {
    projectedData = { surface_node_seq: event.seq };
  } else if (event.type === "assistant/message" || event.type === "tool/result") {
    const { message: _message, ...metadata } = data;
    projectedData = { ...metadata, surface_node_seq: event.seq };
  } else {
    projectedData = data;
  }
  const projected = projectBoundedJson({
    type: event.type,
    seq: event.seq,
    time: event.time,
    data: projectedData,
    ...(event.ignorable ? { ignorable: true } : {}),
    ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
    ...(event.sourceEventSeqs === undefined ? {} : {
      source_event_seqs_summary: {
        count: event.sourceEventSeqs.length,
        ...(event.sourceEventSeqs.length === 0 ? {} : {
          first: event.sourceEventSeqs[0],
          last: event.sourceEventSeqs.at(-1),
        }),
      },
    }),
  }, context, "event");
  return isContentExcerpt(projected)
    ? { type: event.type, seq: event.seq, time: event.time, event_excerpt: projected }
    : projected;
}

function isContentExcerpt(value: unknown): value is ContentExcerpt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.truncated === true && typeof record.bytes === "number" && typeof record.sha256 === "string"
    && record.source !== undefined;
}

function containsExcerpt(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsExcerpt);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.truncated === true && typeof record.bytes === "number" && typeof record.sha256 === "string"
    && record.source && typeof record.source === "object") return true;
  return Object.values(record).some(containsExcerpt);
}

function sortedCounts(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export type { ContentExcerpt };
