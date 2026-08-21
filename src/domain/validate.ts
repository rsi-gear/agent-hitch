/**
 * Runtime validators for external JSON, provider events, CLI input, and
 * process output. Values enter as `unknown` and are narrowed here before any
 * domain code touches them (spec §8.2).
 *
 * Pure functions only — no CLI, daemon, backend, or filesystem imports.
 */

import type {
  ControllerRuntimeManifest,
  EvalRunParentV1,
  MessageFeedbackItem,
  MessageFeedbackRow,
  RunContextV1,
  RunObservationV1,
  SessionEvent,
  SessionHeaderLine,
  TrajectoryRef,
  TrajectoryRefV1,
  TrajectoryRefV2,
} from "./types.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function asSha256(value: unknown, label = "value"): `sha256:${string}` {
  const digest = asString(value, label);
  if (!SHA256_PATTERN.test(digest)) throw new TypeError(`${label} must be a sha256 digest`);
  return digest as `sha256:${string}`;
}

function assertExactFields(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find((field) => !allowedSet.has(field));
  if (unexpected) throw new TypeError(`${label} has unknown field: ${unexpected}`);
}

function nonEmptyString(value: unknown, label: string): string {
  const result = asString(value, label);
  if (!result.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return result;
}

/** Validate a run context before a run directory or agent process is created. */
export function validateRunContext(value: unknown = { kind: "ad_hoc" }): RunContextV1 {
  const record = asRecord(value, "run context");
  const kind = asString(record.kind, "run context kind");
  if (kind === "ad_hoc") {
    assertExactFields(record, ["kind"], "ad_hoc context");
    return { kind };
  }
  if (kind === "seed_task") {
    assertExactFields(record, [
      "kind", "seed_task_id", "seed_task_digest", "seed_set_id",
      "seed_set_revision", "iteration_id",
    ], "seed_task context");
    const context: Extract<RunContextV1, { kind: "seed_task" }> = {
      kind,
      seed_task_id: nonEmptyString(record.seed_task_id, "seed_task_id"),
      seed_task_digest: asSha256(record.seed_task_digest, "seed_task_digest"),
    };
    const seedSetId = asOptionalString(record.seed_set_id, "seed_set_id");
    if (seedSetId !== undefined) context.seed_set_id = nonEmptyString(seedSetId, "seed_set_id");
    const seedSetRevision = asOptionalString(record.seed_set_revision, "seed_set_revision");
    if (seedSetRevision !== undefined) context.seed_set_revision = nonEmptyString(seedSetRevision, "seed_set_revision");
    const iterationId = asOptionalString(record.iteration_id, "iteration_id");
    if (iterationId !== undefined) context.iteration_id = nonEmptyString(iterationId, "iteration_id");
    return context;
  }
  if (kind === "benchmark_task") {
    assertExactFields(record, [
      "kind", "benchmark_id", "benchmark_revision", "task_id",
      "task_digest", "verifier_identity",
    ], "benchmark_task context");
    const revision = nonEmptyString(record.benchmark_revision, "benchmark_revision");
    if (revision.toLowerCase() === "latest") {
      throw new TypeError("benchmark_revision must be immutable and cannot be 'latest'");
    }
    return {
      kind,
      benchmark_id: nonEmptyString(record.benchmark_id, "benchmark_id"),
      benchmark_revision: revision,
      task_id: nonEmptyString(record.task_id, "task_id"),
      task_digest: asSha256(record.task_digest, "task_digest"),
      verifier_identity: asSha256(record.verifier_identity, "verifier_identity"),
    };
  }
  throw new TypeError(`invalid run context kind: ${kind}`);
}

export function validateEvalRunParent(value: unknown): EvalRunParentV1 {
  const record = asRecord(value, "run parent");
  assertExactFields(record, ["kind", "eval_id", "trial_id", "attempt"], "run parent");
  if (record.kind !== "eval") throw new TypeError("run parent kind must be 'eval'");
  const attempt = asInteger(record.attempt, "parent attempt");
  if (attempt <= 0) throw new TypeError("parent attempt must be positive");
  return {
    kind: "eval",
    eval_id: nonEmptyString(record.eval_id, "parent eval_id"),
    trial_id: nonEmptyString(record.trial_id, "parent trial_id"),
    attempt,
  };
}

export function validateRunObservation(value: unknown): RunObservationV1 {
  const record = asRecord(value, "run observation");
  assertExactFields(record, ["status", "reward", "verifier_result_ref", "invalid_reason"], "run observation");
  if (record.status !== "valid" && record.status !== "invalid") {
    throw new TypeError("run observation status must be 'valid' or 'invalid'");
  }
  const observation: RunObservationV1 = { status: record.status };
  if (record.reward !== undefined) observation.reward = asNumber(record.reward, "observation reward");
  if (record.verifier_result_ref !== undefined) {
    observation.verifier_result_ref = validateRelativePath(record.verifier_result_ref, "verifier_result_ref");
  }
  if (record.invalid_reason !== undefined) observation.invalid_reason = nonEmptyString(record.invalid_reason, "invalid_reason");
  if (observation.status === "valid") {
    if (observation.reward === undefined) throw new TypeError("valid observation must include reward");
    if (!observation.verifier_result_ref) throw new TypeError("valid observation must include verifier_result_ref");
    if (observation.invalid_reason !== undefined) throw new TypeError("valid observation must not include invalid_reason");
  } else {
    if (!observation.invalid_reason) throw new TypeError("invalid observation must include invalid_reason");
    if (observation.reward !== undefined) throw new TypeError("invalid observation must not include reward");
  }
  return observation;
}

export function validateRelativePath(value: unknown, label = "path"): string {
  const candidate = nonEmptyString(value, label);
  if (
    candidate.includes("\\")
    || candidate.startsWith("/")
    || candidate.split("/").some((segment) => segment === ".." || segment === "." || segment === "")
  ) {
    throw new TypeError(`${label} must be a normalized relative path`);
  }
  return candidate;
}

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
  if (record.schema_version === "2") return validateTrajectoryRefV2(record);
  if (record.schema_version !== "1") throw new TypeError("trajectory ref schema_version must be '1' or '2'");
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
  const ref: TrajectoryRefV1 = {
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
    ref.sha256 = asSha256(sha256, "trajectory sha256");
  }
  return ref;
}

