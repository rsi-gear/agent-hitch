import type { HitchVerifierEvidenceV1, JsonValue, VerifierArtifactExcerptV1 } from "./verifier-evidence.js";
import { asArray, asInteger, asRecord, asSha256, asString, validateEvalRunParent, validateRunObservation } from "./validation.js";

const ARTIFACT_NAMES = new Set(["ctrf.json", "test-stdout.txt", "test-stderr.txt", "stdout.txt", "stderr.txt"]);
const STATUSES = new Set(["complete", "result_only", "missing", "corrupt"]);

export function validateVerifierEvidence(value: unknown): HitchVerifierEvidenceV1 {
  const record = asRecord(value, "verifier evidence");
  exact(record, ["schema_version", "kind", "run_id", "parent", "observation", "verifier", "redactions"], "verifier evidence");
  if (record.schema_version !== "1" || record.kind !== "verifier-evidence") throw new TypeError("unsupported verifier evidence schema");
  const runId = asString(record.run_id, "verifier evidence run_id");
  if (!/^run_[a-f0-9]{32}$/.test(runId)) throw new TypeError("verifier evidence run_id is invalid");
  const parentRecord = record.parent === undefined ? undefined : asRecord(record.parent, "verifier evidence parent");
  if (parentRecord) exact(parentRecord, ["eval_id", "trial_id", "attempt"], "verifier evidence parent");
  const parent = parentRecord === undefined ? undefined : validateEvalRunParent({ kind: "eval", ...parentRecord });
  if (parent && !/^eval_[a-f0-9]{32}$/.test(parent.eval_id)) throw new TypeError("verifier evidence parent eval_id is invalid");
  const observation = record.observation === undefined ? undefined : validateRunObservation(record.observation);
  const verifier = parseVerifier(record.verifier);
  const redactions = record.redactions === undefined ? undefined : parseRedactions(record.redactions);
  return {
    schema_version: "1",
    kind: "verifier-evidence",
    run_id: runId,
    ...(parent ? { parent: { eval_id: parent.eval_id, trial_id: parent.trial_id, attempt: parent.attempt } } : {}),
    ...(observation ? { observation } : {}),
    verifier,
    ...(redactions ? { redactions } : {}),
  };
}

