/**
 * Runtime validators for external JSON, provider events, CLI input, and
 * process output. Values enter as `unknown` and are narrowed here before any
 * domain code touches them (spec §8.2).
 *
 * Pure functions only — no CLI, daemon, backend, or filesystem imports.
 */

import type {
  ControllerRuntimeManifest,
  MessageFeedbackItem,
  MessageFeedbackRow,
  SessionEvent,
  SessionHeaderLine,
  TrajectoryRef,
} from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown, label = "value"): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a JSON object`);
  return value;
}

export function asString(value: unknown, label = "value"): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

export function asOptionalString(value: unknown, label = "value"): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, label);
}

export function asNumber(value: unknown, label = "value"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
  return value;
}

export function asInteger(value: unknown, label = "value"): number {
  const number = asNumber(value, label);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${label} must be a safe integer`);
  return number;
}

export function asBoolean(value: unknown, label = "value"): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

export function asArray(value: unknown, label = "value"): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

/** Non-negative safe-integer Unix epoch milliseconds. */
export function asEpochMillis(value: unknown, label = "value"): number {
  const number = asInteger(value, label);
  if (number < 0) throw new TypeError(`${label} must be a non-negative epoch millisecond value`);
  return number;
}

export function validateSessionHeaderLine(value: unknown): SessionHeaderLine {
  const record = asRecord(value, "session header line");
  if (record.type !== "session") throw new TypeError("session header line must have type 'session'");
  const version = asInteger(record.version, "session header version");
  if (version !== 0) throw new TypeError(`unsupported session format version: ${version}`);
  const id = asString(record.id, "session id");
  const createdAt = asEpochMillis(record.createdAt, "session createdAt");
  const delegationDepth = asInteger(record.delegationDepth, "delegationDepth");
  if (delegationDepth < 0) throw new TypeError("delegationDepth must be non-negative");
  const header: SessionHeaderLine = {
    type: "session",
    version,
    id,
    createdAt,
    delegationDepth,
  };
  const cwd = asOptionalString(record.cwd, "session cwd");
  if (cwd !== undefined) header.cwd = cwd;
  const parentSession = asOptionalString(record.parentSession, "parentSession");
  if (parentSession !== undefined) header.parentSession = parentSession;
  const seedLength = record.seedLength === undefined ? undefined : asInteger(record.seedLength, "seedLength");
  if (seedLength !== undefined) header.seedLength = seedLength;
  if (record.origin !== undefined) {
    if (record.origin !== "subagent") throw new TypeError("origin must be 'subagent'");
    header.origin = "subagent";
  }
  const agentPreset = asOptionalString(record.agentPreset, "agentPreset");
  if (agentPreset !== undefined) header.agentPreset = agentPreset;
  return header;
}

export function validateSessionEvent(value: unknown): SessionEvent {
  const record = asRecord(value, "session event");
  const type = asString(record.type, "event type");
  const seq = asInteger(record.seq, "event seq");
  if (seq < 0) throw new TypeError("event seq must be non-negative");
  const time = asEpochMillis(record.time, "event time");
  if (!("data" in record) || !isRecord(record.data)) {
    throw new TypeError("event data must be a JSON object");
  }
  const event: SessionEvent = { type, seq, time, data: record.data };
  if (record.ignorable === true) event.ignorable = true;
  if (record.sourceEventSeqs !== undefined) {
    event.sourceEventSeqs = asArray(record.sourceEventSeqs, "sourceEventSeqs").map((item) => asInteger(item, "sourceEventSeq"));
  }
  if (record.surfaceOp !== undefined) {
    if (record.surfaceOp === "append") {
      event.surfaceOp = "append";
    } else {
      const op = asRecord(record.surfaceOp, "surfaceOp");
      if (op.op !== "replace") throw new TypeError("surfaceOp must be 'append' or { op: 'replace' }");
      event.surfaceOp = { op: "replace", start: asInteger(op.start, "surfaceOp.start"), end: asInteger(op.end, "surfaceOp.end") };
    }
  }
  return event;
}

