import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { redactCredentialText } from "../foundation/index.js";

const HITCH_BRIDGE_ERROR_MAX_BYTES = 64 * 1024;
const HITCH_BRIDGE_ERROR_MESSAGE_MAX_BYTES = 2048;
const HITCH_BRIDGE_ERROR_CODES = new Set([
  "hitch_workdir_invalid",
  "hitch_process_failed",
  "hitch_result_missing",
  "hitch_result_not_file",
  "hitch_result_read_failed",
  "hitch_result_empty",
  "hitch_result_invalid_json",
  "hitch_result_schema_invalid",
  "hitch_result_run_id_mismatch",
  "hitch_revision_identity_mismatch",
  "hitch_run_bundle_export_failed",
  "hitch_result_artifact_copy_failed",
]);

export interface HarborBridgeErrorDiagnostic {
  code: string;
  message: string;
  raw: string;
}

/** Read a Harbor bridge diagnostic as untrusted, bounded evidence. */
export async function readHarborBridgeError(trialDirectory: string, credentialValues: readonly string[] = []): Promise<HarborBridgeErrorDiagnostic | null> {
  const source = path.join(trialDirectory, "agent", "hitch-bridge-error.json");
  try {
    const info = await lstat(source);
    if (!info.isFile() || info.size <= 0 || info.size > HITCH_BRIDGE_ERROR_MAX_BYTES) return null;
    const raw = await readFile(source, "utf8");
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const diagnostic = sanitizeEvidence(value, credentialValues) as Record<string, unknown>;
    if (diagnostic.schema_version !== "1") return null;
    if (typeof diagnostic.code !== "string" || !HITCH_BRIDGE_ERROR_CODES.has(diagnostic.code)) return null;
    if (typeof diagnostic.message !== "string" || !diagnostic.message.trim()) return null;
    if (Buffer.byteLength(diagnostic.message, "utf8") > HITCH_BRIDGE_ERROR_MESSAGE_MAX_BYTES) return null;
    return { code: diagnostic.code, message: bridgeErrorMessage(diagnostic), raw: `${JSON.stringify(diagnostic)}\n` };
  } catch {
    return null;
  }
}

function sanitizeEvidence(value: unknown, credentialValues: readonly string[], key = ""): unknown {
  if (typeof value === "string") {
    if (/(?:authorization|cookie|api[-_]?key|token|secret|password|credential)/i.test(key)) return "[REDACTED]";
    return redactCredentialText(value, credentialValues).text;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeEvidence(entry, credentialValues));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([name, entry]) => [name, sanitizeEvidence(entry, credentialValues, name)]));
  }
  return value;
}

function bridgeErrorMessage(diagnostic: Record<string, unknown>): string {
  const message = diagnostic.message as string;
  if (!message.includes("no diagnostic output")) return message;
  const process = diagnostic.process;
  if (!process || typeof process !== "object" || Array.isArray(process)) return message;
  const evidence = process as Record<string, unknown>;
  const tail = [evidence.stderr_tail, evidence.stdout_tail]
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;
  if (!tail) return message;
  return boundedUtf8Tail(
    message.replace(/no diagnostic output/g, tail.trim()),
    HITCH_BRIDGE_ERROR_MESSAGE_MAX_BYTES,
  );
}

function boundedUtf8Tail(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  return encoded.subarray(encoded.byteLength - maxBytes).toString("utf8").replace(/^\uFFFD+/, "");
}
