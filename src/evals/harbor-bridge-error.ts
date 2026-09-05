import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { redactCredentialText } from "../foundation/index.js";
import type { FailureClassificationV1 } from "./failure-classifier.js";
import { parseFailureClassification } from "./failure-classifier.js";

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
  failureClassification?: FailureClassificationV1;
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
    const failureClassification = bridgeFailureClassification(diagnostic);
    return {
      code: diagnostic.code, message: bridgeErrorMessage(diagnostic), raw: `${JSON.stringify(diagnostic)}\n`,
      ...(failureClassification ? { failureClassification } : {}),
    };
  } catch {
    return null;
  }
}

function bridgeFailureClassification(diagnostic: Record<string, unknown>): FailureClassificationV1 | undefined {
  if (diagnostic.failure_classification !== undefined) {
    try { return parseFailureClassification(diagnostic.failure_classification); } catch { return undefined; }
  }
  if (diagnostic.code !== "hitch_process_failed") return undefined;
  const text = JSON.stringify(diagnostic);
  if (/(?:insufficient|exhausted|depleted).{0,40}(?:balance|quota|credit)|(?:balance|quota|credit).{0,40}(?:insufficient|exhausted|depleted)|billing.{0,30}(?:limit|hard)/i.test(text)) {
    return providerClassification("provider_quota_exhausted", "never", true);
  }
  if (/(?:invalid|missing|expired|revoked).{0,30}(?:api[_ -]?key|credential|token)|(?:authentication|authorization)\s+(?:failed|required)|\bunauthorized\b|(?:status|http)\s*401\b/i.test(text)) {
    return providerClassification("provider_auth_failed", "operator-required", "unknown");
  }
  if (/(?:model|parameter|request).{0,40}(?:not found|does not exist|unsupported|invalid)|(?:unknown|invalid)\s+model/i.test(text)) {
    return providerClassification("provider_configuration_invalid", "never", "unknown");
  }
  if (/\brate[ _-]?limit(?:ed|ing)?\b|too many requests|(?:status|http)\s*429\b/i.test(text)) {
    return providerClassification("provider_rate_limited", "transient", true);
  }
  if (/\b(?:econnreset|etimedout|eai_again|socket hang up|connection reset|temporary network|network unreachable)\b/i.test(text)) {
    return providerClassification("provider_transport_transient", "transient", true);
  }
  if (/agent run timed out|"status":"timed_out"|"code":"timed_out"/i.test(text)) {
    return { schema_version: "1", phase: "agent", code: "agent_timed_out", candidate_started: true, retryability: "never", source: "bridge-evidence" };
  }
  return undefined;
}

function providerClassification(
  code: string,
  retryability: FailureClassificationV1["retryability"],
  candidateStarted: FailureClassificationV1["candidate_started"],
): FailureClassificationV1 {
  return { schema_version: "1", phase: "provider", code, candidate_started: candidateStarted, retryability, source: "bridge-evidence" };
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
