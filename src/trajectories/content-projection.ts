import { createHash } from "node:crypto";
import {
  PROVIDER_ENVIRONMENT_NAMES,
  credentialValuesFromEnv,
  isSensitiveFieldName,
  redactCredentialText,
} from "../foundation/index.js";

const REDACTION_OVERLAP_BYTES = 64 * 1024;
const UNIX_HOST_PATH = /(^|[\s"'`=:([\]{}<>])\/(?!\/)[A-Za-z0-9._~!$&()+,;@%:-]+(?:\/[A-Za-z0-9._~!$&()+,;=@%:-]+)*/gm;
const WINDOWS_HOST_PATH = /\b[A-Za-z]:\\(?:[^\\\s"'\`<>|]+\\)*[^\\\s"'\`<>|]*/g;
const UNC_HOST_PATH = /\\\\[^\\\s"'\`<>|]+\\[^\\\s"'\`<>|]+(?:\\[^\\\s"'\`<>|]+)*/g;
const WINDOWS_FORWARD_PATH = /\b[A-Za-z]:\/(?:[^/\s"'`<>|]+\/)*[^/\s"'`<>|]*/g;
const FORWARD_UNC_PATH = /(^|[\s"'`=([\]{}<>])\/\/[A-Za-z0-9._~!$&()+,;=@%:-]+(?:\/[A-Za-z0-9._~!$&()+,;=@%:-]+)+/gm;
const FILE_URI_PATH = /\bfile:\/\/(?:\/(?:[A-Za-z]:\/)?|[A-Za-z0-9._~-]+\/)[^\s"'`<>]+/gi;

/** Return the public field-path segment for a key, or null when the key itself must be redacted. */
export function fieldSegmentForKey(
  value: string,
  credentialValues: readonly string[],
  pathValues: readonly string[],
): string | null {
  if (isSensitiveFieldName(value)) return null;
  if (redactText(value, credentialValues, pathValues).text !== value) return null;
  return safeFieldSegment(value);
}

/** Event types are echoed in counts, filters, pages, and cursors, so they must be safe without rewriting. */
export function isPublicEventType(
  value: string,
  credentialValues: readonly string[],
  pathValues: readonly string[],
): boolean {
  return value.length > 0 && value.length <= 1_024
    && !isSensitiveFieldName(value)
    && redactText(value, credentialValues, pathValues).text === value;
}

export interface ContentExcerpt {
  preview: string;
  tail?: string;
  bytes: number;
  sha256: `sha256:${string}`;
  truncated: boolean;
  source: { run_id: string; seq: number; field: string };
}

export interface ContentProjectionContext {
  runId: string;
  seq: number;
  maxInlineBytes: number;
  previewBytes: number;
  tailBytes: number;
  credentialValues: readonly string[];
  pathValues: readonly string[];
  redactions: Map<string, number>;
}

export function defaultCredentialValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return credentialValuesFromEnv(PROVIDER_ENVIRONMENT_NAMES, env);
}

/** Redact every JSON key/value and replace individually large strings with verifiable excerpts. */
export function projectBoundedJson(value: unknown, context: ContentProjectionContext, field = "value"): unknown {
  if (typeof value === "string") return projectString(value, context, field);
  if (Array.isArray(value)) {
    return projectArray(value, context, field);
  }
  if (value && typeof value === "object") {
    return projectObject(value as Record<string, unknown>, context, field);
  }
  return value;
}

function projectArray(value: unknown[], context: ContentProjectionContext, field: string): unknown {
  const sink = new JsonEvidenceSink(context.previewBytes, context.tailBytes);
  let result: unknown[] | undefined = [];
  sink.append("[");
  value.forEach((entry, index) => {
    if (index > 0) sink.append(",");
    const projected = projectBoundedJson(entry, context, `${field}.${index}`);
    walkJson(projected, (token) => sink.append(token));
    result?.push(projected);
    if (sink.byteCount > context.maxInlineBytes) result = undefined;
  });
  sink.append("]");
  return result && sink.byteCount <= context.maxInlineBytes
    ? result
    : sink.excerpt({ run_id: context.runId, seq: context.seq, field });
}

function projectObject(
  value: Record<string, unknown>,
  context: ContentProjectionContext,
  field: string,
): unknown {
  const sink = new JsonEvidenceSink(context.previewBytes, context.tailBytes);
  let result: Record<string, unknown> | undefined = {};
  let redactedKeyIndex = 0;
  sink.append("{");
  let index = 0;
  for (const rawKey of Object.keys(value)) {
    const entry = value[rawKey];
    if (index > 0) sink.append(",");
    let key: string;
    let projected: unknown;
    if (isSensitiveFieldName(rawKey)) {
      redactedKeyIndex += 1;
      increment(context.redactions, "sensitive-field-v1");
      key = `[REDACTED_FIELD_${redactedKeyIndex}]`;
      projected = "[REDACTED]";
    } else {
      const keyRedaction = redactText(rawKey, context.credentialValues, context.pathValues);
      mergeRedactionCounts(context.redactions, keyRedaction.redactions);
      if (keyRedaction.text !== rawKey) {
        redactedKeyIndex += 1;
        key = `[REDACTED_KEY_${redactedKeyIndex}]`;
      } else {
        key = rawKey;
      }
      projected = projectBoundedJson(entry, context, `${field}.${safeFieldSegment(key)}`);
    }
    sink.append(JSON.stringify(key));
    sink.append(":");
    walkJson(projected, (token) => sink.append(token));
    if (result) defineJsonProperty(result, key, projected);
    if (sink.byteCount > context.maxInlineBytes) result = undefined;
    index += 1;
  }
  sink.append("}");
  return result && sink.byteCount <= context.maxInlineBytes
    ? result
    : sink.excerpt({ run_id: context.runId, seq: context.seq, field });
}

export function mergeRedactionCounts(
  target: Map<string, number>,
  entries: Iterable<readonly [string, number]> | Array<{ rule_id: string; count: number }>,
): void {
  if (Array.isArray(entries)) {
    for (const entry of entries) target.set(entry.rule_id, (target.get(entry.rule_id) ?? 0) + entry.count);
    return;
  }
  for (const [rule, count] of entries) target.set(rule, (target.get(rule) ?? 0) + count);
}

export function redactionEntries(redactions: Map<string, number>): Array<{ rule_id: string; count: number }> {
  return [...redactions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rule_id, count]) => ({ rule_id, count }));
}

/**
 * Bounded text fold which redacts before hashing or retaining excerpts. A
 * delimiter-aware overlap keeps credentials and host paths split across input
 * chunks in the same redaction window.
 */
export class BoundedTextAccumulator {
  private readonly hash = createHash("sha256");
  private preview = "";
  private tail = "";
  private byteCount = 0;
  private pending = "";
  private finalized = false;
  private suppressOversizedToken = false;

  constructor(
    private readonly previewLimit: number,
    private readonly tailLimit: number,
    private readonly credentialValues: readonly string[],
    private readonly pathValues: readonly string[],
    private readonly redactions: Map<string, number>,
  ) {}

  append(value: string): void {
    if (this.finalized) throw new Error("bounded text accumulator is already finalized");
    if (this.suppressOversizedToken) {
      const newline = value.search(/[\r\n]/);
      if (newline < 0) return;
      this.suppressOversizedToken = false;
      this.pending += value.slice(newline);
    } else {
      this.pending += value;
    }
    this.flushSafePrefix();
  }

  excerpt(input: { runId: string; seq: number; field: string }): ContentExcerpt {
    if (!this.finalized) {
      this.commitRedacted(this.pending);
      this.pending = "";
      this.finalized = true;
    }
    return {
      preview: this.preview,
      ...(this.byteCount > this.previewLimit && this.tail.length > 0 ? { tail: this.tail } : {}),
      bytes: this.byteCount,
      sha256: `sha256:${this.hash.digest("hex")}`,
      truncated: this.byteCount > Buffer.byteLength(this.preview),
      source: { run_id: input.runId, seq: input.seq, field: input.field },
    };
  }

  private flushSafePrefix(): void {
    while (Buffer.byteLength(this.pending) > REDACTION_OVERLAP_BYTES * 2) {
      const target = utf8Prefix(this.pending, Buffer.byteLength(this.pending) - REDACTION_OVERLAP_BYTES).length;
      let split = target;
      while (split > 0 && !/[\r\n]/.test(this.pending[split - 1] as string)) split -= 1;
      if (split === 0) {
        increment(this.redactions, "oversized-token-v1");
        this.commit("[REDACTED_OVERSIZED_TOKEN]");
        this.pending = "";
        this.suppressOversizedToken = true;
        return;
      }
      for (const credential of this.credentialValues) {
        const start = this.pending.lastIndexOf(credential, split);
        if (start >= 0 && start < split && start + credential.length > split) split = start;
      }
      const prefix = this.pending.slice(0, split);
      this.pending = this.pending.slice(split);
      this.commitRedacted(prefix);
    }
  }

  private commitRedacted(value: string): void {
    const redacted = redactText(value, this.credentialValues, this.pathValues);
    mergeRedactionCounts(this.redactions, redacted.redactions);
    this.commit(redacted.text);
  }

  private commit(value: string): void {
    const bytes = Buffer.byteLength(value);
    this.byteCount += bytes;
    this.hash.update(value);
    if (Buffer.byteLength(this.preview) < this.previewLimit) {
      this.preview += utf8Prefix(value, this.previewLimit - Buffer.byteLength(this.preview));
    }
    this.tail = utf8Suffix(`${this.tail}${value}`, this.tailLimit);
  }
}

/** Produce a bounded excerpt of already-redacted JSON without materializing the complete serialization. */
export function serializedJsonExcerpt(
  value: unknown,
  source: ContentExcerpt["source"],
  previewBytes: number,
  tailBytes: number,
): ContentExcerpt {
  const sink = new JsonEvidenceSink(previewBytes, tailBytes);
  walkJson(value, (token) => sink.append(token));
  return sink.excerpt(source);
}

function projectString(value: string, context: ContentProjectionContext, field: string): string | ContentExcerpt {
  const redacted = redactText(value, context.credentialValues, context.pathValues);
  mergeRedactionCounts(context.redactions, redacted.redactions);
  const bytes = Buffer.byteLength(redacted.text);
  if (bytes <= context.maxInlineBytes) return redacted.text;
  return {
    preview: utf8Prefix(redacted.text, context.previewBytes),
    ...(context.tailBytes > 0 ? { tail: utf8Suffix(redacted.text, context.tailBytes) } : {}),
    bytes,
    sha256: `sha256:${createHash("sha256").update(redacted.text).digest("hex")}`,
    truncated: true,
    source: { run_id: context.runId, seq: context.seq, field },
  };
}

export function sensitivePathValues(sourcePath: string): string[] {
  const marker = `${pathSeparator()}trajectory${pathSeparator()}`;
  const markerIndex = sourcePath.lastIndexOf(marker);
  const runDirectory = markerIndex >= 0 ? sourcePath.slice(0, markerIndex) : "";
  return [...new Set([sourcePath, runDirectory].filter((entry) => entry.length > 1))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function redactText(value: string, credentialValues: readonly string[], pathValues: readonly string[]) {
  const redacted = redactCredentialText(value, credentialValues);
  let text = redacted.text;
  let pathCount = 0;
  for (const sensitive of pathValues) {
    if (!text.includes(sensitive)) continue;
    const parts = text.split(sensitive);
    pathCount += parts.length - 1;
    text = parts.join("[REDACTED_PATH]");
  }
  text = text.replace(FILE_URI_PATH, () => {
    pathCount += 1;
    return "[REDACTED_PATH]";
  });
  text = text.replace(WINDOWS_FORWARD_PATH, () => {
    pathCount += 1;
    return "[REDACTED_PATH]";
  });
  text = text.replace(FORWARD_UNC_PATH, (_match, prefix: string) => {
    pathCount += 1;
    return `${prefix}[REDACTED_PATH]`;
  });
  text = text.replace(UNIX_HOST_PATH, (_match, prefix: string) => {
    pathCount += 1;
    return `${prefix}[REDACTED_PATH]`;
  });
  for (const pattern of [WINDOWS_HOST_PATH, UNC_HOST_PATH]) {
    text = text.replace(pattern, () => {
      pathCount += 1;
      return "[REDACTED_PATH]";
    });
  }
  if (pathCount > 0) redacted.redactions.set("host-path-v1", pathCount);
  return { text, redactions: redacted.redactions };
}

class JsonEvidenceSink {
  private readonly hash = createHash("sha256");
  private preview = "";
  private tail = "";
  private bytes = 0;

  constructor(private readonly previewLimit: number, private readonly tailLimit: number) {}

  get byteCount(): number {
    return this.bytes;
  }

  append(token: string): void {
    this.hash.update(token);
    this.bytes += Buffer.byteLength(token);
    if (Buffer.byteLength(this.preview) < this.previewLimit) {
      this.preview += utf8Prefix(token, this.previewLimit - Buffer.byteLength(this.preview));
    }
    this.tail = utf8Suffix(`${this.tail}${token}`, this.tailLimit);
  }

  excerpt(source: ContentExcerpt["source"]): ContentExcerpt {
    return {
      preview: this.preview,
      ...(this.bytes > this.previewLimit && this.tail.length > 0 ? { tail: this.tail } : {}),
      bytes: this.bytes,
      sha256: `sha256:${this.hash.digest("hex")}`,
      truncated: this.bytes > Buffer.byteLength(this.preview),
      source,
    };
  }
}

function walkJson(value: unknown, emit: (token: string) => void): void {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    emit(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    emit("[");
    value.forEach((entry, index) => {
      if (index > 0) emit(",");
      walkJson(entry, emit);
    });
    emit("]");
    return;
  }
  if (value && typeof value === "object") {
    emit("{");
    Object.entries(value as Record<string, unknown>).forEach(([key, entry], index) => {
      if (index > 0) emit(",");
      emit(JSON.stringify(key));
      emit(":");
      walkJson(entry, emit);
    });
    emit("}");
    return;
  }
  throw new TypeError("projected value is not JSON serializable");
}

function defineJsonProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function safeFieldSegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : `[field:${createHash("sha256").update(value).digest("hex").slice(0, 12)}]`;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && isHighSurrogate(value.charCodeAt(low - 1))) low -= 1;
  return value.slice(0, low);
}

function utf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(value.slice(middle)) <= maxBytes) high = middle;
    else low = middle + 1;
  }
  if (low < value.length && isLowSurrogate(value.charCodeAt(low))) low += 1;
  return value.slice(low);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
