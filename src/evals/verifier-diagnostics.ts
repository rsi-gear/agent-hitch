import { open, stat } from "node:fs/promises";
import path from "node:path";
import type { RunObservationV1 } from "../domain/index.js";
import { atomicWriteJSON } from "../foundation/index.js";

const MAX_LOG_BYTES = 256 * 1024;
const VERIFIER_LOG_FILES = ["test-stdout.txt", "test-stderr.txt", "stdout.txt", "stderr.txt"] as const;

export type VerifierInfrastructureSignal =
  | "dns_resolution_failed"
  | "network_unreachable"
  | "package_install_failed"
  | "test_runner_missing"
  | "verifier_environment_missing";

export interface VerifierInfrastructureDiagnostic {
  schema_version: "1";
  code: "verifier_infrastructure_failure";
  signals: VerifierInfrastructureSignal[];
  source_files: string[];
  attempts?: Array<{
    attempt: number;
    signals: VerifierInfrastructureSignal[];
    source_files: string[];
  }>;
  max_retries?: number;
  backoff_ms?: number;
}

const INFRASTRUCTURE_PATTERNS: ReadonlyArray<{
  signal: VerifierInfrastructureSignal;
  patterns: readonly RegExp[];
}> = [
  {
    signal: "dns_resolution_failed",
    patterns: [
      /curl:\s*\(\d+\)\s*Could not resolve host:/i,
      /Temporary failure in name resolution/i,
      /Name or service not known/i,
      /getaddrinfo\s+(?:EAI_AGAIN|ENOTFOUND)/i,
      /Could not resolve hostname/i,
    ],
  },
  {
    signal: "network_unreachable",
    patterns: [
      /Network is unreachable/i,
      /Failed to establish a new connection:[^\n]*(?:timed out|connection refused)/i,
      /Could not connect to (?:host|server)/i,
    ],
  },
  {
    signal: "package_install_failed",
    patterns: [
      /Could not find a version that satisfies the requirement/i,
      /No matching distribution found for/i,
      /Failed to (?:download|fetch) [^\n]*(?:package|wheel|index)/i,
      /error:\s*failed to (?:download|fetch|install)/i,
    ],
  },
  {
    signal: "test_runner_missing",
    patterns: [
      /(?:^|\n)[^\n]*(?:uvx|pytest|pipx|tox|nox): command not found(?:\n|$)/i,
      /No module named ['"]?(?:pytest|unittest|tox|nox)['"]?/i,
    ],
  },
  {
    signal: "verifier_environment_missing",
    patterns: [
      /\/(?:root|home\/[^/]+)\/\.local\/bin\/env: No such file or directory/i,
      /(?:^|\n)[^\n]*\/bin\/(?:python|python3|pytest|uv|uvx): No such file or directory(?:\n|$)/i,
    ],
  },
];

const TEST_EXECUTION_EVIDENCE = [
  /test session starts/i,
  /collected\s+\d+\s+items?/i,
  /(?:^|\n)Ran\s+\d+\s+tests?/i,
  /(?:^|\n)TAP version\s+\d+/i,
  /={3,}[^\n]*(?:passed|failed|errors?|skipped)[^\n]*={3,}/i,
] as const;

/**
 * Detect a verifier that wrote a zero reward after its own bootstrap failed.
 *
 * Harbor treats reward.txt as authoritative even when a shell verifier masks
 * an earlier command failure. We fail closed only when reward is exactly zero,
 * no structured CTRF evidence exists, no test-runner evidence appears in the
 * bounded logs, and a stable infrastructure signature is present.
 */
export async function detectVerifierInfrastructureFailure(
  trialDirectory: string,
  reward: number | undefined,
): Promise<VerifierInfrastructureDiagnostic | null> {
  const verifierDirectory = path.join(trialDirectory, "verifier");
  const explicit = await readExplicitDiagnostic(path.join(verifierDirectory, "infrastructure-error.json"));
  if (explicit) return explicit;
  if (reward !== 0) return null;
  if (await nonEmptyFile(path.join(verifierDirectory, "ctrf.json"))) return null;

  const logs: string[] = [];
  const sourceFiles: string[] = [];
  for (const name of VERIFIER_LOG_FILES) {
    const file = path.join(verifierDirectory, name);
    const value = await readBoundedFile(file, MAX_LOG_BYTES);
    if (value === null) continue;
    logs.push(value);
    sourceFiles.push(`verifier/${name}`);
  }
  if (logs.length === 0) return null;
  const combined = logs.join("\n");
  if (TEST_EXECUTION_EVIDENCE.some((pattern) => pattern.test(combined))) return null;

  const signals = INFRASTRUCTURE_PATTERNS
    .filter(({ patterns }) => patterns.some((pattern) => pattern.test(combined)))
    .map(({ signal }) => signal);
  if (signals.length === 0) return null;
  return {
    schema_version: "1",
    code: "verifier_infrastructure_failure",
    signals,
    source_files: sourceFiles,
  };
}

async function readExplicitDiagnostic(file: string): Promise<VerifierInfrastructureDiagnostic | null> {
  const raw = await readBoundedFile(file, MAX_LOG_BYTES);
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema_version !== "1" || record.code !== "verifier_infrastructure_failure") return null;
  const signals = infrastructureSignals(record.signals);
  const sourceFiles = stringArray(record.source_files);
  if (signals.length === 0 || sourceFiles.length === 0) return null;
  const attempts = Array.isArray(record.attempts)
    ? record.attempts.flatMap((attempt) => {
        if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) return [];
        const item = attempt as Record<string, unknown>;
        const number = item.attempt;
        const itemSignals = infrastructureSignals(item.signals);
        const itemSourceFiles = stringArray(item.source_files);
        if (!Number.isSafeInteger(number) || (number as number) < 1 || itemSignals.length === 0 || itemSourceFiles.length === 0) return [];
        return [{ attempt: number as number, signals: itemSignals, source_files: itemSourceFiles }];
      })
    : [];
  const maxRetries = record.max_retries;
  const backoffMs = record.backoff_ms;
  return {
    schema_version: "1",
    code: "verifier_infrastructure_failure",
    signals,
    source_files: sourceFiles,
    ...(attempts.length > 0 ? { attempts } : {}),
    ...(Number.isSafeInteger(maxRetries) && (maxRetries as number) >= 0 ? { max_retries: maxRetries as number } : {}),
    ...(Number.isSafeInteger(backoffMs) && (backoffMs as number) >= 0 ? { backoff_ms: backoffMs as number } : {}),
  };
}

