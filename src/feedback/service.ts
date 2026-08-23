/**
 * DSH-compatible message feedback sidecar (spec §6).
 *
 * One whole-session row bound to `{ sessionId, createdAt, cwd }`, stored as an
 * atomic whole-row replacement. A lifecycle identity mismatch is treated as
 * absence, preventing a reused session id from inheriting stale feedback.
 * Forked sessions do not inherit feedback. Compare-and-set uses opaque opaque
 * UUID versions; `ifVersion: null` requests creation only.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { atomicWriteJSON, ensureDir, readJSON } from "../foundation/index.js";
import { validateMessageFeedbackRow } from "../domain/index.js";
import type { MessageFeedbackItem, MessageFeedbackRating, MessageFeedbackRow } from "../domain/index.js";
import { decodeSegment, encodeSegment, loadTrajectoryRef, readTrajectory, sessionDir } from "../trajectories/index.js";
import { readFile, readdir } from "node:fs/promises";

export type MessageFeedbackFailureCode =
  | "session-not-found"
  | "target-not-found"
  | "version-conflict"
  | "note-blank"
  | "note-too-large";

export class MessageFeedbackError extends Error {
  readonly code: MessageFeedbackFailureCode;
  readonly current?: MessageFeedbackItem | null;
  readonly maxBytes?: number;
  readonly actualBytes?: number;

  constructor(code: MessageFeedbackFailureCode, message: string, extra: Partial<Pick<MessageFeedbackError, "current" | "maxBytes" | "actualBytes">> = {}) {
    super(message);
    this.name = "MessageFeedbackError";
    this.code = code;
    if (extra.current !== undefined) this.current = extra.current;
    if (extra.maxBytes !== undefined) this.maxBytes = extra.maxBytes;
    if (extra.actualBytes !== undefined) this.actualBytes = extra.actualBytes;
  }
}

/**
 * Infrastructure error for sidecar storage corruption or I/O failures. Unlike
 * the business failure variants, this is not a `MessageFeedbackError` and must
 * not be reported as one (spec §6.3).
 */
export class FeedbackStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackStorageError";
  }
}

export const DEFAULT_MAX_NOTE_BYTES = 8192;

/** Lifecycle identity of one session, bound to the feedback row. */
export interface FeedbackSessionIdentity {
  sessionId: string;
  createdAt: number;
  cwd?: string;
}

export interface FeedbackTarget {
  messageId: string;
}

export interface MessageFeedbackServiceOptions {
  root: string;
  maxNoteBytes?: number;
  /** Validates that a messageId targets a valid append-origin assistant message in the trajectory. */
  validateTarget?: (sessionId: string, messageId: string) => Promise<boolean>;
}

export interface MessageFeedbackListRequest {
  sessionId: string;
}

export interface MessageFeedbackPutRequest {
  sessionId: string;
  messageId: string;
  rating: MessageFeedbackRating;
  note?: string;
  ifVersion: string | null;
}

export interface MessageFeedbackDeleteRequest {
  sessionId: string;
  messageId: string;
  ifVersion: string | null;
}

/**
 * The sidecar service. The session identity must be supplied by the caller
 * (Hitch run records know `createdAt`/`cwd`); a row whose stored identity
 * differs is treated as absent.
 */
export class MessageFeedbackService {
  private readonly root: string;
  private readonly maxNoteBytes: number;
  private readonly validateTarget: ((sessionId: string, messageId: string) => Promise<boolean>) | undefined;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor({ root, maxNoteBytes = DEFAULT_MAX_NOTE_BYTES, validateTarget }: MessageFeedbackServiceOptions) {
    this.root = root;
    this.maxNoteBytes = maxNoteBytes;
    this.validateTarget = validateTarget;
  }

  private rowPath(sessionId: string): string {
    return path.join(this.root, "feedback", "message-feedback.json");
  }

