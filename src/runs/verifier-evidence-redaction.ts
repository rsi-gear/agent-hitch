import type { JsonValue } from "../domain/index.js";
import { redactCredentialText } from "../foundation/index.js";

const FILE_URL = /file:\/\/\/[^\s"'<>]+/g;
const POSIX_ABSOLUTE_PATH = /(?<![A-Za-z0-9:+/])\/(?:[^\s"'<>:,;{}\[\]()]+\/?)+/g;
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:\\(?:[^\\\s"'<>|:]+\\?)+/g;
const WINDOWS_FORWARD_PATH = /\b[A-Za-z]:\/(?:[^/\s"'<>|:]+\/?)+/g;
const WINDOWS_EXTENDED_DRIVE_PATH = /\\\\\?\\[A-Za-z]:\\(?:[^\\\s"'<>|:]+\\?)+/g;
const WINDOWS_UNC_PATH = /(?:\\\\|\\\\\?\\)[^\\\s"'<>|:]+\\[^\s"'<>|:]+/g;

export function sanitizeVerifierText(
  value: string,
  credentialValues: readonly string[],
): { text: string; redactions: Map<string, number> } {
  const credentialSafe = redactCredentialText(value, credentialValues);
  let count = 0;
  const text = credentialSafe.text
    .replace(FILE_URL, () => { count += 1; return "[path]"; })
    .replace(WINDOWS_EXTENDED_DRIVE_PATH, () => { count += 1; return "[path]"; })
    .replace(WINDOWS_UNC_PATH, () => { count += 1; return "[path]"; })
    .replace(WINDOWS_ABSOLUTE_PATH, () => { count += 1; return "[path]"; })
    .replace(WINDOWS_FORWARD_PATH, () => { count += 1; return "[path]"; })
    .replace(POSIX_ABSOLUTE_PATH, () => { count += 1; return "[path]"; });
  const redactions = new Map(credentialSafe.redactions);
  if (count > 0) redactions.set("absolute-path-v1", count);
  return { text, redactions };
}

export function sanitizeVerifierJson(
  value: JsonValue,
  credentialValues: readonly string[],
): { value: JsonValue; redactions: Map<string, number> } {
  const redactions = new Map<string, number>();
  const visit = (entry: JsonValue): JsonValue => {
    if (typeof entry === "string") {
      const safe = sanitizeVerifierText(entry, credentialValues);
      merge(redactions, safe.redactions);
      return safe.text;
    }
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry && typeof entry === "object") {
      const result: Array<[string, JsonValue]> = [];
      const keys = new Set<string>();
      for (const [key, child] of Object.entries(entry)) {
        const safeKey = sanitizeVerifierText(key, credentialValues);
        merge(redactions, safeKey.redactions);
        let uniqueKey = safeKey.text;
        for (let suffix = 2; keys.has(uniqueKey); suffix += 1) uniqueKey = `${safeKey.text}#${suffix}`;
        keys.add(uniqueKey);
        result.push([uniqueKey, visit(child)]);
      }
      return Object.fromEntries(result);
    }
    return entry;
  };
  return { value: visit(value), redactions };
}

function merge(target: Map<string, number>, source: Map<string, number>): void {
  for (const [rule, count] of source) target.set(rule, (target.get(rule) ?? 0) + count);
}
