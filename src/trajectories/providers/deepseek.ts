import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { SessionEvent, SessionHeaderLine, TrajectoryFileRefV1 } from "../../domain/index.js";
import { writePrivateFile } from "../../foundation/index.js";
import { parseEventLine, parseHeaderLine } from "../format.js";
import { redactProviderJSON } from "../provider-capture.js";
import { finalizeInterruptedTrajectory, validateTrajectoryInvariants } from "../store.js";

const CANONICAL_EVENT_TYPES = new Set([
  "turn/start", "turn/end", "step/start", "step/end",
  "request/header", "user/message", "assistant/chunk", "assistant/message",
  "tool/call", "tool/result",
]);

export interface DeepseekNativeSession {
  header: SessionHeaderLine;
  events: SessionEvent[];
  providerSessionId: string;
  providerFiles: TrajectoryFileRefV1[];
  redactions: Array<{ rule_id: string; count: number }>;
  finalOutput: string;
  effectiveModel?: string;
}

/**
 * Import the session flushed by DSH's headless profile. The original,
 * redacted JSONL is retained as provider evidence; the canonical copy keeps
 * DSH's native timestamps and structured events, while marking DSH-internal
 * extension events as ignorable under the shared session contract.
 */
export async function importDeepseekNativeSession(options: {
  runtimeHome: string;
  runDirectory: string;
  runId: string;
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  credentialValues?: readonly string[];
}): Promise<DeepseekNativeSession | null> {
  const located = await findSessionFiles(path.join(options.runtimeHome, "sessions"));
  if (located.compressed.length > 0) {
    throw new Error("DeepSeek wrote a compressed native session despite Hitch's compression:none runtime patch");
  }
  if (located.jsonl.length === 0) return null;
  const sessions = await Promise.all(located.jsonl.map((source) => readNativeSession(source, options.credentialValues ?? [])));
  const roots = sessions.filter((session) => session.header.parentSession === undefined);
  if (roots.length !== 1) {
    throw new Error(`DeepSeek wrote ${roots.length} root native sessions for one run; refusing an ambiguous import`);
  }
  const primary = roots[0] as ParsedNativeSession;
  const header: SessionHeaderLine = { ...primary.header, id: options.runId };
  const events = options.status === "succeeded"
    ? primary.events
    : finalizeInterruptedTrajectory(header, primary.events, options.status);
  if (options.status === "succeeded") validateTrajectoryInvariants(header, events);

  const ordered = [primary, ...sessions.filter((session) => session !== primary)];
  const providerFiles: TrajectoryFileRefV1[] = [];
  const redactionCounts = new Map<string, number>();
  for (let index = 0; index < ordered.length; index += 1) {
    const session = ordered[index] as ParsedNativeSession;
    const relativePath = index === 0
      ? "trajectory/provider/deepseek-session.jsonl"
      : `trajectory/provider/deepseek-child-session-${index}.jsonl`;
    const target = path.join(options.runDirectory, ...relativePath.split("/"));
    const providerContent = `${session.providerRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await writePrivateFile(target, providerContent);
    const info = await stat(target);
    const digest = createHash("sha256").update(providerContent).digest("hex");
    providerFiles.push({
      role: "provider_events",
      path: relativePath,
      media_type: "application/x-ndjson",
      sha256: `sha256:${digest}`,
      bytes: info.size,
    });
    for (const [rule, count] of session.redactions) {
      redactionCounts.set(rule, (redactionCounts.get(rule) || 0) + count);
    }
  }

  const result: DeepseekNativeSession = {
    header,
    events,
    providerSessionId: primary.header.id,
    providerFiles,
    redactions: [...redactionCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([rule_id, count]) => ({ rule_id, count })),
    finalOutput: lastAssistantText(events),
  };
  const effectiveModel = lastEffectiveModel(events);
  if (effectiveModel) result.effectiveModel = effectiveModel;
  return result;
}

interface ParsedNativeSession {
  header: SessionHeaderLine;
  events: SessionEvent[];
  providerRows: unknown[];
  redactions: Map<string, number>;
}

async function readNativeSession(source: string, credentialValues: readonly string[]): Promise<ParsedNativeSession> {
  const input = await readFile(source, "utf8");
  const lines = input.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error(`DeepSeek native session is empty: ${source}`);
  const redactions = new Map<string, number>();
  const providerRows: unknown[] = [];
  const redact = (value: unknown): unknown => {
    const result = redactProviderJSON(value, credentialValues);
    for (const [rule, count] of result.redactions) {
      redactions.set(rule, (redactions.get(rule) || 0) + count);
    }
    providerRows.push(result.value);
    return result.value;
  };
  const header = parseHeaderLine(redact(parseJSON(lines[0] as string, 1)));
  const events: SessionEvent[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const parsed = parseEventLine(redact(parseJSON(lines[index] as string, index + 1)));
    const expected = index - 1;
    if (parsed.seq !== expected) {
      throw new Error(`DeepSeek native session seq must be contiguous: expected ${expected}, got ${parsed.seq}`);
    }
    events.push(CANONICAL_EVENT_TYPES.has(parsed.type) ? parsed : { ...parsed, ignorable: true });
  }
  return { header, events, providerRows, redactions };
}

function parseJSON(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(`invalid DeepSeek native session JSON at line ${lineNumber}`, { cause: error });
  }
}

async function findSessionFiles(root: string): Promise<{ jsonl: string[]; compressed: string[] }> {
  const result = { jsonl: [] as string[], compressed: [] as string[] };
  let rootInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return result;

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error("DeepSeek native session directory nesting is unexpectedly deep");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(candidate, depth + 1);
      } else if (entry.isFile() && entry.name === "session.jsonl") {
        result.jsonl.push(candidate);
      } else if (entry.isFile() && entry.name === "session.jsonl.zstd") {
        result.compressed.push(candidate);
      }
    }
  };
  await visit(root, 0);
  result.jsonl.sort();
  result.compressed.sort();
  return result;
}

function lastAssistantText(events: SessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent;
    if (event.type !== "assistant/message") continue;
    const data = event.data as Record<string, unknown>;
    const message = data.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const text = content
      .filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object" && !Array.isArray(block))
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    if (text) return text;
  }
  return "";
}

function lastEffectiveModel(events: SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent;
    if (event.type !== "assistant/message") continue;
    const data = event.data as Record<string, unknown>;
    const message = data.message as Record<string, unknown> | undefined;
    const source = message?.source as Record<string, unknown> | undefined;
    if (typeof source?.model === "string" && source.model.trim()) return source.model.trim();
  }
  return undefined;
}
