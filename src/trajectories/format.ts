/**
 * DSH-compatible on-disk format helpers for the canonical trajectory store:
 * session-id path encoding and project-key normalization, mirroring
 * `@deepseek-ai/dsh-session-persistence-jsonl` at the pinned contract commit
 * (spec §5.2, §5.3). V1 writes only raw JSONL (`compression: none`,
 * `packChunks: false`).
 */

import { join } from "node:path";
import { SESSION_FORMAT_VERSION, CONTRACT_COMMIT } from "./contract.js";
import type { SessionEvent, SessionHeaderLine } from "../domain/index.js";
import { validateSessionEvent, validateSessionHeaderLine } from "../domain/index.js";

export type JsonlCompression = "none";

export function logSuffix(_compression: JsonlCompression): ".jsonl" {
  return ".jsonl";
}

/**
 * Encode an arbitrary string as a single safe path segment, injectively over
 * all JS (UTF-16) strings. Mirrors DSH `encodeSegment`.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return out;
}

/** Decode a segment produced by {@link encodeSegment} back to the raw string. */
export function decodeSegment(encoded: string): string {
  let out = "";
  let i = 0;
  while (i < encoded.length) {
    const ch = encoded[i];
    if (ch === "~" && i + 5 <= encoded.length) {
      const hex = encoded.slice(i + 1, i + 5);
      const code = Number.parseInt(hex, 16);
      if (Number.isNaN(code)) {
        out += ch;
        i += 1;
      } else {
        out += String.fromCharCode(code);
        i += 5;
      }
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/**
 * Build the readable directory key for a project path, mirroring DSH
 * `projectKey`: separators become `-`, unsafe code units use `~XXXX`, bounded
 * to 251 chars, wrapped in `--`.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, "") || "root";
  return `--${slug.slice(0, 251)}--`;
}

export function projectDir(root: string, cwd: string | undefined): string {
  if (cwd === undefined) return join(root, "_no-cwd");
  return join(root, projectKey(cwd));
}

export function sessionDir(root: string, cwd: string | undefined, id: string): string {
  return join(projectDir(root, cwd), encodeSegment(id));
}

export function logPath(root: string, cwd: string | undefined, id: string): string {
  return join(sessionDir(root, cwd, id), `session${logSuffix("none")}`);
}

/**
 * Serialize the session header line (the immutable first logical line).
 */
export function headerLine(header: SessionHeaderLine): string {
  return `${JSON.stringify(header)}\n`;
}

/**
 * Serialize one session event as a JSONL line.
 */
export function eventLine(event: SessionEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function parseHeaderLine(value: unknown): SessionHeaderLine {
  const header = validateSessionHeaderLine(value);
  if (header.version !== SESSION_FORMAT_VERSION) {
    throw new Error(`unsupported session format version ${header.version}; expected ${SESSION_FORMAT_VERSION} at contract ${CONTRACT_COMMIT}`);
  }
  return header;
}

export function parseEventLine(value: unknown): SessionEvent {
  return validateSessionEvent(value);
}

export { SESSION_FORMAT_VERSION, CONTRACT_COMMIT };
