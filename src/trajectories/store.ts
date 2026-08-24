/**
 * Canonical trajectory store: per-run DSH-compatible persistence root
 * (spec §5.2). One persistence root per run prevents collisions when two
 * providers reuse a native session id while retaining the DSH
 * project/session directory shape.
 */

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ensureDir, readJSON } from "../foundation/index.js";
import { eventLine, headerLine, logPath, parseEventLine, parseHeaderLine } from "./format.js";
import { TRAJECTORY_FORMAT } from "./contract.js";
import type {
  SessionEvent,
  SessionHeaderLine,
  TrajectoryFidelity,
  TrajectoryFileRefV1,
  TrajectoryRef,
  TrajectoryRefV1,
  TrajectoryRefV2,
} from "../domain/index.js";
import { validateTrajectoryRef } from "../domain/index.js";

export interface TrajectoryWriterOptions {
  runDirectory: string;
  cwd: string | undefined;
  sessionId: string;
  fidelity: TrajectoryFidelity;
  header: SessionHeaderLine;
}

/**
 * Append-only writer for one canonical trajectory. The first logical line is
 * the immutable session header; every following line is one `SessionEvent`
 * JSON object. `seq` starts at 0 and remains contiguous. Writes are
 * serialized through a promise chain so failures surface on `close()`.
 */
export class TrajectoryWriter {
  private readonly target: string;
  private readonly stream: WriteStream;
  private pending: Promise<void> = Promise.resolve();
  private nextSeq = 0;
  private closed = false;
  private streamError: Error | undefined;

  private constructor(target: string, stream: WriteStream) {
    this.target = target;
    this.stream = stream;
    stream.on("error", (error: Error) => { this.streamError ||= error; });
  }

  static async open(options: TrajectoryWriterOptions): Promise<TrajectoryWriter> {
    const target = trajectoryLogPath(options.runDirectory, options.cwd, options.sessionId);
    await ensureDir(path.dirname(target));
    const writer = new TrajectoryWriter(target, createWriteStream(target, { flags: "ax", mode: 0o600 }));
    await writer.enqueue(headerLine(options.header));
    return writer;
  }

  get path(): string {
    return this.target;
  }

  /** Append one event; `seq` must continue the log. */
  append(event: SessionEvent): void {
    if (this.closed) throw new Error("trajectory writer is closed");
    if (event.seq !== this.nextSeq) {
      throw new Error(`trajectory seq must be contiguous: expected ${this.nextSeq}, got ${event.seq}`);
    }
    this.nextSeq += 1;
    this.enqueue(eventLine(event));
  }

  private enqueue(line: string): Promise<void> {
    const operation = this.pending.then(
      () => new Promise<void>((resolve, reject) => {
        this.stream.write(line, (error) => error ? reject(error) : resolve());
      }),
    );
    this.pending = operation.catch(() => {});
    return operation;
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  /** Close the writer; resolves with the canonical trajectory path. */
  async close(): Promise<string> {
    if (this.closed) {
      await this.pending;
      return this.target;
    }
    this.closed = true;
    let failure: Error | undefined;
    try { await this.pending; } catch (error) { failure = error as Error; }
    try { await closeStream(this.stream); } catch (error) { failure ||= error as Error; }
    failure ||= this.streamError;
    if (failure) throw failure;
    return this.target;
  }
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

/** The `trajectory/--<normalized-cwd>--/<encoded-session-id>/session.jsonl` path under a run directory. */
export function trajectoryLogPath(runDirectory: string, cwd: string | undefined, sessionId: string): string {
  return logPath(path.join(runDirectory, "trajectory", "canonical"), cwd, sessionId);
}

export function trajectoryRefPath(runDirectory: string): string {
  return path.join(runDirectory, "trajectory.ref.json");
}

export function trajectoryRef(
  runId: string,
  sessionId: string,
  fidelity: TrajectoryFidelity,
  trajectoryPath: string,
  sha256: string,
  providerSessionId?: string,
): TrajectoryRefV1 {
  const ref: TrajectoryRefV1 = {
    schema_version: "1",
    run_id: runId,
    session_id: sessionId,
    format: TRAJECTORY_FORMAT,
    fidelity,
    path: trajectoryPath,
    sha256: sha256 as `sha256:${string}`,
  };
  if (providerSessionId !== undefined) ref.provider_session_id = providerSessionId;
  return ref;
}

export async function canonicalTrajectoryFileRef(runDirectory: string, trajectoryPath: string): Promise<TrajectoryFileRefV1> {
  const relative = path.relative(runDirectory, trajectoryPath).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error("canonical trajectory must be inside its run directory");
  }
  const info = await stat(trajectoryPath);
  return {
    role: "canonical_session",
    path: relative,
    media_type: "application/x-ndjson",
    sha256: await trajectoryFileSha256(trajectoryPath) as `sha256:${string}`,
    bytes: info.size,
  };
}

export function trajectoryRefV2(options: {
  runId: string;
  fidelity: "provider_native" | "normalized" | "minimal";
  provider?: string;
  providerSessionId?: string;
  files: TrajectoryFileRefV1[];
  redactions?: Array<{ rule_id: string; count: number }>;
}): TrajectoryRefV2 {
  const ref: TrajectoryRefV2 = {
    schema_version: "2",
    run_id: options.runId,
    fidelity: options.fidelity,
    files: options.files,
  };
  if (options.provider) ref.provider = options.provider;
  if (options.providerSessionId) ref.provider_session_id = options.providerSessionId;
  if (options.redactions?.length) ref.redactions = options.redactions;
  return validateTrajectoryRef(ref) as TrajectoryRefV2;
}

export interface TrajectoryReadResult {
  header: SessionHeaderLine;
  events: SessionEvent[];
  sha256: string;
}

/**
 * Read and validate a canonical trajectory. Validates header identity, the
 * declared file set, contiguous sequence numbers, and relational invariants.
 */
export async function readTrajectory(file: string): Promise<TrajectoryReadResult> {
  const content = await readFile(file, "utf8");
  const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const lines = content.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.length > 0);
  if (nonEmpty.length === 0) throw new Error(`trajectory is empty: ${file}`);
  const header = parseHeaderLine(JSON.parse(nonEmpty[0] as string) as unknown);
  const events: SessionEvent[] = [];
  for (let i = 1; i < nonEmpty.length; i += 1) {
    const parsed = parseEventLine(JSON.parse(nonEmpty[i] as string) as unknown);
    if (parsed.seq !== i - 1) {
      throw new Error(`trajectory seq must be contiguous: expected ${i - 1}, got ${parsed.seq}`);
    }
    events.push(parsed);
  }
  validateTrajectoryInvariants(header, events);
  return { header, events, sha256 };
}

