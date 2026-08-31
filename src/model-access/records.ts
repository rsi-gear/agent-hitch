import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { InteractionCaptureRefV1, ModelInteractionV1, Sha256 } from "../domain/index.js";
import { readJSON } from "../foundation/index.js";

export function parseInteractionCaptureRef(value: unknown): InteractionCaptureRefV1 {
  const record = exact(value, [
    "schema_version", "run_id", "mode", "required", "topology", "completeness", "interaction_count", "interactions_ref", "redaction",
  ], "interaction capture ref");
  if (record.schema_version !== "1" || typeof record.run_id !== "string" || !/^run_[a-f0-9]{32}$/.test(record.run_id)
    || !new Set(["proxy", "hybrid"]).has(String(record.mode)) || typeof record.required !== "boolean"
    || !new Set(["host-side", "in-sandbox"]).has(String(record.topology))
    || !new Set(["complete", "partial", "none"]).has(String(record.completeness))
    || !Number.isSafeInteger(record.interaction_count) || (record.interaction_count as number) < 0
    || !relativePath(record.interactions_ref)) throw new TypeError("interaction capture ref identity is invalid");
  const redaction = exact(record.redaction, ["policy", "status", "rules"], "interaction capture redaction");
  if (typeof redaction.policy !== "string" || !redaction.policy || redaction.policy.length > 256
    || !new Set(["applied", "not-needed", "failed"]).has(String(redaction.status)) || !Array.isArray(redaction.rules)) {
    throw new TypeError("interaction capture redaction is invalid");
  }
  const rules = redaction.rules.map((value) => {
    const rule = exact(value, ["rule_id", "count"], "interaction capture redaction rule");
    if (typeof rule.rule_id !== "string" || !rule.rule_id || !Number.isSafeInteger(rule.count) || (rule.count as number) < 1) {
      throw new TypeError("interaction capture redaction rule is invalid");
    }
    return { rule_id: rule.rule_id, count: rule.count as number };
  });
  const sorted = [...rules].sort((left, right) => Buffer.from(left.rule_id).compare(Buffer.from(right.rule_id)));
  if (JSON.stringify(sorted) !== JSON.stringify(rules) || new Set(rules.map((rule) => rule.rule_id)).size !== rules.length) {
    throw new TypeError("interaction capture redaction rules are not canonical");
  }
  if ((record.completeness === "none") !== (record.interaction_count === 0)) throw new TypeError("interaction capture completeness is inconsistent");
  return {
    schema_version: "1",
    run_id: record.run_id,
    mode: record.mode as "proxy" | "hybrid",
    required: record.required,
    topology: record.topology as "host-side" | "in-sandbox",
    completeness: record.completeness as "complete" | "partial" | "none",
    interaction_count: record.interaction_count as number,
    interactions_ref: record.interactions_ref as string,
    redaction: {
      policy: redaction.policy,
      status: redaction.status as "applied" | "not-needed" | "failed",
      rules,
    },
  };
}