function infrastructureSignals(value: unknown): VerifierInfrastructureSignal[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<VerifierInfrastructureSignal>(INFRASTRUCTURE_PATTERNS.map(({ signal }) => signal));
  return [...new Set(value.filter((entry): entry is VerifierInfrastructureSignal => typeof entry === "string" && allowed.has(entry as VerifierInfrastructureSignal)))];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))]
    : [];
}

export function verifierResult(trial: Record<string, unknown>): Record<string, unknown> | null {
  return trial.verifier_result && typeof trial.verifier_result === "object" && !Array.isArray(trial.verifier_result)
    ? trial.verifier_result as Record<string, unknown>
    : null;
}

export function primaryVerifierReward(trial: Record<string, unknown>): number | undefined {
  const rewards = (verifierResult(trial)?.rewards || {}) as Record<string, unknown>;
  const preferred = rewards.reward;
  if (typeof preferred === "number" && Number.isFinite(preferred)) return preferred;
  return Object.values(rewards).find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

export function verifierObservation(input: {
  trial: Record<string, unknown>;
  runStatus: string;
  trajectoryStatus: "valid" | "missing" | "corrupt";
  recordStatus: "valid" | "corrupt";
  verifierRef: string | undefined;
  infrastructure: VerifierInfrastructureDiagnostic | null;
}): RunObservationV1 {
  const ref = input.verifierRef ? { verifier_result_ref: input.verifierRef } : {};
  if (input.runStatus === "cancelled") return { status: "invalid", invalid_reason: "cancelled", ...ref };
  if (input.runStatus !== "succeeded" || input.recordStatus !== "valid") return { status: "invalid", invalid_reason: "infrastructure_failure", ...ref };
  if (input.trajectoryStatus !== "valid") return { status: "invalid", invalid_reason: "trajectory_missing_or_corrupt", ...ref };
  if (input.infrastructure) return { status: "invalid", invalid_reason: "verifier_infrastructure_failure", ...ref };
  // The candidate run and trajectory are already sealed and valid. A later
  // Harbor exception belongs to verification/teardown and must never trigger
  // a second candidate execution.
  if (input.trial.exception_info) return { status: "invalid", invalid_reason: "verifier_infrastructure_failure", ...ref };
  const reward = primaryVerifierReward(input.trial);
  if (reward === undefined || !input.verifierRef) return { status: "invalid", invalid_reason: "verifier_result_missing" };
  return { status: "valid", reward, verifier_result_ref: input.verifierRef };
}

export async function writeVerifierInfrastructureDiagnostic(
  runDirectory: string,
  diagnostic: VerifierInfrastructureDiagnostic,
): Promise<void> {
  await atomicWriteJSON(path.join(runDirectory, "verifier", "infrastructure-error.json"), {
    ...diagnostic,
    detected_at: new Date().toISOString(),
  });
}

async function nonEmptyFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readBoundedFile(file: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    if (size === 0) return "";
    if (size <= maxBytes) {
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      return buffer.toString("utf8");
    }
    const half = Math.floor(maxBytes / 2);
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(maxBytes - half);
    await handle.read(head, 0, head.length, 0);
    await handle.read(tail, 0, tail.length, size - tail.length);
    return `${head.toString("utf8")}\n[... verifier log truncated ...]\n${tail.toString("utf8")}`;
  } finally {
    await handle.close();
  }
}