function parseVerifier(value: unknown): HitchVerifierEvidenceV1["verifier"] {
  const record = asRecord(value, "verifier evidence payload");
  exact(record, ["status", "result", "result_sha256", "diagnostics", "issues"], "verifier evidence payload");
  const status = asString(record.status, "verifier evidence status");
  if (!STATUSES.has(status)) throw new TypeError("verifier evidence status is invalid");
  const result = record.result === undefined ? undefined : jsonValue(record.result, "verifier result");
  const resultSha256 = record.result_sha256 === undefined ? undefined : asSha256(record.result_sha256, "verifier result digest");
  const diagnostics = record.diagnostics === undefined ? undefined : parseDiagnostics(record.diagnostics);
  const issues = record.issues === undefined ? undefined : asArray(record.issues, "verifier issues").map((issue) => {
    const text = asString(issue, "verifier issue");
    if (!text || text.length > 1024) throw new TypeError("verifier issue is invalid");
    return text;
  });
  if ((status === "complete" || status === "result_only") && (result === undefined || resultSha256 === undefined)) {
    throw new TypeError(`${status} verifier evidence requires a result and digest`);
  }
  if (status === "complete" && !hasArtifactDiagnostics(diagnostics)) {
    throw new TypeError("complete verifier evidence requires CTRF, stdout, or stderr diagnostics");
  }
  if (status === "result_only" && hasArtifactDiagnostics(diagnostics)) {
    throw new TypeError("result_only verifier evidence must not include CTRF, stdout, or stderr diagnostics");
  }
  if (status === "missing" && result !== undefined) throw new TypeError("missing verifier evidence must not include a result");
  return {
    status: status as HitchVerifierEvidenceV1["verifier"]["status"],
    ...(result === undefined ? {} : { result }),
    ...(resultSha256 === undefined ? {} : { result_sha256: resultSha256 }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(issues === undefined ? {} : { issues }),
  };
}

function hasArtifactDiagnostics(diagnostics: HitchVerifierEvidenceV1["verifier"]["diagnostics"]): boolean {
  return diagnostics?.ctrf !== undefined || Boolean(diagnostics?.stdout?.length) || Boolean(diagnostics?.stderr?.length);
}

function parseDiagnostics(value: unknown): NonNullable<HitchVerifierEvidenceV1["verifier"]["diagnostics"]> {
  const record = asRecord(value, "verifier diagnostics");
  exact(record, ["ctrf", "stdout", "stderr", "infrastructure_error", "retry_history"], "verifier diagnostics");
  const ctrf = record.ctrf === undefined ? undefined : parseArtifact(record.ctrf);
  const stdout = record.stdout === undefined ? undefined : asArray(record.stdout, "verifier stdout").map(parseArtifact);
  const stderr = record.stderr === undefined ? undefined : asArray(record.stderr, "verifier stderr").map(parseArtifact);
  const infrastructureError = record.infrastructure_error === undefined
    ? undefined : jsonValue(record.infrastructure_error, "verifier infrastructure error");
  const retryHistory = record.retry_history === undefined
    ? undefined : asArray(record.retry_history, "verifier retry history").map((entry) => jsonValue(entry, "verifier retry entry"));
  if (!ctrf && !stdout?.length && !stderr?.length && infrastructureError === undefined && !retryHistory?.length) {
    throw new TypeError("verifier diagnostics must not be empty");
  }
  return {
    ...(ctrf ? { ctrf } : {}),
    ...(stdout?.length ? { stdout } : {}),
    ...(stderr?.length ? { stderr } : {}),
    ...(infrastructureError === undefined ? {} : { infrastructure_error: infrastructureError }),
    ...(retryHistory?.length ? { retry_history: retryHistory } : {}),
  };
}

function parseArtifact(value: unknown): VerifierArtifactExcerptV1 {
  const record = asRecord(value, "verifier artifact excerpt");
  exact(record, ["name", "media_type", "bytes", "sha256", "truncated", "json", "text"], "verifier artifact excerpt");
  const name = asString(record.name, "verifier artifact name");
  if (!ARTIFACT_NAMES.has(name)) throw new TypeError("verifier artifact name is invalid");
  const mediaType = asString(record.media_type, "verifier artifact media_type");
  if (mediaType !== (name === "ctrf.json" ? "application/json" : "text/plain")) throw new TypeError("verifier artifact media_type is invalid");
  const bytes = asInteger(record.bytes, "verifier artifact bytes");
  if (bytes < 0 || typeof record.truncated !== "boolean") throw new TypeError("verifier artifact size metadata is invalid");
  const json = record.json === undefined ? undefined : jsonValue(record.json, "verifier artifact JSON");
  const text = record.text === undefined ? undefined : asString(record.text, "verifier artifact text");
  if ((json === undefined) === (text === undefined)) throw new TypeError("verifier artifact requires exactly one content representation");
  if (json !== undefined && (mediaType !== "application/json" || record.truncated === true)) {
    throw new TypeError("only complete JSON verifier artifacts may use json content");
  }
  return {
    name: name as VerifierArtifactExcerptV1["name"],
    media_type: mediaType,
    bytes,
    sha256: asSha256(record.sha256, "verifier artifact digest"),
    truncated: record.truncated,
    ...(json === undefined ? { text: text as string } : { json }),
  } as VerifierArtifactExcerptV1;
}

function parseRedactions(value: unknown): Array<{ rule_id: string; count: number }> {
  const result = asArray(value, "verifier redactions").map((entry) => {
    const record = asRecord(entry, "verifier redaction");
    exact(record, ["rule_id", "count"], "verifier redaction");
    const ruleId = asString(record.rule_id, "verifier redaction rule_id");
    const count = asInteger(record.count, "verifier redaction count");
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(ruleId) || count < 1) throw new TypeError("verifier redaction is invalid");
    return { rule_id: ruleId, count };
  });
  const canonical = [...result].sort((left, right) => left.rule_id.localeCompare(right.rule_id));
  if (new Set(result.map((entry) => entry.rule_id)).size !== result.length || JSON.stringify(canonical) !== JSON.stringify(result)) {
    throw new TypeError("verifier redactions are not canonical");
  }
  return result;
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, label));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry, label)]));
  }
  throw new TypeError(`${label} is not JSON data`);
}

function exact(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const fields = new Set(allowed);
  const unexpected = Object.keys(record).find((field) => !fields.has(field));
  if (unexpected) throw new TypeError(`${label} has unknown field: ${unexpected}`);
}
