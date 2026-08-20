import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import path from "node:path";
import { ensureDir } from "./fs.js";
import { SCHEMA_VERSION } from "./config.js";
import type { RunId } from "./domain/types.js";

export interface HitchEvent extends Record<string, unknown> {
  type: string;
  run_id?: RunId;
  eval_id?: string;
}

export class EventSink {
  readonly runDirectory: string;
  readonly runId: RunId;
  readonly onEvent: (event: HitchEvent) => void;
  private sequence = 0;
  private pending: Promise<void> = Promise.resolve();
  private events: WriteStream | undefined;
  private stdout: WriteStream | undefined;
  private stderr: WriteStream | undefined;
  private streamError: Error | undefined;

  constructor(runDirectory: string, runId: RunId, onEvent: (event: HitchEvent) => void = () => {}) {
    this.runDirectory = runDirectory;
    this.runId = runId;
    this.onEvent = onEvent;
  }

  async open(): Promise<void> {
    await ensureDir(this.runDirectory);
    this.events = createWriteStream(path.join(this.runDirectory, "events.jsonl"), { flags: "a", mode: 0o600 });
    this.stdout = createWriteStream(path.join(this.runDirectory, "stdout.log"), { flags: "a", mode: 0o600 });
    this.stderr = createWriteStream(path.join(this.runDirectory, "stderr.log"), { flags: "a", mode: 0o600 });
    for (const stream of [this.events, this.stdout, this.stderr]) {
      stream.on("error", (error: Error) => { this.streamError ||= error; });
    }
  }

  emit(event: Record<string, unknown>): HitchEvent {
    const framed: HitchEvent = {
      schema_version: SCHEMA_VERSION,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      run_id: this.runId,
      ...event,
      type: (event.type as string) || "event",
    };
    const line = `${JSON.stringify(framed)}\n`;
    this.pending = this.pending.then(() => writeChunk(this.events as WriteStream, line));
    try { this.onEvent(framed); } catch { /* Observers cannot break the persisted run lifecycle. */ }
    return framed;
  }

  writeStdout(line: string): void {
    this.pending = this.pending.then(() => writeChunk(this.stdout as WriteStream, `${line}\n`));
  }

  writeStderr(line: string): void {
    this.pending = this.pending.then(() => writeChunk(this.stderr as WriteStream, `${line}\n`));
  }

  async close(): Promise<void> {
    let failure: Error | undefined;
    try { await this.pending; } catch (error) { failure = error as Error; }
    const closed = await Promise.allSettled([closeStream(this.events), closeStream(this.stdout), closeStream(this.stderr)]);
    failure ||= this.streamError;
    failure ||= closed.find((result) => result.status === "rejected")?.reason as Error | undefined;
    if (failure) throw failure;
  }
}

function writeChunk(stream: WriteStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => error ? reject(error) : resolve());
  });
}

function closeStream(stream: WriteStream | undefined): Promise<void> {
  if (!stream) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}