/** Validate the required relational invariants of a canonical trajectory (spec §5.4). */
export function validateTrajectoryInvariants(header: SessionHeaderLine, events: SessionEvent[]): void {
  const knownTypes = new Set([
    "turn/start", "turn/end", "step/start", "step/end",
    "request/header", "user/message", "assistant/chunk", "assistant/message",
    "tool/call", "tool/result",
  ]);
  let turnOpen = false;
  let stepOpen = false;
  let openTurn: number | null = null;
  let openStep: { turn: number; step: number } | null = null;
  const openCalls = new Set<string>();
  let seq = 0;
  for (const event of events) {
    if (event.seq !== seq) throw new Error(`trajectory seq must be contiguous: expected ${seq}, got ${event.seq}`);
    seq += 1;
    const data = (event.data || {}) as Record<string, unknown>;
    switch (event.type) {
      case "turn/start": {
        if (turnOpen) throw new Error(`nested turn/start at seq ${event.seq}`);
        turnOpen = true;
        openTurn = data.turn as number;
        break;
      }
      case "turn/end": {
        if (!turnOpen) throw new Error(`turn/end without turn/start at seq ${event.seq}`);
        if (stepOpen) throw new Error(`turn/end with open step at seq ${event.seq}`);
        turnOpen = false;
        openTurn = null;
        break;
      }
      case "step/start": {
        if (!turnOpen) throw new Error(`step/start outside a turn at seq ${event.seq}`);
        if (stepOpen) throw new Error(`nested step/start at seq ${event.seq}`);
        stepOpen = true;
        openStep = { turn: data.turn as number, step: data.step as number };
        break;
      }
      case "step/end": {
        if (!stepOpen) throw new Error(`step/end without step/start at seq ${event.seq}`);
        if (openCalls.size > 0) throw new Error(`step/end with open tool calls at seq ${event.seq}`);
        stepOpen = false;
        openStep = null;
        break;
      }
      case "tool/call": {
        if (!stepOpen) throw new Error(`tool/call outside a step at seq ${event.seq}`);
        const callId = data.callId as string;
        if (openCalls.has(callId)) throw new Error(`duplicate tool call ${callId} at seq ${event.seq}`);
        openCalls.add(callId);
        break;
      }
      case "tool/result": {
        const message = (data.message || {}) as Record<string, unknown>;
        const source = (message.source || {}) as Record<string, unknown>;
        const content = Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [];
        const callId = (source.callId ?? content[0]?.toolCallId) as string | undefined;
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
  if (turnOpen) throw new Error("trajectory ends with an open turn");
  if (stepOpen) throw new Error("trajectory ends with an open step");
  if (openCalls.size > 0) throw new Error("trajectory ends with open tool calls");
  if (openTurn !== null) throw new Error("trajectory ends with an open turn bracket");
  if (openStep !== null) throw new Error("trajectory ends with an open step bracket");
}

/**
 * Seal the structurally valid prefix left by an interrupted native provider.
 * Provider rows remain untouched; Hitch only appends canonical recovery
 * events for calls whose outcome is unknown and for open step/turn brackets.
 */
export function finalizeInterruptedTrajectory(
  header: SessionHeaderLine,
  events: SessionEvent[],
  status: "failed" | "cancelled" | "timed_out",
): SessionEvent[] {
  const finalized = [...events];
  let openTurn: number | null = null;
  let openStep: { turn: number; step: number } | null = null;
  const openCalls = new Map<string, { name: string }>();

  for (const event of finalized) {
    const data = (event.data || {}) as Record<string, unknown>;
    switch (event.type) {
      case "turn/start":
        openTurn = data.turn as number;
        break;
      case "turn/end":
        openTurn = null;
        break;
      case "step/start":
        openStep = { turn: data.turn as number, step: data.step as number };
        break;
      case "step/end":
        openStep = null;
        break;
      case "tool/call": {
        const callId = data.callId as string;
        openCalls.set(callId, { name: typeof data.name === "string" ? data.name : "unknown" });
        break;
      }
      case "tool/result": {
        const message = (data.message || {}) as Record<string, unknown>;
        const source = (message.source || {}) as Record<string, unknown>;
        const content = Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [];
        const callId = (source.callId ?? content[0]?.toolCallId) as string | undefined;
        if (callId) openCalls.delete(callId);
        break;
      }
    }
  }

  let nextTime = Math.max(Date.now(), (finalized.at(-1)?.time ?? 0) + 1);
  const append = (event: Omit<SessionEvent, "seq" | "time">): void => {
    finalized.push({ ...event, seq: finalized.length, time: nextTime });
    nextTime += 1;
  };

  if (finalized.length === 0) {
    openTurn = 1;
    append({ type: "turn/start", data: { turn: openTurn } });
  }

  for (const [callId, call] of openCalls) {
    if (!openStep) break;
    append({
      type: "tool/result",
      data: {
        turn: openStep.turn,
        step: openStep.step,
        message: {
          id: randomUUID(),
          role: "user",
          content: [{
            type: "tool-result",
            toolCallId: callId,
            content: [{ type: "text", text: `tool call interrupted: ${call.name} outcome unknown` }],
            isError: true,
          }],
          source: { kind: "tool", callId },
        },
        error: { name: call.name, code: "TOOL_OUTCOME_UNKNOWN" },
      },
      surfaceOp: "append",
    });
  }
  if (openStep) append({ type: "step/end", data: { turn: openStep.turn, step: openStep.step } });
  if (openTurn !== null) {
    append({ type: "turn/end", data: { turn: openTurn, reason: interruptedTerminalReason(status) } });
  }

  validateTrajectoryInvariants(header, finalized);
  return finalized;
}

function interruptedTerminalReason(status: "failed" | "cancelled" | "timed_out"): Record<string, unknown> {
  if (status === "timed_out") return { kind: "aborted", reason: { kind: "hook", reason: "timeout" } };
  if (status === "cancelled") return { kind: "aborted", reason: { kind: "user" } };
  return { kind: "error", error: { message: "agent process failed", code: "UNKNOWN" } };
}

/** Locate the canonical trajectory for a run from its `trajectory.ref.json`. */
export type LoadedTrajectoryRef = TrajectoryRef & {
  /** Resolved canonical path, added in memory for V1 consumer compatibility. */
  path: string;
  session_id: string;
  sha256?: `sha256:${string}`;
};

export async function loadTrajectoryRef(runDirectory: string): Promise<LoadedTrajectoryRef | null> {
  const raw = await readJSON<unknown | null>(trajectoryRefPath(runDirectory), null);
  if (!raw) return null;
  const ref = validateTrajectoryRef(raw);
  if (ref.schema_version === "1") return ref as LoadedTrajectoryRef;
  const canonical = ref.files.find((file) => file.role === "canonical_session");
  if (!canonical) return null;
  const absolute = path.resolve(runDirectory, ...canonical.path.split("/"));
  const relative = path.relative(path.resolve(runDirectory), absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`trajectory path escapes run directory: ${canonical.path}`);
  }
  const content = await readFile(absolute, "utf8");
  const first = content.split(/\r?\n/).find((line) => line.length > 0);
  if (!first) throw new Error(`canonical trajectory is empty: ${canonical.path}`);
  const header = parseHeaderLine(JSON.parse(first) as unknown);
  return {
    ...ref,
    path: absolute,
    session_id: header.id,
    sha256: canonical.sha256,
  };
}

export async function removeTrajectory(runDirectory: string): Promise<void> {
  await rm(path.join(runDirectory, "trajectory"), { recursive: true, force: true });
}

/** Compute the SHA-256 digest of an existing trajectory file. */
export async function trajectoryFileSha256(file: string): Promise<string> {
  const content = await readFile(file, "utf8");
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export async function listTrajectorySessions(runDirectory: string): Promise<string[]> {
  const canonicalRoot = path.join(runDirectory, "trajectory", "canonical");
  const root = await stat(canonicalRoot).then(() => canonicalRoot).catch(() => path.join(runDirectory, "trajectory"));
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const sessions: string[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let entries;
    try {
      entries = await readdir(path.join(root, project.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, project.name, entry.name, "session.jsonl");
      try {
        await stat(candidate);
        sessions.push(candidate);
      } catch {
        // Not a session directory.
      }
    }
  }
  return sessions.sort();
}

export { TRAJECTORY_FORMAT };
