/**
 * Canonical trajectory store: per-run DSH-compatible persistence root
 * (spec §5.2). One persistence root per run prevents collisions when two
 * providers reuse a native session id while retaining the DSH
 * project/session directory shape.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ensureDir, readJSON } from "../fs.js";
import { eventLine, headerLine, logPath, parseEventLine, parseHeaderLine } from "./format.js";
import { TRAJECTORY_FORMAT } from "./contract.js";
/**
 * Append-only writer for one canonical trajectory. The first logical line is
 * the immutable session header; every following line is one `SessionEvent`
 * JSON object. `seq` starts at 0 and remains contiguous. Writes are
 * serialized through a promise chain so failures surface on `close()`.
 */
export class TrajectoryWriter {
    target;
    stream;
    pending = Promise.resolve();
    nextSeq = 0;
    closed = false;
    streamError;
    constructor(target, stream) {
        this.target = target;
        this.stream = stream;
        stream.on("error", (error) => { this.streamError ||= error; });
    }
    static async open(options) {
        const target = trajectoryLogPath(options.runDirectory, options.cwd, options.sessionId);
        await ensureDir(path.dirname(target));
        const writer = new TrajectoryWriter(target, createWriteStream(target, { flags: "ax", mode: 0o600 }));
        await writer.enqueue(headerLine(options.header));
        return writer;
    }
    get path() {
        return this.target;
    }
    /** Append one event; `seq` must continue the log. */
    append(event) {
        if (this.closed)
            throw new Error("trajectory writer is closed");
        if (event.seq !== this.nextSeq) {
            throw new Error(`trajectory seq must be contiguous: expected ${this.nextSeq}, got ${event.seq}`);
        }
        this.nextSeq += 1;
        this.enqueue(eventLine(event));
    }
    enqueue(line) {
        const operation = this.pending.then(() => new Promise((resolve, reject) => {
            this.stream.write(line, (error) => error ? reject(error) : resolve());
        }));
        this.pending = operation.catch(() => { });
        return operation;
    }
    async flush() {
        await this.pending;
    }
    /** Close the writer; resolves with the canonical trajectory path. */
    async close() {
        if (this.closed) {
            await this.pending;
            return this.target;
        }
        this.closed = true;
        let failure;
        try {
            await this.pending;
        }
        catch (error) {
            failure = error;
        }
        try {
            await closeStream(this.stream);
        }
        catch (error) {
            failure ||= error;
        }
        failure ||= this.streamError;
        if (failure)
            throw failure;
        return this.target;
    }
}
function closeStream(stream) {
    return new Promise((resolve, reject) => {
        stream.once("error", reject);
        stream.end(resolve);
    });
}
/** The `trajectory/--<normalized-cwd>--/<encoded-session-id>/session.jsonl` path under a run directory. */
export function trajectoryLogPath(runDirectory, cwd, sessionId) {
    return logPath(path.join(runDirectory, "trajectory"), cwd, sessionId);
}
export function trajectoryRefPath(runDirectory) {
    return path.join(runDirectory, "trajectory.ref.json");
}
export function trajectoryRef(runId, sessionId, fidelity, trajectoryPath, sha256, providerSessionId) {
    const ref = {
        schema_version: "1",
        run_id: runId,
        session_id: sessionId,
        format: TRAJECTORY_FORMAT,
        fidelity,
        path: trajectoryPath,
        sha256: sha256,
    };
    if (providerSessionId !== undefined)
        ref.provider_session_id = providerSessionId;
    return ref;
}
/**
 * Read and validate a canonical trajectory. Validates header identity, the
 * declared file set, contiguous sequence numbers, and relational invariants.
 */