export function parseModelInteraction(value: unknown): ModelInteractionV1 {
  const record = exact(value, [
    "schema_version", "interaction_id", "run_id", "eval_id", "trial_id", "sequence", "requested_model", "effective_model",
    "endpoint_identity", "started_at", "completed_at", "latency_ms", "status", "http_status", "retry_of", "usage",
    "request_ref", "response_ref", "error",
  ], "model interaction");
  if (record.schema_version !== "1" || typeof record.interaction_id !== "string" || !/^interaction_[a-f0-9]{32}$/.test(record.interaction_id)
    || typeof record.run_id !== "string" || !/^run_[a-f0-9]{32}$/.test(record.run_id)
    || !Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1 || typeof record.requested_model !== "string"
    || !isSha256(record.endpoint_identity) || !timestamp(record.started_at) || !new Set(["succeeded", "failed", "cancelled"]).has(String(record.status))) {
    throw new TypeError("model interaction identity is invalid");
  }
  for (const field of ["eval_id", "trial_id", "effective_model"] as const) {
    if (record[field] !== undefined && (typeof record[field] !== "string" || !(record[field] as string))) throw new TypeError(`model interaction ${field} is invalid`);
  }
  if (record.completed_at !== undefined && !timestamp(record.completed_at)
    || record.latency_ms !== undefined && (!Number.isSafeInteger(record.latency_ms) || (record.latency_ms as number) < 0)
    || record.http_status !== undefined && (!Number.isSafeInteger(record.http_status) || (record.http_status as number) < 100 || (record.http_status as number) > 599)
    || record.retry_of !== undefined && (typeof record.retry_of !== "string" || !/^interaction_[a-f0-9]{32}$/.test(record.retry_of))) {
    throw new TypeError("model interaction terminal fields are invalid");
  }
  for (const field of ["request_ref", "response_ref"] as const) if (record[field] !== undefined && !relativePath(record[field])) throw new TypeError(`model interaction ${field} is invalid`);
  const usage = record.usage === undefined ? undefined : numberMap(record.usage, "model interaction usage");
  const error = record.error === undefined ? undefined : exact(record.error, ["code", "message"], "model interaction error");
  if (error && (typeof error.code !== "string" || !error.code || typeof error.message !== "string" || !error.message)) throw new TypeError("model interaction error is invalid");
  return {
    schema_version: "1",
    interaction_id: record.interaction_id,
    run_id: record.run_id,
    ...(record.eval_id ? { eval_id: record.eval_id as string } : {}),
    ...(record.trial_id ? { trial_id: record.trial_id as string } : {}),
    sequence: record.sequence as number,
    requested_model: record.requested_model,
    ...(record.effective_model ? { effective_model: record.effective_model as string } : {}),
    endpoint_identity: record.endpoint_identity as Sha256,
    started_at: record.started_at as string,
    ...(record.completed_at ? { completed_at: record.completed_at as string } : {}),
    ...(record.latency_ms === undefined ? {} : { latency_ms: record.latency_ms as number }),
    status: record.status as ModelInteractionV1["status"],
    ...(record.http_status === undefined ? {} : { http_status: record.http_status as number }),
    ...(record.retry_of ? { retry_of: record.retry_of as string } : {}),
    ...(usage ? { usage } : {}),
    ...(record.request_ref ? { request_ref: record.request_ref as string } : {}),
    ...(record.response_ref ? { response_ref: record.response_ref as string } : {}),
    ...(error ? { error: error as { code: string; message: string } } : {}),
  };
}

export async function loadInteractionCapture(runDirectory: string): Promise<{
  ref: InteractionCaptureRefV1;
  interactions: ModelInteractionV1[];
}> {
  const ref = parseInteractionCaptureRef(await readJSON(path.join(runDirectory, "interactions", "interaction.ref.json")));
  const file = path.resolve(runDirectory, ...ref.interactions_ref.split("/"));
  if (!inside(runDirectory, file)) throw new TypeError("interaction capture ref escapes its run");
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new TypeError("interaction capture rows are unsafe");
  const lines = (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean);
  const interactions = lines.map((line) => parseModelInteraction(JSON.parse(line) as unknown));
  if (interactions.length !== ref.interaction_count || interactions.some((row, index) => row.run_id !== ref.run_id || row.sequence !== index + 1)) {
    throw new TypeError("interaction capture rows do not match their ref");
  }
  return { ref, interactions };
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new TypeError(`${label} has unknown fields`);
  return record;
}

function relativePath(value: unknown): value is string {
  return typeof value === "string" && value === value.normalize("NFC") && !path.posix.isAbsolute(value) && !value.includes("\\")
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function numberMap(value: unknown, label: string): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.entries(record).some(([key, entry]) => !key || typeof entry !== "number" || !Number.isFinite(entry) || entry < 0)) throw new TypeError(`${label} is invalid`);
  return record as Record<string, number>;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
