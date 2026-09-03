import type { SessionEvent } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";

const SURFACE_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);

export interface SurfaceReplacement {
  seq: number;
  start: number;
  end: number;
  shadowed_seqs: number[];
}

/** Incremental counterpart of DSH foldSurface(), without retaining the raw log. */
export class IncrementalSurfaceFold {
  private readonly current: number[] = [];
  private readonly nodeTypes = new Map<number, string>();
  private readonly toolResultSignatures = new Map<number, string>();
  private operationCount = 0;
  readonly replacements: SurfaceReplacement[] = [];

  get revision(): number {
    return this.operationCount;
  }

  get currentNodeSeqs(): number[] {
    return [...this.current];
  }

  accept(event: SessionEvent): void {
    const eligible = SURFACE_TYPES.has(event.type);
    if (!eligible) {
      if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) {
        throw new Error(`session event at seq ${event.seq} is not surface-eligible and cannot carry surface metadata`);
      }
      return;
    }
    if (event.surfaceOp === undefined) {
      throw new Error(`surface-eligible event at seq ${event.seq} requires a surfaceOp marker`);
    }
    if (event.surfaceOp === "append") {
      assertProvenance(event, []);
      this.current.push(event.seq);
      this.rememberNode(event);
      this.operationCount += 1;
      return;
    }
    const { start, end } = event.surfaceOp;
    if (!isEventSeq(start) || !isEventSeq(end)) throw new Error(`invalid surface replacement at seq ${event.seq}`);
    const startIndex = this.current.indexOf(start);
    const endIndex = this.current.indexOf(end);
    if (startIndex < 0) throw new Error(`surface replace: start seq ${start} not found in surface`);
    if (endIndex < 0) throw new Error(`surface replace: end seq ${end} not found in surface`);
    if (startIndex > endIndex) throw new Error(`surface replace: start seq ${start} is after end seq ${end}`);
    const shadowed = this.current.slice(startIndex, endIndex + 1);
    assertProvenance(event, shadowed);
    this.assertToolResultRewrite(event, shadowed);
    for (const seq of shadowed) {
      this.nodeTypes.delete(seq);
      this.toolResultSignatures.delete(seq);
    }
    this.current.splice(startIndex, endIndex - startIndex + 1, event.seq);
    this.rememberNode(event);
    this.replacements.push({ seq: event.seq, start, end, shadowed_seqs: shadowed });
    this.operationCount += 1;
  }

  private rememberNode(event: SessionEvent): void {
    this.nodeTypes.set(event.seq, event.type);
    if (event.type === "tool/result") this.toolResultSignatures.set(event.seq, toolResultSignature(event));
  }

  private assertToolResultRewrite(event: SessionEvent, shadowed: number[]): void {
    if (event.type !== "tool/result") return;
    if (shadowed.length !== 1 || this.nodeTypes.get(shadowed[0] as number) !== "tool/result") {
      throw new Error("tool/result surface replacement must rewrite exactly one current tool/result");
    }
    const original = this.toolResultSignatures.get(shadowed[0] as number);
    if (original === undefined || original !== toolResultSignature(event)) {
      throw new Error("tool/result surface replacement may change only content");
    }
  }
}

export function deriveSurfaceMessage(event: SessionEvent): unknown {
  const data = event.data as Record<string, unknown>;
  if (event.type === "user/message") return data;
  if (event.type === "assistant/message") {
    const message = data.message as Record<string, unknown> | undefined;
    const content = message?.content;
    return Array.isArray(content) && content.length === 0 ? null : message ?? null;
  }
  if (event.type === "tool/result") return data.message ?? null;
  return null;
}

export function isSurfaceEvent(event: SessionEvent): boolean {
  return SURFACE_TYPES.has(event.type);
}

function assertProvenance(event: SessionEvent, shadowed: number[]): void {
  const raw = event.sourceEventSeqs;
  const sources = new Set<number>();
  if (raw !== undefined) {
    if (raw.length === 0 && event.type !== "assistant/message") {
      throw new Error("sourceEventSeqs must not be empty except on assistant/message");
    }
    for (const source of raw) {
      if (!isEventSeq(source)) throw new Error(`invalid sourceEventSeqs on event at seq ${event.seq}`);
      if (source >= event.seq) throw new Error(`sourceEventSeqs must reference earlier events: ${source} >= ${event.seq}`);
      if (sources.has(source)) throw new Error("sourceEventSeqs must not contain duplicates");
      sources.add(source);
    }
  }
  const missing = shadowed.filter((seq) => !sources.has(seq));
  if (missing.length > 0) {
    throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(", ")}`);
  }
}

function toolResultSignature(event: SessionEvent): string {
  const data = event.data as Record<string, unknown>;
  const message = data.message && typeof data.message === "object" && !Array.isArray(data.message)
    ? data.message as Record<string, unknown>
    : {};
  const content = Array.isArray(message.content) ? message.content : [];
  const first = content[0] && typeof content[0] === "object" && !Array.isArray(content[0])
    ? { ...(content[0] as Record<string, unknown>), content: null }
    : content[0];
  return sha256JSON({ ...data, message: { ...message, content: content.length > 0 ? [first, ...content.slice(1)] : [] } });
}

function isEventSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
