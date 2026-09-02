import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import type { EvalId } from "../domain/index.js";
import { SCHEMA_VERSION, ensureDir } from "../foundation/index.js";

export const MAX_EVAL_EVENT_BYTES = 64 * 1024;

export class EvalEventSink {
  readonly path: string;
  private readonly evalId: EvalId;
  private readonly onEvent: (event: Record<string, unknown>) => void;
  private sequence = 0;
  private pending: Promise<void> = Promise.resolve();
  private stream: WriteStream | undefined;
  private streamError: Error | undefined;

  constructor(evalDirectory: string, evalId: EvalId, onEvent: (event: Record<string, unknown>) => void = () => {}) {
    this.path = path.join(evalDirectory, "events.jsonl");
    this.evalId = evalId;
    this.onEvent = onEvent || (() => {});
  }

  async open(): Promise<void> {
    await ensureDir(path.dirname(this.path));
    this.sequence = await lastCommittedSequence(this.path);
    this.stream = createWriteStream(this.path, { flags: "a", mode: 0o600 });
    this.stream.on("error", (error: Error) => { this.streamError ||= error; });
  }

  emit(event: Record<string, unknown>): Record<string, unknown> {
    const identity = {
      schema_version: SCHEMA_VERSION,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      eval_id: this.evalId,
    };
    const framed = { ...identity, ...event };
    const encoded = JSON.stringify(framed);
    const persisted = Buffer.byteLength(encoded) <= MAX_EVAL_EVENT_BYTES
      ? framed
      : {
          ...identity,
          type: boundedType(event.type),
          truncated: true,
          original_bytes: Buffer.byteLength(encoded),
        };
    this.pending = this.pending.then(() => writeChunk(this.stream as WriteStream, `${JSON.stringify(persisted)}\n`));
    try { this.onEvent(persisted); } catch { /* Observers cannot break eval persistence. */ }
    return persisted;
  }

  async close(): Promise<void> {
    let failure: Error | undefined;
    try { await this.pending; } catch (error) { failure = error as Error; }
    try { await closeStream(this.stream); } catch (error) { failure ||= error as Error; }
    failure ||= this.streamError;
    if (failure) throw failure;
  }
}

function boundedType(value: unknown): string {
  const type = typeof value === "string" && value ? value : "eval.event.truncated";
  return type.slice(0, 256);
}

async function lastCommittedSequence(file: string): Promise<number> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (size === 0) return 0;
  const handle = await open(file, "r");
  try {
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    const committed = buffer.subarray(0, bytesRead).toString("utf8").replace(/[^\n]*$/, "");
    const lines = committed.trimEnd().split("\n");
    const last = lines.at(-1);
    if (!last) return 0;
    const parsed = JSON.parse(last) as { sequence?: unknown };
    if (!Number.isSafeInteger(parsed.sequence) || (parsed.sequence as number) < 0) {
      throw new TypeError("eval event sequence is invalid");
    }
    return parsed.sequence as number;
  } finally {
    await handle.close();
  }
}

function writeChunk(stream: WriteStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => stream.write(chunk, (error) => error ? reject(error) : resolve()));
}

function closeStream(stream: WriteStream | undefined): Promise<void> {
  if (!stream) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}
