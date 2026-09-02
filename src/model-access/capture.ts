import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { InteractionCaptureRefV1, ModelInteractionV1, Sha256 } from "../domain/index.js";
import { appendLine, atomicWriteJSON, ensureDir, readJSON, sha256JSON, writePrivateFile } from "../foundation/index.js";
import { parseModelInteraction } from "./records.js";

const SENSITIVE_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;
const SENSITIVE_FIELD = /(?:^|[_-])(?:api[_-]?key|authorization|token|secret|password|credential|cookie)(?:$|[_-])/i;
const TEXT_RULES: Array<{ id: string; pattern: RegExp }> = [
  { id: "authorization-bearer-v1", pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi },
  { id: "provider-api-key-v1", pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g },
];

export interface ModelInteractionCaptureOptions {
  runDirectory: string;
  runId: string;
  evalId?: string;
  trialId?: string;
  mode: "proxy" | "hybrid";
  required: boolean;
  topology: "host-side" | "in-sandbox";
  credentialValues?: readonly string[];
  redactionPolicy?: string;
  resumeExisting?: boolean;
}

export interface CapturedModelExchange {
  requestedModel: string;
  effectiveModel?: string;
  endpoint: string;
  startedAt?: string;
  completedAt?: string;
  status: "succeeded" | "failed" | "cancelled";
  httpStatus?: number;
  retryOf?: string;
  usage?: Record<string, number>;
  request?: unknown;
  requestHeaders?: Record<string, string | string[]>;
  response?: unknown;
  responseHeaders?: Record<string, string | string[]>;
  error?: { code: string; message: string };
}

export class ModelInteractionCapture {
  private readonly options: ModelInteractionCaptureOptions;
  private readonly directory: string;
  private readonly rows: string;
  private readonly credentials: string[];
  private readonly redactions = new Map<string, number>();
  private sequence = 0;
  private failed = false;
  private closed = false;
  private tail = Promise.resolve();

  private constructor(options: ModelInteractionCaptureOptions) {
    this.options = options;
    this.directory = path.join(options.runDirectory, "interactions");
    this.rows = path.join(this.directory, "interactions.jsonl");
    this.credentials = [...new Set((options.credentialValues ?? []).filter((value) => value.length >= 4))].sort();
  }

  static async open(options: ModelInteractionCaptureOptions): Promise<ModelInteractionCapture> {
    if (!/^run_[a-f0-9]{32}$/.test(options.runId) || !new Set(["proxy", "hybrid"]).has(options.mode)
      || !new Set(["host-side", "in-sandbox"]).has(options.topology)) throw new TypeError("model interaction capture identity is invalid");
    await ensureDir(path.join(options.runDirectory, "interactions", "payloads"));
    const capture = new ModelInteractionCapture(options);
    if (options.resumeExisting) await capture.restore();
    else {
      await writePrivateFile(capture.rows, "");
      await capture.writeState();
    }
    return capture;
  }

  record(exchange: CapturedModelExchange): Promise<ModelInteractionV1> {
    if (this.closed) throw new Error("model interaction capture is closed");
    const sequence = ++this.sequence;
    const operation = this.tail.then(() => this.persist(sequence, exchange));
    this.tail = operation.then(() => undefined, () => { this.failed = true; });
    return operation;
  }

  markRedactionFailed(): void {
    this.failed = true;
  }

  async close(): Promise<InteractionCaptureRefV1> {
    if (!this.closed) {
      this.closed = true;
      await this.tail;
    }
    const rules = [...this.redactions].sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
      .map(([rule_id, count]) => ({ rule_id, count }));
    const ref: InteractionCaptureRefV1 = {
      schema_version: "1",
      run_id: this.options.runId,
      mode: this.options.mode,
      required: this.options.required,
      topology: this.options.topology,
      completeness: this.failed ? (this.sequence > 0 ? "partial" : "none") : this.sequence > 0 ? "complete" : "none",
      interaction_count: this.sequence,
      interactions_ref: "interactions/interactions.jsonl",
      redaction: {
        policy: this.options.redactionPolicy ?? "hitch-model-interaction-redaction-v1",
        status: this.failed ? "failed" : rules.length > 0 ? "applied" : "not-needed",
        rules,
      },
    };
    await atomicWriteJSON(path.join(this.directory, "interaction.ref.json"), ref);
    await this.writeState();
    return ref;
  }