function validateTrajectoryRefV2(record: Record<string, unknown>): TrajectoryRefV2 {
  assertExactFields(record, [
    "schema_version", "run_id", "fidelity", "provider", "provider_session_id", "files", "redactions",
  ], "trajectory ref V2");
  const fidelity = asString(record.fidelity, "trajectory fidelity");
  if (fidelity !== "provider_native" && fidelity !== "normalized" && fidelity !== "minimal") {
    throw new TypeError(`invalid trajectory fidelity: ${fidelity}`);
  }
  const files = asArray(record.files, "trajectory files").map((entry, index) => {
    const file = asRecord(entry, `trajectory file ${index}`);
    assertExactFields(file, ["role", "path", "media_type", "sha256", "bytes"], `trajectory file ${index}`);
    const role = asString(file.role, `trajectory file ${index} role`);
    if (!["provider_events", "provider_transcript", "provider_artifact", "canonical_session"].includes(role)) {
      throw new TypeError(`invalid trajectory file role: ${role}`);
    }
    const bytes = asInteger(file.bytes, `trajectory file ${index} bytes`);
    if (bytes < 0) throw new TypeError(`trajectory file ${index} bytes must be non-negative`);
    return {
      role: role as "provider_events" | "provider_transcript" | "provider_artifact" | "canonical_session",
      path: validateRelativePath(file.path, `trajectory file ${index} path`),
      media_type: nonEmptyString(file.media_type, `trajectory file ${index} media_type`),
      sha256: asSha256(file.sha256, `trajectory file ${index} sha256`),
      bytes,
    };
  });
  if (files.length === 0) throw new TypeError("trajectory files must not be empty");
  if (files.filter((file) => file.role === "canonical_session").length !== 1) {
    throw new TypeError("trajectory files must include exactly one canonical_session");
  }
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new TypeError("trajectory file paths must be unique");
  }
  if (fidelity === "provider_native" && !files.some((file) => file.role.startsWith("provider_"))) {
    throw new TypeError("provider_native trajectory must include a provider file");
  }
  const runId = nonEmptyString(record.run_id, "trajectory run_id");
  if (!/^run_[a-f0-9]{32}$/.test(runId)) throw new TypeError(`invalid trajectory run_id: ${runId}`);
  const result: TrajectoryRefV2 = {
    schema_version: "2",
    run_id: runId,
    fidelity,
    files,
  };
  const provider = asOptionalString(record.provider, "trajectory provider");
  if (provider !== undefined) result.provider = nonEmptyString(provider, "trajectory provider");
  const providerSessionId = asOptionalString(record.provider_session_id, "provider_session_id");
  if (providerSessionId !== undefined) result.provider_session_id = nonEmptyString(providerSessionId, "provider_session_id");
  if (record.redactions !== undefined) {
    result.redactions = asArray(record.redactions, "trajectory redactions").map((entry, index) => {
      const redaction = asRecord(entry, `trajectory redaction ${index}`);
      assertExactFields(redaction, ["rule_id", "count"], `trajectory redaction ${index}`);
      const count = asInteger(redaction.count, `trajectory redaction ${index} count`);
      if (count <= 0) throw new TypeError(`trajectory redaction ${index} count must be positive`);
      return { rule_id: nonEmptyString(redaction.rule_id, `trajectory redaction ${index} rule_id`), count };
    });
    if (new Set(result.redactions.map((redaction) => redaction.rule_id)).size !== result.redactions.length) {
      throw new TypeError("trajectory redaction rule_id values must be unique");
    }
  }
  return result;
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
  const sessionId = asOptionalString(session.sessionId, "session.sessionId");
  if (sessionId !== undefined) row.session.sessionId = sessionId;
  const cwd = asOptionalString(session.cwd, "session.cwd");
  if (cwd !== undefined) row.session.cwd = cwd;
  return row;
}

export function validateControllerRuntimeManifest(value: unknown): ControllerRuntimeManifest {
  const record = asRecord(value, "controller runtime manifest");
  if (record.schema_version !== "2") throw new TypeError("controller runtime manifest schema_version must be '2'");
  const runtimeId = asString(record.runtime_id, "runtime_id");
  if (!/^sha256:[0-9a-f]{64}$/.test(runtimeId)) throw new TypeError("runtime_id must be a sha256 digest");
  if (record.node_range !== ">=22") throw new TypeError("node_range must be '>=22'");
  const createdAt = asString(record.created_at, "created_at");
  const entrypoints = asRecord(record.entrypoints, "entrypoints");
  const cli = asRecord(entrypoints.cli, "entrypoints.cli");
  const cliPath = asString(cli.path, "entrypoints.cli.path");
  if (!cliPath || cliPath.includes("\\") || cliPath.startsWith("/") || cliPath.startsWith("..")) {
    throw new TypeError(`invalid entrypoint path: ${cliPath}`);
  }
  if (cli.launcher !== "node") throw new TypeError("entrypoints.cli.launcher must be 'node'");
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
    schema_version: "2",
    runtime_id: runtimeId as `sha256:${string}`,
    node_range: ">=22",
    entrypoints: { cli: { path: cliPath, launcher: "node" } },
    files,
    created_at: createdAt,
  };
}
