import type {
  JsonValue,
  VerifierFeedbackV1,
  VerifierProcessComponentV1,
  VerifierProcessEvidenceV1,
  VerifierScoresV1,
  VerifierTrajectoryRefV1,
} from "./verifier-evidence.js";

const SCORE_EPSILON = 1e-12;

/** Parse the Harbor verifier result into the benchmark-neutral score channels. */
export function parseVerifierScores(value: unknown): VerifierScoresV1 | undefined {
  if (!isRecord(value)) return undefined;
  const rewards = value.rewards;
  if (!isRecord(rewards)) return undefined;
  if (rewards.total_score === undefined) {
    if (rewards.process_score !== undefined) throw new TypeError("process_score requires total_score");
    const reward = optionalFinite(rewards.reward, "reward");
    return reward === undefined ? undefined : { total_score: reward, normalization: "legacy-reward" };
  }
  const reward = finite(rewards.reward, "reward");
  const totalScore = finite(rewards.total_score, "total_score");
  if (!sameScore(reward, totalScore)) throw new TypeError("reward must equal total_score");
  const processScore = optionalFinite(rewards.process_score, "process_score");
  return {
    total_score: totalScore,
    ...(processScore === undefined ? {} : { process_score: processScore }),
    normalization: "standard",
  };
}

export function parseVerifierProcessEvidence(value: unknown): VerifierProcessEvidenceV1 {
  const record = object(value, "process evidence");
  exact(record, ["schema_version", "metric", "score", "detail_status", "passed", "total", "excluded", "components"], "process evidence");
  if (record.schema_version !== "1") throw new TypeError("unsupported process evidence schema");
  const metric = identifier(record.metric, "process metric");
  const score = finite(record.score, "process score");
  if (record.detail_status !== "components" && record.detail_status !== "aggregate-only") {
    throw new TypeError("process detail_status is invalid");
  }
  if (record.detail_status === "aggregate-only") {
    if (record.passed !== undefined || record.total !== undefined || record.excluded !== undefined || record.components !== undefined) {
      throw new TypeError("aggregate-only process evidence must omit components and counts");
    }
    return { schema_version: "1", metric, score, detail_status: "aggregate-only" };
  }
  const passed = nonNegativeInteger(record.passed, "process passed");
  const total = nonNegativeInteger(record.total, "process total");
  const excluded = nonNegativeInteger(record.excluded, "process excluded");
  if (passed > total) throw new TypeError("process passed exceeds total");
  if (!Array.isArray(record.components)) throw new TypeError("component process evidence requires components");
  const components = record.components.map((component, index) => parseComponent(component, index));
  if (new Set(components.map((component) => component.id)).size !== components.length) {
    throw new TypeError("process component IDs must be unique");
  }
  const actualPassed = components.filter((component) => component.status === "passed").length;
  const actualTotal = components.filter((component) => component.status !== "excluded").length;
  const actualExcluded = components.length - actualTotal;
  if (passed !== actualPassed || total !== actualTotal || excluded !== actualExcluded) {
    throw new TypeError("process component counts are inconsistent");
  }
  const denominator = components
    .filter((component) => component.status !== "excluded")
    .reduce((sum, component) => sum + component.weight, 0);
  const numerator = components
    .filter((component) => component.status === "passed")
    .reduce((sum, component) => sum + component.weight, 0);
  const aggregate = denominator === 0 ? 0 : numerator / denominator;
  if (!sameScore(score, aggregate)) throw new TypeError("process score does not match component weights");
  return { schema_version: "1", metric, score, detail_status: "components", passed, total, excluded, components };
}

export function parseVerifierFeedback(
  value: unknown,
  process?: VerifierProcessEvidenceV1,
): VerifierFeedbackV1 {
  const record = object(value, "verifier feedback");
  exact(record, ["schema_version", "items"], "verifier feedback");
  if (record.schema_version !== "1" || !Array.isArray(record.items)) throw new TypeError("verifier feedback schema is invalid");
  const componentIds = new Set(process?.components?.map((component) => component.id) ?? []);
  const items = record.items.map((item, index) => {
    const entry = object(item, `verifier feedback item ${index}`);
    exact(entry, ["code", "severity", "message", "component_ids", "trajectory_refs"], `verifier feedback item ${index}`);
    const code = identifier(entry.code, `verifier feedback item ${index} code`);
    if (entry.severity !== "info" && entry.severity !== "warning" && entry.severity !== "error") {
      throw new TypeError(`verifier feedback item ${index} severity is invalid`);
    }
    const message = boundedString(entry.message, `verifier feedback item ${index} message`, 16 * 1024);
    const ids = entry.component_ids === undefined ? undefined : stringArray(entry.component_ids, `verifier feedback item ${index} component_ids`);
    if (ids?.some((id) => !componentIds.has(id))) throw new TypeError("verifier feedback contains an unknown component reference");
    const refs = entry.trajectory_refs === undefined ? undefined : trajectoryRefs(entry.trajectory_refs, `verifier feedback item ${index}`);
    return {
      code,
      severity: entry.severity as "info" | "warning" | "error",
      message,
      ...(ids === undefined ? {} : { component_ids: ids }),
      ...(refs === undefined ? {} : { trajectory_refs: refs }),
    };
  });
  return { schema_version: "1", items };
}