  private async persist(sequence: number, exchange: CapturedModelExchange): Promise<ModelInteractionV1> {
    const interactionId = `interaction_${randomUUID().replaceAll("-", "")}`;
    const startedAt = timestamp(exchange.startedAt ?? new Date().toISOString(), "interaction started_at");
    const completedAt = timestamp(exchange.completedAt ?? new Date().toISOString(), "interaction completed_at");
    const requestRef = exchange.request === undefined && exchange.requestHeaders === undefined
      ? undefined
      : `interactions/payloads/${interactionId}.request.json`;
    const responseRef = exchange.response === undefined && exchange.responseHeaders === undefined
      ? undefined
      : `interactions/payloads/${interactionId}.response.json`;
    if (requestRef) await atomicWriteJSON(path.join(this.options.runDirectory, ...requestRef.split("/")), this.redact({ headers: exchange.requestHeaders, body: exchange.request }));
    if (responseRef) await atomicWriteJSON(path.join(this.options.runDirectory, ...responseRef.split("/")), this.redact({ headers: exchange.responseHeaders, body: exchange.response }));
    const row: ModelInteractionV1 = {
      schema_version: "1",
      interaction_id: interactionId,
      run_id: this.options.runId,
      ...(this.options.evalId ? { eval_id: this.options.evalId } : {}),
      ...(this.options.trialId ? { trial_id: this.options.trialId } : {}),
      sequence,
      requested_model: bounded(exchange.requestedModel, 1_024),
      ...(exchange.effectiveModel ? { effective_model: bounded(exchange.effectiveModel, 1_024) } : {}),
      endpoint_identity: endpointIdentity(exchange.endpoint),
      started_at: startedAt,
      completed_at: completedAt,
      latency_ms: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      status: exchange.status,
      ...(exchange.httpStatus === undefined ? {} : { http_status: httpStatus(exchange.httpStatus) }),
      ...(exchange.retryOf ? { retry_of: interactionIdValue(exchange.retryOf) } : {}),
      ...(exchange.usage ? { usage: usage(exchange.usage) } : {}),
      ...(requestRef ? { request_ref: requestRef } : {}),
      ...(responseRef ? { response_ref: responseRef } : {}),
      ...(exchange.error ? { error: { code: bounded(exchange.error.code, 256), message: bounded(this.redactText(exchange.error.message), 4_096) } } : {}),
    };
    await appendLine(this.rows, JSON.stringify(row));
    await this.writeState();
    return row;
  }

  private async restore(): Promise<void> {
    const rows = await readInteractionRows(this.rows, this.options.runId);
    this.sequence = rows.length;
    const state = await readJSON<Record<string, unknown> | null>(path.join(this.directory, "capture.state.json"), null);
    if (!state) {
      this.failed = rows.length > 0;
      await this.writeState();
      return;
    }
    const parsed = parseCaptureState(state);
    for (const [rule, count] of parsed.redactions) this.redactions.set(rule, count);
    this.failed = parsed.failed || parsed.sequence !== rows.length;
    await this.writeState();
  }

  private writeState(): Promise<void> {
    return atomicWriteJSON(path.join(this.directory, "capture.state.json"), {
      schema_version: "1",
      sequence: this.sequence,
      failed: this.failed,
      redactions: [...this.redactions].sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
        .map(([rule_id, count]) => ({ rule_id, count })),
      updated_at: new Date().toISOString(),
    });
  }