export async function readTrajectory(file) {
    const content = await readFile(file, "utf8");
    const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const lines = content.split(/\r?\n/);
    const nonEmpty = lines.filter((line) => line.length > 0);
    if (nonEmpty.length === 0)
        throw new Error(`trajectory is empty: ${file}`);
    const header = parseHeaderLine(JSON.parse(nonEmpty[0]));
    const events = [];
    for (let i = 1; i < nonEmpty.length; i += 1) {
        const parsed = parseEventLine(JSON.parse(nonEmpty[i]));
        if (parsed.seq !== i - 1) {
            throw new Error(`trajectory seq must be contiguous: expected ${i - 1}, got ${parsed.seq}`);
        }
        events.push(parsed);
    }
    validateTrajectoryInvariants(header, events);
    return { header, events, sha256 };
}
/** Validate the required relational invariants of a canonical trajectory (spec §5.4). */
export function validateTrajectoryInvariants(header, events) {
    const knownTypes = new Set([
        "turn/start", "turn/end", "step/start", "step/end",
        "user/message", "assistant/chunk", "assistant/message",
        "tool/call", "tool/result",
    ]);
    let turnOpen = false;
    let stepOpen = false;
    let openTurn = null;
    let openStep = null;
    const openCalls = new Set();
    let seq = 0;
    for (const event of events) {
        if (event.seq !== seq)
            throw new Error(`trajectory seq must be contiguous: expected ${seq}, got ${event.seq}`);
        seq += 1;
        const data = (event.data || {});
        switch (event.type) {
            case "turn/start": {
                if (turnOpen)
                    throw new Error(`nested turn/start at seq ${event.seq}`);
                turnOpen = true;
                openTurn = data.turn;
                break;
            }
            case "turn/end": {
                if (!turnOpen)
                    throw new Error(`turn/end without turn/start at seq ${event.seq}`);
                if (stepOpen)
                    throw new Error(`turn/end with open step at seq ${event.seq}`);
                turnOpen = false;
                openTurn = null;
                break;
            }
            case "step/start": {
                if (!turnOpen)
                    throw new Error(`step/start outside a turn at seq ${event.seq}`);
                if (stepOpen)
                    throw new Error(`nested step/start at seq ${event.seq}`);
                stepOpen = true;
                openStep = { turn: data.turn, step: data.step };
                break;
            }
            case "step/end": {
                if (!stepOpen)
                    throw new Error(`step/end without step/start at seq ${event.seq}`);
                if (openCalls.size > 0)
                    throw new Error(`step/end with open tool calls at seq ${event.seq}`);
                stepOpen = false;
                openStep = null;
                break;
            }
            case "tool/call": {
                if (!stepOpen)
                    throw new Error(`tool/call outside a step at seq ${event.seq}`);
                const callId = data.callId;
                if (openCalls.has(callId))
                    throw new Error(`duplicate tool call ${callId} at seq ${event.seq}`);
                openCalls.add(callId);
                break;
            }
            case "tool/result": {
                const message = (data.message || {});
                const source = (message.source || {});
                const content = Array.isArray(message.content) ? message.content : [];
                const callId = (source.callId ?? content[0]?.toolCallId);
                if (!callId || !openCalls.has(callId)) {
                    throw new Error(`tool/result without a matching open tool call at seq ${event.seq}`);
                }
                openCalls.delete(callId);
                break;
            }
            default:
                if (!knownTypes.has(event.type) && !event.ignorable) {
                    throw new Error(`unknown required event type ${event.type} at seq ${event.seq}`);
                }
        }
    }
    if (turnOpen)
        throw new Error("trajectory ends with an open turn");
    if (stepOpen)
        throw new Error("trajectory ends with an open step");
    if (openCalls.size > 0)
        throw new Error("trajectory ends with open tool calls");
    if (openTurn !== null)
        throw new Error("trajectory ends with an open turn bracket");
    if (openStep !== null)
        throw new Error("trajectory ends with an open step bracket");
}
/** Locate the canonical trajectory for a run from its `trajectory.ref.json`. */
export async function loadTrajectoryRef(runDirectory) {
    const ref = await readJSON(trajectoryRefPath(runDirectory), null);
    if (!ref || ref.schema_version !== "1")
        return null;
    return ref;
}
export async function removeTrajectory(runDirectory) {
    await rm(path.join(runDirectory, "trajectory"), { recursive: true, force: true });
}
/** Compute the SHA-256 digest of an existing trajectory file. */
export async function trajectoryFileSha256(file) {
    const content = await readFile(file, "utf8");
    return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
export async function listTrajectorySessions(runDirectory) {
    const root = path.join(runDirectory, "trajectory");
    let projects;
    try {
        projects = await readdir(root, { withFileTypes: true });
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return [];
        throw error;
    }
    const sessions = [];
    for (const project of projects) {
        if (!project.isDirectory())
            continue;
        let entries;
        try {
            entries = await readdir(path.join(root, project.name), { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const candidate = path.join(root, project.name, entry.name, "session.jsonl");
            try {
                await stat(candidate);
                sessions.push(candidate);
            }
            catch {
                // Not a session directory.
            }
        }
    }
    return sessions.sort();
}
export { TRAJECTORY_FORMAT };
//# sourceMappingURL=store.js.map