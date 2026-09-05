import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicWriteJSON, ensureDir, readJSON, sha256JSON, withFileLock } from "../foundation/index.js";
import { HitchError } from "../foundation/index.js";

export interface EvolutionBaselineV1 {
  schema_version: "1";
  evolution_id: string;
  baseline_fingerprint: string;
  state: "submitting" | "running" | "ready" | "failed";
  seed_eval_id?: string;
  heldout_eval_id?: string;
  seed_result_digest?: string;
  heldout_result_digest?: string;
  created_at: string;
  updated_at: string;
}

export interface MaterializedEvolutionBaselineV1 {
  seed_eval_id: string;
  heldout_eval_id: string;
  seed_result_digest: string;
  heldout_result_digest: string;
}

export interface EvolutionBaselineMaterializer {
  (control: { markRunning(seedEvalId: string, heldoutEvalId: string): Promise<void> }): Promise<MaterializedEvolutionBaselineV1>;
}

export interface EnsureEvolutionBaselineOptions {
  root: string;
  evolutionId: string;
  fingerprint: string;
  materialize: EvolutionBaselineMaterializer;
  validateReady?: (baseline: EvolutionBaselineV1) => Promise<void>;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  signal?: AbortSignal;
}

const localFlights = new Map<string, Promise<EvolutionBaselineV1>>();

/** Persisted lineage singleflight. Only the caller that creates `submitting`
 * may invoke the materializer; later rounds validate and return `ready`. */
export async function ensureEvolutionBaseline(options: EnsureEvolutionBaselineOptions): Promise<EvolutionBaselineV1> {
  validateInputs(options);
  const file = baselinePath(options.root, options.evolutionId);
  const local = localFlights.get(file);
  if (local) return local;
  const operation = ensureInternal(options, file);
  localFlights.set(file, operation);
  try { return await operation; } finally { if (localFlights.get(file) === operation) localFlights.delete(file); }
}

export function evolutionBaselineFingerprint(value: Record<string, unknown>): string {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new TypeError("evolution baseline fingerprint input is invalid");
  }
  return sha256JSON(value);
}

export async function readEvolutionBaseline(root: string, evolutionId: string): Promise<EvolutionBaselineV1 | null> {
  const value = await readJSON<unknown | null>(baselinePath(root, evolutionId), null);
  return value === null ? null : parseEvolutionBaseline(value, evolutionId);
}

export function parseEvolutionBaseline(value: unknown, expectedEvolutionId?: string): EvolutionBaselineV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("evolution baseline must be an object");
  const record = value as Record<string, unknown>;
  const fields = ["schema_version", "evolution_id", "baseline_fingerprint", "state", "seed_eval_id", "heldout_eval_id", "seed_result_digest", "heldout_result_digest", "created_at", "updated_at"];
  if (Object.keys(record).some((key) => !fields.includes(key)) || record.schema_version !== "1"
    || typeof record.evolution_id !== "string" || !record.evolution_id
    || expectedEvolutionId !== undefined && record.evolution_id !== expectedEvolutionId
    || typeof record.baseline_fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.baseline_fingerprint)
    || !["submitting", "running", "ready", "failed"].includes(record.state as string)
    || typeof record.created_at !== "string" || !Number.isFinite(Date.parse(record.created_at))
    || typeof record.updated_at !== "string" || !Number.isFinite(Date.parse(record.updated_at))) throw new TypeError("evolution baseline identity is invalid");
  const optional = ["seed_eval_id", "heldout_eval_id"] as const;
  for (const name of optional) if (record[name] !== undefined && (typeof record[name] !== "string" || !/^eval_[a-f0-9]{32}$/.test(record[name] as string))) {
    throw new TypeError(`evolution baseline ${name} is invalid`);
  }
  for (const name of ["seed_result_digest", "heldout_result_digest"] as const) if (record[name] !== undefined
    && (typeof record[name] !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record[name] as string))) throw new TypeError(`evolution baseline ${name} is invalid`);
  if (record.state === "running" && (!record.seed_eval_id || !record.heldout_eval_id)) throw new TypeError("running evolution baseline eval identities are missing");
  if (record.state === "ready" && (!record.seed_eval_id || !record.heldout_eval_id || !record.seed_result_digest || !record.heldout_result_digest)) {
    throw new TypeError("ready evolution baseline references are incomplete");
  }
  return record as unknown as EvolutionBaselineV1;
}

async function ensureInternal(options: EnsureEvolutionBaselineOptions, file: string): Promise<EvolutionBaselineV1> {
  const ownership = await claim(options, file);
  if (!ownership.owner) return waitForOwner(options, file, ownership.baseline);
  try {
    const materialized = await options.materialize({
      markRunning: (seedEvalId, heldoutEvalId) => updateOwned(options, file, (current) => ({
        ...assertRunningIdentity(current, seedEvalId, heldoutEvalId), state: "running",
      })).then(() => undefined),
    });
    const ready = await updateOwned(options, file, (current) => {
      if (current.seed_eval_id && current.seed_eval_id !== materialized.seed_eval_id
        || current.heldout_eval_id && current.heldout_eval_id !== materialized.heldout_eval_id) {
        throw new TypeError("evolution baseline eval identity changed during materialization");
      }
      return {
        ...current, state: "ready", seed_eval_id: checkedEvalId(materialized.seed_eval_id), heldout_eval_id: checkedEvalId(materialized.heldout_eval_id),
        seed_result_digest: checkedDigest(materialized.seed_result_digest), heldout_result_digest: checkedDigest(materialized.heldout_result_digest),
      };
    });
    await options.validateReady?.(ready);
    return ready;
  } catch (error) {
    await updateOwned(options, file, (current) => ({ ...current, state: "failed" })).catch(() => undefined);
    throw error;
  }
}