  private serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) || Promise.resolve();
    const next = previous.then(operation, operation);
    this.queues.set(sessionId, next.catch(() => {}));
    return next;
  }

  async list(request: MessageFeedbackListRequest, identity: FeedbackSessionIdentity): Promise<MessageFeedbackItem[]> {
    return this.serialize(request.sessionId, async () => {
      const row = await this.readRow(request.sessionId, identity);
      return row ? [...row.items] : [];
    });
  }

  async put(
    request: MessageFeedbackPutRequest,
    identity: FeedbackSessionIdentity,
    target: FeedbackTarget,
  ): Promise<MessageFeedbackItem> {
    validateNote(request.note, this.maxNoteBytes);
    return this.serialize(request.sessionId, async () => {
      if (this.validateTarget && !await this.validateTarget(request.sessionId, target.messageId)) {
        throw new MessageFeedbackError("target-not-found", "no append-origin assistant message matches the requested messageId");
      }
      const row = await this.readRow(request.sessionId, identity);
      const now = Date.now();
      const existingIndex = row ? row.items.findIndex((item) => item.messageId === target.messageId) : -1;
      const existing = existingIndex >= 0 && row ? row.items[existingIndex] : undefined;

      if (request.ifVersion === null) {
        if (existing) throw versionConflict(existing);
        const created: MessageFeedbackItem = {
          messageId: target.messageId,
          rating: request.rating,
          version: randomUUID(),
          createdAt: now,
          updatedAt: now,
        };
        if (request.note !== undefined) created.note = request.note;
        const nextRow = row
          ? { ...row, items: [...row.items, created] }
          : { session: identitySession(identity), items: [created] };
        await this.writeRow(request.sessionId, nextRow);
        return created;
      }

      if (!existing) throw versionConflict(null);
      if (existing.version !== request.ifVersion) throw versionConflict(existing);

      const desiredNote = request.note;
      const unchanged = existing.rating === request.rating
        && existing.note === desiredNote
        && existing.version === request.ifVersion;
      if (unchanged) return existing;

      const updated: MessageFeedbackItem = {
        messageId: existing.messageId,
        rating: request.rating,
        version: randomUUID(),
        createdAt: existing.createdAt,
        updatedAt: Math.max(now, existing.updatedAt),
      };
      if (desiredNote !== undefined) updated.note = desiredNote;
      const items = [...(row?.items || [])];
      items[existingIndex] = updated;
      const nextRow: MessageFeedbackRow = {
        session: row?.session || identitySession(identity),
        items,
      };
      await this.writeRow(request.sessionId, nextRow);
      return updated;
    });
  }

  async delete(
    request: MessageFeedbackDeleteRequest,
    identity: FeedbackSessionIdentity,
  ): Promise<{ absent: true }> {
    return this.serialize(request.sessionId, async () => {
      const row = await this.readRow(request.sessionId, identity);
      if (!row) return { absent: true };
      const existingIndex = row.items.findIndex((item) => item.messageId === request.messageId);
      if (existingIndex < 0) return { absent: true };
      const existing = row.items[existingIndex];
      // Delete ignores the supplied version only when the item is already
      // absent; an existing item requires its exact current version even when
      // `ifVersion` is null (spec §6.2). A null ifVersion therefore cannot
      // delete an existing item.
      if (existing && existing.version !== request.ifVersion) {
        throw versionConflict(existing);
      }
      const items = row.items.filter((item) => item.messageId !== request.messageId);
      await this.writeRow(request.sessionId, { ...row, items });
      return { absent: true };
    });
  }

  private async readRow(sessionId: string, identity: FeedbackSessionIdentity): Promise<MessageFeedbackRow | null> {
    const raw = await readJSON<unknown>(this.rowPath(sessionId), null);
    if (raw === null) return null;
    let row: MessageFeedbackRow;
    try {
      row = validateMessageFeedbackRow(raw);
    } catch {
      // Storage corruption and I/O failures are infrastructure errors, not
      // business failure variants (spec §6.3): a corrupt row must never be
      // misreported as session-not-found.
      throw new FeedbackStorageError("message feedback sidecar is corrupt");
    }
    if (!sameIdentity(row.session, identity)) return null;
    return row;
  }

  private async writeRow(sessionId: string, row: MessageFeedbackRow): Promise<void> {
    const file = this.rowPath(sessionId);
    await ensureDir(path.dirname(file));
    await atomicWriteJSON(file, row);
  }
}

function identitySession(identity: FeedbackSessionIdentity): { sessionId: string; createdAt: number; cwd?: string } {
  const session: { sessionId: string; createdAt: number; cwd?: string } = {
    sessionId: identity.sessionId,
    createdAt: identity.createdAt,
  };
  if (identity.cwd !== undefined) session.cwd = identity.cwd;
  return session;
}

