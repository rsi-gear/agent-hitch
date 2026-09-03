import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";

export const CREDENTIAL_REDACTION_MARKER = "[REDACTED]";
export const PROVIDER_ENVIRONMENT_NAMES = [
  "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_ORGANIZATION",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "GOOGLE_API_KEY", "GEMINI_API_KEY",
  "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_VERSION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION", "GITHUB_TOKEN", "GH_TOKEN",
] as const;
const OVERSIZED_LINE_MARKER = "[REDACTED OVERSIZED LOG LINE]";
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

const TEXT_RULES: Array<{ id: string; pattern: RegExp; replacement: string }> = [
  { id: "authorization-bearer-v1", pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, replacement: `Bearer ${CREDENTIAL_REDACTION_MARKER}` },
  { id: "provider-api-key-v1", pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, replacement: CREDENTIAL_REDACTION_MARKER },
  { id: "secret-query-v1", pattern: /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&\s]+/gi, replacement: `$1${CREDENTIAL_REDACTION_MARKER}` },
];

const SECRET_HEADER = /^(\s*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-[a-z0-9-]*(?:secret|token|api-key)[a-z0-9-]*)\s*:\s*).+$/gim;
const NAMED_SECRET = /((?:"|')?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|credential)(?:"|')?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;

export interface CredentialRedactionResult {
  text: string;
  redactions: Map<string, number>;
}

/** Match credential-bearing JSON/header field names independently of current environment values. */
export function isSensitiveFieldName(value: string): boolean {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  const parts = normalized.split("_").filter(Boolean);
  return parts.includes("token") || parts.includes("auth")
    || /authorization|cookie|api_key|client_secret|private_key|password|credential|(?:^|_)secret(?:_|$)/.test(normalized);
}

export function safeDiagnosticMessage(
  value: unknown,
  credentialValues: readonly string[] = [],
  maxCharacters = 4_096,
): string {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 32) throw new TypeError("diagnostic message limit is invalid");
  const message = redactCredentialText((value as Error)?.message || String(value ?? ""), credentialValues).text;
  const marker = "…[truncated]";
  return message.length <= maxCharacters ? message : `${message.slice(0, maxCharacters - marker.length)}${marker}`;
}

export function redactCredentialText(value: string, credentialValues: readonly string[] = []): CredentialRedactionResult {
  const redactions = new Map<string, number>();
  let text = String(value);
  const known = [...new Set(credentialValues.filter((entry) => entry.length > 0))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  if (known.length > 0) {
    let count = 0;
    const pattern = new RegExp(known.map(escapeRegExp).join("|"), "g");
    text = text.replace(pattern, () => {
      count += 1;
      return CREDENTIAL_REDACTION_MARKER;
    });
    if (count > 0) increment(redactions, "known-credential-value-v1", count);
  }
  // Structured token forms must run before the generic named-field rule. For
  // example, treating `Authorization: Bearer ...` as a generic field first
  // would redact only the word `Bearer` and leave the token behind.
  for (const rule of TEXT_RULES) {
    const count = text.match(rule.pattern)?.length ?? 0;
    text = text.replace(rule.pattern, rule.replacement);
    if (count > 0) increment(redactions, rule.id, count);
  }
  text = text.replace(SECRET_HEADER, (_match, prefix: string) => {
    increment(redactions, "sensitive-header-v1");
    return `${prefix}${CREDENTIAL_REDACTION_MARKER}`;
  });
  text = text.replace(NAMED_SECRET, (_match, prefix: string, encoded: string) => {
    increment(redactions, "sensitive-field-v1");
    const quote = encoded.startsWith("\"") ? "\"" : encoded.startsWith("'") ? "'" : "";
    return `${prefix}${quote}${CREDENTIAL_REDACTION_MARKER}${quote}`;
  });
  return { text, redactions };
}

export function credentialValuesFromEnv(names: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`invalid credential environment name: ${name}`);
    const value = env[name];
    if (value !== undefined && value.length > 0) values.push(value);
  }
  return [...new Set(values)].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

export function createCredentialRedactionTransform(
  credentialValues: readonly string[],
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
): Transform {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new TypeError("redaction max line bytes must be positive");
  const decoder = new StringDecoder("utf8");
  const streamingValues = [...new Set(credentialValues.flatMap((entry) => [entry, ...entry.split(/\r?\n/)]).filter((entry) => entry.length > 0))];
  let buffer = "";
  let discarding = false;
  return new Transform({
    transform(chunk: Buffer | string, _encoding, callback): void {
      try {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
        buffer = drain(this, buffer, streamingValues, maxLineBytes, () => discarding, (value) => { discarding = value; });
        callback();
      } catch (error) { callback(error as Error); }
    },
    flush(callback): void {
      try {
        buffer += decoder.end();
        if (!discarding && buffer.length > 0) this.push(redactCredentialText(buffer, streamingValues).text);
        callback();
      } catch (error) { callback(error as Error); }
    },
  });
}

function drain(
  stream: Transform,
  input: string,
  credentialValues: readonly string[],
  maxLineBytes: number,
  isDiscarding: () => boolean,
  setDiscarding: (value: boolean) => void,
): string {
  let buffer = input;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (isDiscarding()) {
      if (newline < 0) return "";
      buffer = buffer.slice(newline + 1);
      setDiscarding(false);
      continue;
    }
    if (newline >= 0) {
      const line = buffer.slice(0, newline + 1);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > maxLineBytes) stream.push(`${OVERSIZED_LINE_MARKER}\n`);
      else stream.push(redactCredentialText(line, credentialValues).text);
      continue;
    }
    if (Buffer.byteLength(buffer) > maxLineBytes) {
      stream.push(`${OVERSIZED_LINE_MARKER}\n`);
      buffer = "";
      setDiscarding(true);
    }
    return buffer;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function increment(counts: Map<string, number>, rule: string, count = 1): void {
  counts.set(rule, (counts.get(rule) ?? 0) + count);
}
