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
import { atomicWriteJSON, ensureDir, readJSON } from "../fs.js";
import { validateMessageFeedbackRow } from "../domain/validate.js";
import { loadTrajectoryRef, readTrajectory } from "../trajectories/store.js";
import { decodeSegment, encodeSegment, sessionDir } from "../trajectories/format.js";
import { readFile, readdir } from "node:fs/promises";
export class MessageFeedbackError extends Error {
    code;
    current;
    maxBytes;
    actualBytes;
    constructor(code, message, extra = {}) {
        super(message);
        this.name = "MessageFeedbackError";
        this.code = code;
        if (extra.current !== undefined)
            this.current = extra.current;
        if (extra.maxBytes !== undefined)
            this.maxBytes = extra.maxBytes;
        if (extra.actualBytes !== undefined)
            this.actualBytes = extra.actualBytes;
    }
}
export const DEFAULT_MAX_NOTE_BYTES = 8192;
/**
 * The sidecar service. The session identity must be supplied by the caller
 * (Hitch run records know `createdAt`/`cwd`); a row whose stored identity
 * differs is treated as absent.
 */
export class MessageFeedbackService {
    root;
    maxNoteBytes;
    validateTarget;
    queues = new Map();
    constructor({ root, maxNoteBytes = DEFAULT_MAX_NOTE_BYTES, validateTarget }) {
        this.root = root;
        this.maxNoteBytes = maxNoteBytes;
        this.validateTarget = validateTarget;
    }
    rowPath(sessionId) {
        return path.join(this.root, "feedback", "message-feedback.json");
    }
    serialize(sessionId, operation) {
        const previous = this.queues.get(sessionId) || Promise.resolve();
        const next = previous.then(operation, operation);
        this.queues.set(sessionId, next.catch(() => { }));
        return next;
    }
    async list(request, identity) {
        return this.serialize(request.sessionId, async () => {
            const row = await this.readRow(request.sessionId, identity);
            return row ? [...row.items] : [];
        });
    }
    async put(request, identity, target) {
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
                if (existing)
                    throw versionConflict(existing);
                const created = {
                    messageId: target.messageId,
                    rating: request.rating,
                    version: randomUUID(),
                    createdAt: now,
                    updatedAt: now,
                };
                if (request.note !== undefined)
                    created.note = request.note;
                const nextRow = row
                    ? { ...row, items: [...row.items, created] }
                    : { session: identitySession(identity), items: [created] };
                await this.writeRow(request.sessionId, nextRow);
                return created;
            }
            if (!existing)
                throw versionConflict(null);
            if (existing.version !== request.ifVersion)
                throw versionConflict(existing);
            const desiredNote = request.note;
            const unchanged = existing.rating === request.rating
                && existing.note === desiredNote
                && existing.version === request.ifVersion;
            if (unchanged)
                return existing;
            const updated = {
                messageId: existing.messageId,
                rating: request.rating,
                version: randomUUID(),
                createdAt: existing.createdAt,
                updatedAt: Math.max(now, existing.updatedAt),
            };
            if (desiredNote !== undefined)
                updated.note = desiredNote;
            const items = [...(row?.items || [])];
            items[existingIndex] = updated;
            const nextRow = {
                session: row?.session || identitySession(identity),
                items,
            };
            await this.writeRow(request.sessionId, nextRow);
            return updated;
        });
    }
    async delete(request, identity) {
        return this.serialize(request.sessionId, async () => {
            const row = await this.readRow(request.sessionId, identity);
            if (!row)
                return { absent: true };
            const existingIndex = row.items.findIndex((item) => item.messageId === request.messageId);
            if (existingIndex < 0)
                return { absent: true };
            const existing = row.items[existingIndex];
            if (existing && request.ifVersion !== null && existing.version !== request.ifVersion) {
                throw versionConflict(existing);
            }
            const items = row.items.filter((item) => item.messageId !== request.messageId);
            await this.writeRow(request.sessionId, { ...row, items });
            return { absent: true };
        });
    }
    async readRow(sessionId, identity) {
        const raw = await readJSON(this.rowPath(sessionId), null);
        if (raw === null)
            return null;
        let row;
        try {
            row = validateMessageFeedbackRow(raw);
        }
        catch {
            throw new MessageFeedbackError("session-not-found", "feedback row is corrupt");
        }
        if (!sameIdentity(row.session, identity))
            return null;
        return row;
    }
    async writeRow(sessionId, row) {
        const file = this.rowPath(sessionId);
        await ensureDir(path.dirname(file));
        await atomicWriteJSON(file, row);
    }
}
function identitySession(identity) {
    const session = { createdAt: identity.createdAt };
    if (identity.cwd !== undefined)
        session.cwd = identity.cwd;
    return session;
}
function sameIdentity(stored, expected) {
    if (stored.createdAt !== expected.createdAt)
        return false;
    if ((stored.cwd ?? undefined) !== (expected.cwd ?? undefined))
        return false;
    return true;
}
function validateNote(note, maxNoteBytes) {
    if (note === undefined)
        return;
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
function versionConflict(current) {
    return new MessageFeedbackError("version-conflict", "message feedback version conflict", { current });
}
/**
 * Resolve a run directory's canonical trajectory for feedback targeting.
 * Returns `null` when the run has no trajectory ref (legacy event-log runs
 * are not feedback targets).
 */
export async function resolveFeedbackSession(runDirectory) {
    const ref = await loadTrajectoryRef(runDirectory);
    if (!ref)
        return null;
    const header = await readTrajectoryHeader(ref.path);
    if (!header)
        return null;
    return {
        sessionId: ref.session_id,
        createdAt: header.createdAt,
        ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    };
}
async function readTrajectoryHeader(file) {
    try {
        const content = await readFile(file, "utf8");
        const first = content.split(/\r?\n/).find((line) => line.length > 0);
        if (!first)
            return null;
        const parsed = JSON.parse(first);
        if (typeof parsed.createdAt !== "number")
            return null;
        const result = { createdAt: parsed.createdAt };
        if (typeof parsed.cwd === "string")
            result.cwd = parsed.cwd;
        return result;
    }
    catch {
        return null;
    }
}
/**
 * Validate that a messageId targets a non-empty, append-origin
 * `assistant/message` in the run's canonical trajectory (spec §6.2).
 */
export async function trajectoryTargetValidator(runDirectory) {
    return async (_sessionId, messageId) => {
        const ref = await loadTrajectoryRef(runDirectory);
        if (!ref)
            return false;
        try {
            const { events } = await readTrajectory(ref.path);
            return events.some((event) => {
                if (event.type !== "assistant/message" || event.surfaceOp !== "append")
                    return false;
                const data = (event.data || {});
                const message = (data.message || {});
                if (message.id !== messageId)
                    return false;
                const content = Array.isArray(message.content) ? message.content : [];
                const text = content.find((block) => block.type === "text")?.text;
                return typeof text === "string" && text.length > 0;
            });
        }
        catch {
            return false;
        }
    };
}
/**
 * Locate the canonical trajectory session.jsonl path for a session id under a
 * run directory, scanning encoded session directories (used by the feedback
 * CLI when only the session id is known).
 */
export async function findTrajectorySessionFile(runDirectory, sessionId) {
    const ref = await loadTrajectoryRef(runDirectory);
    if (ref)
        return ref.path;
    const root = path.join(runDirectory, "trajectory");
    let projects;
    try {
        projects = await readdir(root, { withFileTypes: true });
    }
    catch {
        return null;
    }
    const encoded = encodeSegment(sessionId);
    for (const project of projects) {
        if (!project.isDirectory())
            continue;
        const candidate = path.join(root, project.name, encoded, "session.jsonl");
        try {
            const content = await readFile(candidate, "utf8");
            const first = content.split(/\r?\n/).find((line) => line.length > 0);
            if (!first)
                continue;
            const parsed = JSON.parse(first);
            if (parsed.id === sessionId || decodeSegment(encoded) === sessionId)
                return candidate;
        }
        catch {
            // Not this project.
        }
    }
    return null;
}
export { sameIdentity, sessionDir };
//# sourceMappingURL=service.js.map