function sameIdentity(stored: { sessionId?: string; createdAt: number; cwd?: string }, expected: FeedbackSessionIdentity): boolean {
  if (stored.sessionId !== undefined && stored.sessionId !== expected.sessionId) return false;
  if (stored.createdAt !== expected.createdAt) return false;
  if ((stored.cwd ?? undefined) !== (expected.cwd ?? undefined)) return false;
  return true;
}

function validateNote(note: string | undefined, maxNoteBytes: number): void {
  if (note === undefined) return;
  if (!/\S/.test(note)) {
    throw new MessageFeedbackError("note-blank", "note must contain a non-whitespace character");
  }
  const bytes = Buffer.byteLength(note, "utf8");
  if (bytes > maxNoteBytes) {
    throw new MessageFeedbackError("note-too-large", `note exceeds ${maxNoteBytes} UTF-8 bytes`, {
      maxBytes: maxNoteBytes,
      actualBytes: bytes,
    });
  }
}

function versionConflict(current: MessageFeedbackItem | null): MessageFeedbackError {
  return new MessageFeedbackError("version-conflict", "message feedback version conflict", { current });
}

/**
 * Resolve a run directory's canonical trajectory for feedback targeting.
 * Returns `null` when the run has no trajectory ref (legacy event-log runs
 * are not feedback targets).
 */
export async function resolveFeedbackSession(runDirectory: string): Promise<FeedbackSessionIdentity | null> {
  const ref = await loadTrajectoryRef(runDirectory);
  if (!ref) return null;
  const header = await readTrajectoryHeader(ref.path);
  if (!header) return null;
  return {
    sessionId: ref.session_id,
    createdAt: header.createdAt,
    ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
  };
}

async function readTrajectoryHeader(file: string): Promise<{ createdAt: number; cwd?: string } | null> {
  try {
    const content = await readFile(file, "utf8");
    const first = content.split(/\r?\n/).find((line) => line.length > 0);
    if (!first) return null;
    const parsed = JSON.parse(first) as { createdAt?: unknown; cwd?: unknown };
    if (typeof parsed.createdAt !== "number") return null;
    const result: { createdAt: number; cwd?: string } = { createdAt: parsed.createdAt };
    if (typeof parsed.cwd === "string") result.cwd = parsed.cwd;
    return result;
  } catch {
    return null;
  }
}

/**
 * Validate that a messageId targets a non-empty, append-origin
 * `assistant/message` in the run's canonical trajectory (spec §6.2).
 */
export async function trajectoryTargetValidator(
  runDirectory: string,
): Promise<(sessionId: string, messageId: string) => Promise<boolean>> {
  return async (_sessionId: string, messageId: string) => {
    const ref = await loadTrajectoryRef(runDirectory);
    if (!ref) return false;
    try {
      const { events } = await readTrajectory(ref.path);
      return events.some((event) => {
        if (event.type !== "assistant/message" || event.surfaceOp !== "append") return false;
        const data = (event.data || {}) as Record<string, unknown>;
        const message = (data.message || {}) as Record<string, unknown>;
        if (message.id !== messageId) return false;
        const content = Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [];
        const text = content.find((block) => block.type === "text")?.text;
        return typeof text === "string" && text.length > 0;
      });
    } catch {
      return false;
    }
  };
}

/**
 * Locate the canonical trajectory session.jsonl path for a session id under a
 * run directory, scanning encoded session directories (used by the feedback
 * CLI when only the session id is known).
 */
export async function findTrajectorySessionFile(runDirectory: string, sessionId: string): Promise<string | null> {
  const ref = await loadTrajectoryRef(runDirectory);
  if (ref) return ref.path;
  const root = path.join(runDirectory, "trajectory");
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const encoded = encodeSegment(sessionId);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const candidate = path.join(root, project.name, encoded, "session.jsonl");
    try {
      const content = await readFile(candidate, "utf8");
      const first = content.split(/\r?\n/).find((line) => line.length > 0);
      if (!first) continue;
      const parsed = JSON.parse(first) as { id?: unknown };
      if (parsed.id === sessionId || decodeSegment(encoded) === sessionId) return candidate;
    } catch {
      // Not this project.
    }
  }
  return null;
}

export { sameIdentity, sessionDir };
