import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const HITCH_BRIDGE_ERROR_MAX_BYTES = 64 * 1024;
const HITCH_BRIDGE_ERROR_MESSAGE_MAX_BYTES = 2048;
const HITCH_BRIDGE_ERROR_CODES = new Set([
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
export async function readHarborBridgeError(trialDirectory: string): Promise<HarborBridgeErrorDiagnostic | null> {
  const source = path.join(trialDirectory, "agent", "hitch-bridge-error.json");
  try {
    const info = await lstat(source);
    if (!info.isFile() || info.size <= 0 || info.size > HITCH_BRIDGE_ERROR_MAX_BYTES) return null;
    const raw = await readFile(source, "utf8");
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const diagnostic = value as Record<string, unknown>;
    if (diagnostic.schema_version !== "1") return null;
    if (typeof diagnostic.code !== "string" || !HITCH_BRIDGE_ERROR_CODES.has(diagnostic.code)) return null;
    if (typeof diagnostic.message !== "string" || !diagnostic.message.trim()) return null;
    if (Buffer.byteLength(diagnostic.message, "utf8") > HITCH_BRIDGE_ERROR_MESSAGE_MAX_BYTES) return null;
    return { code: diagnostic.code, message: diagnostic.message, raw };
  } catch {
    return null;
  }
}
