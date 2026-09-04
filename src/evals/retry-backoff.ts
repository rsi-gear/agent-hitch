import { createHash } from "node:crypto";

const MAX_RETRY_BACKOFF_MS = 60_000;

/** Deterministic full jitter keeps crash replay stable until not_before has
 * been persisted. A zero configured delay remains an explicit test/dev off
 * switch; production defaults are clamped to at least one second. */
export function retryBackoffMs(configuredMs: number, retryIndex: number, seed: string): number {
  if (!Number.isSafeInteger(configuredMs) || configuredMs < 0) throw new TypeError("infrastructure retry backoff is invalid");
  if (!Number.isSafeInteger(retryIndex) || retryIndex < 1) throw new TypeError("infrastructure retry index is invalid");
  if (!seed) throw new TypeError("infrastructure retry backoff seed is missing");
  if (configuredMs === 0) return 0;
  const base = Math.max(configuredMs, 1_000);
  const cap = Math.min(MAX_RETRY_BACKOFF_MS, base * 2 ** Math.min(retryIndex - 1, 16));
  const entropy = createHash("sha256").update(`${seed}\0${retryIndex}`).digest().readUInt32BE(0);
  return entropy % (cap + 1);
}
