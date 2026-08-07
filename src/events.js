import { createWriteStream } from "node:fs";
import path from "node:path";
import { ensureDir } from "./fs.js";
import { SCHEMA_VERSION } from "./config.js";

export class EventSink {
  constructor(runDirectory, runId, onEvent = () => {}) {
    this.runDirectory = runDirectory;
    this.runId = runId;
    this.onEvent = onEvent;
    this.sequence = 0;
    this.pending = Promise.resolve();
  }

  async open() {
    await ensureDir(this.runDirectory);
    this.events = createWriteStream(path.join(this.runDirectory, "events.jsonl"), { flags: "a", mode: 0o600 });
    this.stdout = createWriteStream(path.join(this.runDirectory, "stdout.log"), { flags: "a", mode: 0o600 });
    this.stderr = createWriteStream(path.join(this.runDirectory, "stderr.log"), { flags: "a", mode: 0o600 });
    for (const stream of [this.events, this.stdout, this.stderr]) {
      stream.on("error", (error) => { this.streamError ||= error; });
    }
  }

  emit(event) {
    const framed = {
      schema_version: SCHEMA_VERSION,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      run_id: this.runId,
      ...event,
    };
    const line = `${JSON.stringify(framed)}\n`;
    this.pending = this.pending.then(() => writeChunk(this.events, line));
    try { this.onEvent(framed); } catch { /* Observers cannot break the persisted run lifecycle. */ }
    return framed;
  }

  writeStdout(line) {
    this.pending = this.pending.then(() => writeChunk(this.stdout, `${line}\n`));
  }

  writeStderr(line) {
    this.pending = this.pending.then(() => writeChunk(this.stderr, `${line}\n`));
  }

  async close() {
    let failure;
    try { await this.pending; } catch (error) { failure = error; }
    const closed = await Promise.allSettled([closeStream(this.events), closeStream(this.stdout), closeStream(this.stderr)]);
    failure ||= this.streamError;
    failure ||= closed.find((result) => result.status === "rejected")?.reason;
    if (failure) throw failure;
  }
}

function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => error ? reject(error) : resolve());
  });
}

function closeStream(stream) {
  if (!stream) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}