  private redact(value: unknown, key?: string): unknown {
    if (key && (SENSITIVE_FIELD.test(key) || SENSITIVE_HEADER.test(key))) {
      this.increment("sensitive-field-v1");
      return "[REDACTED]";
    }
    if (Array.isArray(value)) return value.map((entry) => this.redact(entry));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, entry]) => [name, this.redact(entry, name)]));
    return typeof value === "string" ? this.redactText(value) : value;
  }

  private redactText(value: string): string {
    let result = value;
    for (const credential of this.credentials) {
      const parts = result.split(credential);
      const count = parts.length - 1;
      if (count > 0) result = parts.join("[REDACTED]");
      if (count > 0) this.increment("known-credential-value-v1", count);
    }
    for (const rule of TEXT_RULES) {
      let count = 0;
      result = result.replace(rule.pattern, () => { count += 1; return "[REDACTED]"; });
      if (count > 0) this.increment(rule.id, count);
    }
    return result;
  }

  private increment(rule: string, count = 1): void {
    this.redactions.set(rule, (this.redactions.get(rule) ?? 0) + count);
  }
}

async function readInteractionRows(file: string, runId: string): Promise<ModelInteractionV1[]> {
  let contents: string;
  try { contents = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await writePrivateFile(file, "");
      return [];
    }
    throw error;
  }
  const lines = contents.split(/\r?\n/).filter(Boolean);
  const rows = lines.map((line) => parseModelInteraction(JSON.parse(line) as unknown));
  if (rows.some((row, index) => row.run_id !== runId || row.sequence !== index + 1)) {
    throw new TypeError("persisted model interaction sequence is invalid");
  }
  return rows;
}

function parseCaptureState(value: Record<string, unknown>): { sequence: number; failed: boolean; redactions: Array<[string, number]> } {
  if (Object.keys(value).some((key) => !new Set(["schema_version", "sequence", "failed", "redactions", "updated_at"]).has(key))
    || value.schema_version !== "1" || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0
    || typeof value.failed !== "boolean" || !Array.isArray(value.redactions)
    || typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.updated_at))) {
    throw new TypeError("model interaction capture state is invalid");
  }
  const redactions = value.redactions.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("model interaction capture redaction state is invalid");
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "rule_id" && key !== "count") || typeof record.rule_id !== "string" || !record.rule_id
      || !Number.isSafeInteger(record.count) || (record.count as number) < 1) throw new TypeError("model interaction capture redaction state is invalid");
    return [record.rule_id, record.count] as [string, number];
  });
  return { sequence: value.sequence as number, failed: value.failed, redactions };
}

export function endpointIdentity(value: string): Sha256 {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new TypeError("model endpoint must be an absolute URL"); }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new TypeError("model endpoint protocol is unsupported");
  const port = endpoint.port && !((endpoint.protocol === "https:" && endpoint.port === "443") || (endpoint.protocol === "http:" && endpoint.port === "80"))
    ? `:${endpoint.port}` : "";
  const pathname = endpoint.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  return sha256JSON({ scheme: endpoint.protocol.slice(0, -1), host: endpoint.hostname.toLowerCase(), port, path: pathname });
}

function usage(value: Record<string, number>): Record<string, number> {
  const entries = Object.entries(value).sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)));
  if (entries.some(([key, entry]) => !key || !Number.isFinite(entry) || entry < 0)) throw new TypeError("model interaction usage is invalid");
  return Object.fromEntries(entries);
}

function httpStatus(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 599) throw new TypeError("model interaction HTTP status is invalid");
  return value;
}

function interactionIdValue(value: string): string {
  if (!/^interaction_[a-f0-9]{32}$/.test(value)) throw new TypeError("model interaction retry identity is invalid");
  return value;
}

function timestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${label} is invalid`);
  return value;
}

function bounded(value: string, max: number): string {
  const normalized = String(value).replace(/[\0\r\n]/g, " ").slice(0, max);
  if (!normalized) throw new TypeError("model interaction text field is empty");
  return normalized;
}