export function validateTrajectoryRef(value: unknown): TrajectoryRef {
  const record = asRecord(value, "trajectory ref");
  if (record.schema_version !== "1") throw new TypeError("trajectory ref schema_version must be '1'");
  const format = asRecord(record.format, "trajectory format");
  if (format.family !== "dsh-session") throw new TypeError("trajectory format family must be 'dsh-session'");
  if (format.version !== 0) throw new TypeError("trajectory format version must be 0");
  if (format.compression !== "none") throw new TypeError("trajectory compression must be 'none'");
  if (format.pack_chunks !== false) throw new TypeError("trajectory pack_chunks must be false");
  const contractCommit = asString(format.contract_commit, "contract_commit");
  const fidelity = asString(record.fidelity, "fidelity");
  if (fidelity !== "native" && fidelity !== "normalized" && fidelity !== "minimal") {
    throw new TypeError(`invalid trajectory fidelity: ${fidelity}`);
  }
  const ref: TrajectoryRef = {
    schema_version: "1",
    run_id: asString(record.run_id, "run_id"),
    session_id: asString(record.session_id, "session_id"),
    format: {
      family: "dsh-session",
      version: 0,
      contract_commit: contractCommit,
      compression: "none",
      pack_chunks: false,
    },
    fidelity,
    path: asString(record.path, "path"),
  };
  const providerSessionId = asOptionalString(record.provider_session_id, "provider_session_id");
  if (providerSessionId !== undefined) ref.provider_session_id = providerSessionId;
  const sha256 = asOptionalString(record.sha256, "sha256");
  if (sha256 !== undefined) {
    if (!/^sha256:[0-9a-f]{64}$/.test(sha256)) throw new TypeError("trajectory sha256 must be a sha256 digest");
    ref.sha256 = sha256 as `sha256:${string}`;
  }
  return ref;
}

export function validateMessageFeedbackItem(value: unknown): MessageFeedbackItem {
  const record = asRecord(value, "feedback item");
  const rating = asString(record.rating, "rating");
  if (rating !== "positive" && rating !== "negative") throw new TypeError("rating must be 'positive' or 'negative'");
  const version = asString(record.version, "version");
  const item: MessageFeedbackItem = {
    messageId: asString(record.messageId, "messageId"),
    rating,
    version,
    createdAt: asEpochMillis(record.createdAt, "createdAt"),
    updatedAt: asEpochMillis(record.updatedAt, "updatedAt"),
  };
  const note = asOptionalString(record.note, "note");
  if (note !== undefined) item.note = note;
  return item;
}

export function validateMessageFeedbackRow(value: unknown): MessageFeedbackRow {
  const record = asRecord(value, "feedback row");
  const session = asRecord(record.session, "feedback session");
  const row: MessageFeedbackRow = {
    session: { createdAt: asEpochMillis(session.createdAt, "session.createdAt") },
    items: asArray(record.items, "items").map((item) => validateMessageFeedbackItem(item)),
  };
  const cwd = asOptionalString(session.cwd, "session.cwd");
  if (cwd !== undefined) row.session.cwd = cwd;
  return row;
}

export function validateControllerRuntimeManifest(value: unknown): ControllerRuntimeManifest {
  const record = asRecord(value, "controller runtime manifest");
  if (record.schema_version !== "1") throw new TypeError("controller runtime manifest schema_version must be '1'");
  const runtimeId = asString(record.runtime_id, "runtime_id");
  if (!/^sha256:[0-9a-f]{64}$/.test(runtimeId)) throw new TypeError("runtime_id must be a sha256 digest");
  if (record.node_range !== ">=22") throw new TypeError("node_range must be '>=22'");
  const createdAt = asString(record.created_at, "created_at");
  const files = asArray(record.files, "files").map((entry) => {
    const file = asRecord(entry, "runtime file");
    const pathValue = asString(file.path, "file path");
    if (!pathValue || pathValue.includes("\\") || pathValue.startsWith("/") || pathValue.startsWith("..")) {
      throw new TypeError(`invalid runtime file path: ${pathValue}`);
    }
    const digest = asString(file.sha256, "file sha256");
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new TypeError("file sha256 must be a sha256 digest");
    return {
      path: pathValue,
      size: asInteger(file.size, "file size"),
      executable: asBoolean(file.executable, "file executable"),
      sha256: digest as `sha256:${string}`,
    };
  });
  return {
    schema_version: "1",
    runtime_id: runtimeId as `sha256:${string}`,
    node_range: ">=22",
    files,
    created_at: createdAt,
  };
}