async function claim(options: EnsureEvolutionBaselineOptions, file: string): Promise<{ owner: boolean; baseline: EvolutionBaselineV1 }> {
  await ensureDir(path.dirname(file));
  return withBaselineLock(options, async () => {
    const existing = await readEvolutionBaseline(options.root, options.evolutionId);
    if (existing) {
      assertFingerprint(existing, options.fingerprint);
      if (existing.state === "failed") throw baselineError("evolution baseline materialization previously failed", "evolution_baseline_failed");
      if (existing.state === "ready") await options.validateReady?.(existing);
      return { owner: false, baseline: existing };
    }
    const now = new Date().toISOString();
    const baseline = parseEvolutionBaseline({
      schema_version: "1", evolution_id: options.evolutionId, baseline_fingerprint: options.fingerprint,
      state: "submitting", created_at: now, updated_at: now,
    }, options.evolutionId);
    await atomicWriteJSON(file, baseline);
    return { owner: true, baseline };
  });
}

async function waitForOwner(options: EnsureEvolutionBaselineOptions, file: string, initial: EvolutionBaselineV1): Promise<EvolutionBaselineV1> {
  if (initial.state === "ready") return initial;
  const deadline = Date.now() + (options.maxWaitMs ?? 24 * 60 * 60 * 1_000);
  const poll = options.pollIntervalMs ?? 250;
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (Date.now() >= deadline) throw baselineError("evolution baseline materialization is still in progress", "evolution_baseline_in_progress");
    await delay(Math.min(poll, Math.max(1, deadline - Date.now())), undefined, options.signal ? { signal: options.signal } : undefined);
    const current = await readEvolutionBaseline(options.root, options.evolutionId);
    if (!current) throw baselineError("evolution baseline record disappeared", "evolution_baseline_state_conflict");
    assertFingerprint(current, options.fingerprint);
    if (current.state === "failed") throw baselineError("evolution baseline materialization failed", "evolution_baseline_failed");
    if (current.state === "ready") {
      await options.validateReady?.(current);
      return current;
    }
  }
}

async function updateOwned(
  options: EnsureEvolutionBaselineOptions,
  file: string,
  update: (current: EvolutionBaselineV1) => EvolutionBaselineV1,
): Promise<EvolutionBaselineV1> {
  return withBaselineLock(options, async () => {
    const current = await readEvolutionBaseline(options.root, options.evolutionId);
    if (!current) throw baselineError("evolution baseline ownership was lost", "evolution_baseline_state_conflict");
    assertFingerprint(current, options.fingerprint);
    if (current.state === "ready" || current.state === "failed") throw baselineError("evolution baseline is already terminal", "evolution_baseline_state_conflict");
    const next = parseEvolutionBaseline({ ...update(current), updated_at: new Date().toISOString() }, options.evolutionId);
    await atomicWriteJSON(file, next);
    return next;
  });
}

function withBaselineLock<T>(options: EnsureEvolutionBaselineOptions, operation: () => Promise<T>): Promise<T> {
  const key = sha256JSON({ evolution_id: options.evolutionId }).slice("sha256:".length);
  return withFileLock(path.join(options.root, "locks", "evolution-baseline"), key, operation, {
    timeoutCode: "evolution_baseline_locked", timeoutExitCode: 12,
  });
}

function validateInputs(options: EnsureEvolutionBaselineOptions): void {
  if (!options.root || !options.evolutionId || !/^sha256:[a-f0-9]{64}$/.test(options.fingerprint)) throw new TypeError("evolution baseline request is invalid");
  if (options.pollIntervalMs !== undefined && (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs < 1)) throw new TypeError("evolution baseline poll interval is invalid");
  if (options.maxWaitMs !== undefined && (!Number.isSafeInteger(options.maxWaitMs) || options.maxWaitMs < 1)) throw new TypeError("evolution baseline wait is invalid");
}

function baselinePath(root: string, evolutionId: string): string {
  const id = sha256JSON({ evolution_id: evolutionId }).slice("sha256:".length);
  return path.join(root, "evolutions", id, "baseline.json");
}

function assertFingerprint(record: EvolutionBaselineV1, fingerprint: string): void {
  if (record.baseline_fingerprint !== fingerprint) throw baselineError("evolution baseline fingerprint changed", "evolution_baseline_fingerprint_mismatch");
}

function checkedEvalId(value: string): string {
  if (!/^eval_[a-f0-9]{32}$/.test(value)) throw new TypeError("evolution baseline eval id is invalid");
  return value;
}

function checkedDigest(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypeError("evolution baseline result digest is invalid");
  return value;
}

function assertRunningIdentity(current: EvolutionBaselineV1, seedEvalId: string, heldoutEvalId: string): EvolutionBaselineV1 {
  const seed = checkedEvalId(seedEvalId);
  const heldout = checkedEvalId(heldoutEvalId);
  if (current.seed_eval_id && current.seed_eval_id !== seed || current.heldout_eval_id && current.heldout_eval_id !== heldout) {
    throw new TypeError("evolution baseline eval identity changed while running");
  }
  return { ...current, seed_eval_id: seed, heldout_eval_id: heldout };
}

function baselineError(message: string, code: string): HitchError {
  return new HitchError(message, { code, exitCode: 12 });
}
