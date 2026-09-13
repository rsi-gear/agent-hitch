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
  // Select a likely root only to preserve established evidence filenames.
  // All redacted rows are saved before any format or relational validation.
  const rootCandidates = sessions.filter((session) => {
    const first = session.providerRows[0];
    return first && typeof first === "object" && !Array.isArray(first)
      && (first as Record<string, unknown>).parentSession === undefined;
  });
  const first = rootCandidates.length === 1 ? rootCandidates[0] : sessions[0];
  const ordered = [first as CapturedNativeSession, ...sessions.filter((session) => session !== first)];
  const providerFiles: TrajectoryFileRefV1[] = [];
  const redactionCounts = new Map<string, number>();
  for (let index = 0; index < ordered.length; index += 1) {
    const session = ordered[index] as CapturedNativeSession;
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

  const parsed = ordered.map(parseNativeSession);
  const roots = parsed.filter((session) => session.header.parentSession === undefined);
  if (roots.length !== 1) {
    throw new Error(`DeepSeek wrote ${roots.length} root native sessions for one run; refusing an ambiguous import`);
  }
  const primary = roots[0] as ParsedNativeSession;
  const header: SessionHeaderLine = { ...primary.header, id: options.runId };
  const events = options.status === "succeeded"
    ? primary.events
    : finalizeInterruptedTrajectory(header, primary.events, options.status);
  if (options.status === "succeeded") validateTrajectoryInvariants(header, events);

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
}

interface CapturedNativeSession {
  providerRows: unknown[];
  redactions: Map<string, number>;
  invalidJSONLine?: number;
}

async function readNativeSession(source: string, credentialValues: readonly string[]): Promise<CapturedNativeSession> {
  const input = await readFile(source, "utf8");
  const lines = input.split(/\r?\n/);
  const captured: CapturedNativeSession = { providerRows: [], redactions: new Map() };
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      captured.invalidJSONLine ??= index + 1;
      // Never retain unparsed text: escaped credentials may evade text redaction.
      captured.providerRows.push({ hitch_envelope: { kind: "invalid_native_json", line: index + 1 } });
      continue;
    }
    const result = redactProviderJSON(value, credentialValues);
    for (const [rule, count] of result.redactions) {
      captured.redactions.set(rule, (captured.redactions.get(rule) || 0) + count);
    }
    captured.providerRows.push(result.value);
  }
  return captured;
}

function parseNativeSession(session: CapturedNativeSession): ParsedNativeSession {
  if (session.invalidJSONLine !== undefined) throw new Error(`invalid DeepSeek native session JSON at line ${session.invalidJSONLine}`);
  if (session.providerRows.length === 0) throw new Error("DeepSeek native session is empty");
  const header = parseHeaderLine(session.providerRows[0]);
  const events = session.providerRows.slice(1).map((row, expected): SessionEvent => {
    const parsed = parseEventLine(row);
    if (parsed.seq !== expected) {
      throw new Error(`DeepSeek native session seq must be contiguous: expected ${expected}, got ${parsed.seq}`);
    }
    return CANONICAL_EVENT_TYPES.has(parsed.type) ? parsed : { ...parsed, ignorable: true };
  });
  return { header, events };
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