export function assertVerifierScoreEvidenceConsistency(input: {
  scores: VerifierScoresV1 | undefined;
  process?: VerifierProcessEvidenceV1;
  feedback?: VerifierFeedbackV1;
}): void {
  if (!input.scores) {
    if (input.process || input.feedback) throw new TypeError("structured verifier evidence requires a score result");
    return;
  }
  if (input.scores.process_score === undefined && input.process !== undefined) {
    throw new TypeError("process.json requires process_score");
  }
  if (input.scores.process_score !== undefined && input.process === undefined) {
    throw new TypeError("process_score requires process.json");
  }
  if (input.process && !sameScore(input.process.score, input.scores.process_score as number)) {
    throw new TypeError("process.json score differs from process_score");
  }
  if (input.scores.normalization === "legacy-reward" && (input.process || input.feedback)) {
    throw new TypeError("legacy reward results cannot attach standard structured evidence");
  }
}

function parseComponent(value: unknown, index: number): VerifierProcessComponentV1 {
  const record = object(value, `process component ${index}`);
  exact(record, ["id", "category", "status", "weight", "code", "public_details", "private_details_ref", "trajectory_refs"], `process component ${index}`);
  const id = identifier(record.id, `process component ${index} id`);
  const category = identifier(record.category, `process component ${index} category`);
  if (record.status !== "passed" && record.status !== "failed" && record.status !== "excluded") {
    throw new TypeError(`process component ${index} status is invalid`);
  }
  const weight = finite(record.weight, `process component ${index} weight`);
  if (weight <= 0) throw new TypeError(`process component ${index} weight must be positive`);
  const code = record.code === undefined ? undefined : identifier(record.code, `process component ${index} code`);
  const publicDetails = record.public_details === undefined ? undefined : jsonObject(record.public_details, `process component ${index} public_details`);
  const privateDetailsRef = record.private_details_ref === undefined
    ? undefined : relativeRef(record.private_details_ref, `process component ${index} private_details_ref`);
  const refs = record.trajectory_refs === undefined ? undefined : trajectoryRefs(record.trajectory_refs, `process component ${index}`);
  return {
    id,
    category,
    status: record.status,
    weight,
    ...(code === undefined ? {} : { code }),
    ...(publicDetails === undefined ? {} : { public_details: publicDetails }),
    ...(privateDetailsRef === undefined ? {} : { private_details_ref: privateDetailsRef }),
    ...(refs === undefined ? {} : { trajectory_refs: refs }),
  };
}

function trajectoryRefs(value: unknown, label: string): VerifierTrajectoryRefV1[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} trajectory_refs must be an array`);
  return value.map((raw, index) => {
    const record = object(raw, `${label} trajectory ref ${index}`);
    exact(record, ["run_id", "seq_start", "seq_end"], `${label} trajectory ref ${index}`);
    const runId = boundedString(record.run_id, `${label} trajectory ref ${index} run_id`, 256);
    if (!/^run_[a-f0-9]{32}$/.test(runId)) throw new TypeError(`${label} trajectory ref ${index} run_id is invalid`);
    const start = record.seq_start === undefined ? undefined : nonNegativeInteger(record.seq_start, `${label} trajectory ref ${index} seq_start`);
    const end = record.seq_end === undefined ? undefined : nonNegativeInteger(record.seq_end, `${label} trajectory ref ${index} seq_end`);
    if (start !== undefined && end !== undefined && end < start) throw new TypeError(`${label} trajectory ref ${index} range is invalid`);
    return { run_id: runId, ...(start === undefined ? {} : { seq_start: start }), ...(end === undefined ? {} : { seq_end: end }) };
  });
}

function jsonObject(value: unknown, label: string): { [key: string]: JsonValue } {
  const record = object(value, label);
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, json(entry, `${label}.${key}`)]));
}

function json(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => json(entry, label));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, json(entry, `${label}.${key}`)]));
  throw new TypeError(`${label} is not JSON data`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exact(record: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  const extra = Object.keys(record).find((field) => !allowed.has(field));
  if (extra) throw new TypeError(`${label} has unknown field: ${extra}`);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
  return value;
}

function optionalFinite(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : finite(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return Number(value);
}

function identifier(value: unknown, label: string): string {
  const result = boundedString(value, label, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) throw new TypeError(`${label} is invalid`);
  return result;
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > max) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function relativeRef(value: unknown, label: string): string {
  const result = boundedString(value, label, 1024);
  if (result.startsWith("/") || result.includes("\\") || result.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(`${label} must be a contained relative path`);
  }
  return result;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const result = value.map((entry, index) => identifier(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} must not contain duplicates`);
  return result;
}

function sameScore(left: number, right: number): boolean {
  return Math.abs(left - right) <= SCORE_EPSILON;
}
