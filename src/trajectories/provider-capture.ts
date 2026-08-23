import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { TrajectoryFileRefV1 } from "../domain/index.js";
import { ensureDir } from "../foundation/index.js";

const SENSITIVE_FIELD = /(?:^|[_-])(?:api[_-]?key|authorization|token|secret|password|credential|cookie)(?:$|[_-])/i;
const SECRET_TEXT_RULES: Array<{ id: string; pattern: RegExp; replacement: string }> = [
  { id: "authorization-bearer-v1", pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, replacement: "Bearer [REDACTED]" },
  { id: "provider-api-key-v1", pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, replacement: "[REDACTED]" },
];

export interface RedactionResult<T> {
  value: T;
  redactions: Map<string, number>;
}

function increment(redactions: Map<string, number>, rule: string, count = 1): void {
  redactions.set(rule, (redactions.get(rule) || 0) + count);
}

export function redactProviderJSON(value: unknown): RedactionResult<unknown> {
  const redactions = new Map<string, number>();
  const visit = (current: unknown, key?: string): unknown => {
    if (key && SENSITIVE_FIELD.test(key)) {
      increment(redactions, "sensitive-field-v1");
      return "[REDACTED]";
    }
    if (Array.isArray(current)) return current.map((entry) => visit(entry));
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current as Record<string, unknown>).map(([entryKey, entry]) => [entryKey, visit(entry, entryKey)]));
    }
    if (typeof current === "string") return redactProviderText(current, redactions);
    return current;
  };
  return { value: visit(value), redactions };
}

export function redactProviderText(value: string, existing = new Map<string, number>()): string {
  let output = value;
  for (const rule of SECRET_TEXT_RULES) {
    let count = 0;
    output = output.replace(rule.pattern, () => {
      count += 1;
      return rule.replacement;
    });
    if (count > 0) increment(existing, rule.id, count);
  }
  return output;
}

export interface ProviderCaptureOptions {
  runDirectory: string;
  structured: boolean;
}

/** Append-only capture of provider output before canonical projection. */
export class ProviderCaptureWriter {
  private readonly target: string;
  private readonly relativePath: string;
  private readonly structured: boolean;
  private readonly stream: WriteStream;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly counts = new Map<string, number>();
  private streamError: Error | undefined;

  private constructor(target: string, relativePath: string, structured: boolean, stream: WriteStream) {
    this.target = target;
    this.relativePath = relativePath;
    this.structured = structured;
    this.stream = stream;
    stream.on("error", (error: Error) => { this.streamError ||= error; });
  }

  static async open(options: ProviderCaptureOptions): Promise<ProviderCaptureWriter> {
    const relativePath = options.structured
      ? "trajectory/provider/events.jsonl"
      : "trajectory/provider/transcript.txt";
    const target = path.join(options.runDirectory, ...relativePath.split("/"));
    await ensureDir(path.dirname(target));
    return new ProviderCaptureWriter(target, relativePath, options.structured, createWriteStream(target, { flags: "ax", mode: 0o600 }));
  }

  appendJSON(value: unknown): unknown {
    if (!this.structured) throw new Error("provider capture is not in structured mode");
    const redacted = redactProviderJSON(value);
    this.merge(redacted.redactions);
    this.enqueue(`${JSON.stringify(redacted.value)}\n`);
    return redacted.value;
  }

  appendUnparsed(line: string): string {
    if (!this.structured) return this.appendText(line);
    const safe = redactProviderText(line, this.counts);
    this.enqueue(`${JSON.stringify({ hitch_envelope: { kind: "unparsed_provider_line" }, provider_payload: { text: safe } })}\n`);
    return safe;
  }

  appendText(line: string): string {
    if (this.structured) throw new Error("provider capture is in structured mode");
    const safe = redactProviderText(line, this.counts);
    this.enqueue(`${safe}\n`);
    return safe;
  }

  private merge(redactions: Map<string, number>): void {
    for (const [rule, count] of redactions) increment(this.counts, rule, count);
  }

  private enqueue(chunk: string): void {
    if (this.closed) throw new Error("provider capture writer is closed");
    this.pending = this.pending.then(() => new Promise<void>((resolve, reject) => {
      this.stream.write(chunk, (error) => error ? reject(error) : resolve());
    }));
  }

  async close(): Promise<{ file: TrajectoryFileRefV1; redactions: Array<{ rule_id: string; count: number }> }> {
    if (!this.closed) {
      this.closed = true;
      await this.pending;
      await closeStream(this.stream);
    }
    if (this.streamError) throw this.streamError;
    const info = await stat(this.target);
    const digest = createHash("sha256").update(await readFile(this.target)).digest("hex");
    return {
      file: {
        role: this.structured ? "provider_events" : "provider_transcript",
        path: this.relativePath,
        media_type: this.structured ? "application/x-ndjson" : "text/plain; charset=utf-8",
        sha256: `sha256:${digest}`,
        bytes: info.size,
      },
      redactions: [...this.counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([rule_id, count]) => ({ rule_id, count })),
    };
  }
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}
