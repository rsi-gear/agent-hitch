import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import path from "node:path";
import type { EvalId } from "../domain/index.js";
import { SCHEMA_VERSION, ensureDir } from "../foundation/index.js";

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
    this.stream = createWriteStream(this.path, { flags: "a", mode: 0o600 });
    this.stream.on("error", (error: Error) => { this.streamError ||= error; });
  }

  emit(event: Record<string, unknown>): Record<string, unknown> {
    const framed = {
      schema_version: SCHEMA_VERSION,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      eval_id: this.evalId,
      ...event,
    };
    this.pending = this.pending.then(() => writeChunk(this.stream as WriteStream, `${JSON.stringify(framed)}\n`));
    try { this.onEvent(framed); } catch { /* Observers cannot break eval persistence. */ }
    return framed;
  }

  async close(): Promise<void> {
    let failure: Error | undefined;
    try { await this.pending; } catch (error) { failure = error as Error; }
    try { await closeStream(this.stream); } catch (error) { failure ||= error as Error; }
    failure ||= this.streamError;
    if (failure) throw failure;
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
