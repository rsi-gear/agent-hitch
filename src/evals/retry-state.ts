import path from "node:path";
import type { BackendWorkItemV1, EvalExecutionPlanV1, EvalTrialRefV1 } from "../domain/index.js";
import { atomicWriteJSON, ensureDir, readJSON, sha256JSON, withFileLock } from "../foundation/index.js";
import type { FailureClassificationV1 } from "./failure-classifier.js";
import { classifyTrialFailure, parseFailureClassification, physicalRetryAllowed } from "./failure-classifier.js";
import { physicalRetryWorkItem, physicalRetryWorkItemForTriggerIds } from "./physical-retry-work.js";

export type RetryDispositionV1 = "physical-retry" | "verifier-only" | "collect-only" | "no-retry" | "operator-required";
export type RetryDecisionStateV1 = "planned" | "running" | "repaired" | "invalid" | "skipped" | "exhausted";

export interface RetryDecisionV1 {
  decision_id: string;
  slot_id: string;
  trigger_trial_id: string;
  trigger_run_id?: string;
  retry_index: number;
  classification: FailureClassificationV1;
  disposition: RetryDispositionV1;
  retry_work_id?: string;
  not_before?: string;
  state: RetryDecisionStateV1;
  created_at: string;
  updated_at: string;
}

export interface EvalRetryStateV1 {
  schema_version: "1";
  eval_id: string;
  generation: number;
  decisions: RetryDecisionV1[];
  updated_at: string;
}

export interface ResolvedRetryWorkV1 {
  item: BackendWorkItemV1;
  decisions: RetryDecisionV1[];
}

export async function readEvalRetryState(evalDirectory: string, evalId: string): Promise<EvalRetryStateV1 | null> {
  const value = await readJSON<unknown | null>(path.join(evalDirectory, "retry-state.json"), null);
  return value === null ? null : parseEvalRetryState(value, evalId);
}

export async function ensurePhysicalRetryDecision(input: {
  evalDirectory: string;
  evalId: string;
  item: BackendWorkItemV1;
  retryIndex: number;
  trigger: EvalTrialRefV1;
  notBefore?: string;
  now?: string;
}): Promise<RetryDecisionV1> {
  const classification = classifyTrialFailure(input.trigger);
  if (!classification || !physicalRetryAllowed(classification)) throw new TypeError("physical retry decision requires a retryable classification");
  const retryWork = physicalRetryWorkItem(input.item, input.retryIndex, [input.trigger]);
  return ensureDecision({
    ...input,
    classification,
    disposition: "physical-retry",
    retryWorkId: retryWork.work_id,
    state: "planned",
  });
}

export async function ensureTerminalRetryDecision(input: {
  evalDirectory: string;
  evalId: string;
  item: BackendWorkItemV1;
  retryIndex: number;
  trigger: EvalTrialRefV1;
  exhausted?: boolean;
  now?: string;
}): Promise<RetryDecisionV1 | null> {
  const classification = classifyTrialFailure(input.trigger);
  if (!classification) return null;
  const disposition = dispositionFor(classification);
  return ensureDecision({
    ...input,
    classification,
    disposition,
    state: input.exhausted && physicalRetryAllowed(classification) ? "exhausted" : "skipped",
  });
}

export async function transitionRetryDecision(input: {
  evalDirectory: string;
  evalId: string;
  decisionId: string;
  state: RetryDecisionStateV1;
  now?: string;
}): Promise<RetryDecisionV1> {
  return mutateState(input.evalDirectory, input.evalId, (current) => {
    const index = current.decisions.findIndex((decision) => decision.decision_id === input.decisionId);
    if (index < 0) throw new TypeError(`retry decision does not exist: ${input.decisionId}`);
    const existing = current.decisions[index] as RetryDecisionV1;
    if (existing.state === input.state) return { current, value: existing, changed: false };
    if (!allowedTransition(existing.state, input.state)) throw new TypeError(`retry decision state transition is invalid: ${existing.state} -> ${input.state}`);
    const updated = { ...existing, state: input.state, updated_at: validTimestamp(input.now ?? new Date().toISOString(), "retry decision updated_at") };
    const decisions = [...current.decisions];
    decisions[index] = updated;
    return { current: { ...current, decisions: canonicalDecisions(decisions) }, value: updated, changed: true };
  });
}

export function resolveRetryWork(plan: EvalExecutionPlanV1, state: EvalRetryStateV1 | null, workId: string): ResolvedRetryWorkV1 | null {
  if (!state) return null;
  const decisions = state.decisions.filter((decision) => decision.retry_work_id === workId);
  if (decisions.length === 0) return null;
  const first = decisions[0] as RetryDecisionV1;
  if (decisions.some((decision) => decision.slot_id !== first.slot_id || decision.retry_index !== first.retry_index)) {
    throw new TypeError(`retry work identity has conflicting decisions: ${workId}`);
  }
  const origin = plan.work_items.find((item) => item.slots.includes(first.slot_id));
  if (!origin) throw new TypeError(`retry decision slot is absent from execution plan: ${first.slot_id}`);
  const item = physicalRetryWorkItemForTriggerIds(origin, first.retry_index, decisions.map((decision) => decision.trigger_trial_id));
  if (item.work_id !== workId) throw new TypeError(`retry decision work identity is invalid: ${workId}`);
  return { item, decisions };
}

async function ensureDecision(input: {
  evalDirectory: string;
  evalId: string;
  item: BackendWorkItemV1;
  retryIndex: number;
  trigger: EvalTrialRefV1;
  classification: FailureClassificationV1;
  disposition: RetryDispositionV1;
  retryWorkId?: string;
  notBefore?: string;
  state: RetryDecisionStateV1;
  now?: string;
}): Promise<RetryDecisionV1> {
  const slotId = input.item.slots[0];
  if (!slotId || input.item.slots.length !== 1 || input.item.task_ids.length !== 1) throw new TypeError("retry decisions require one task slot work item");
  if (!Number.isSafeInteger(input.retryIndex) || input.retryIndex < 1) throw new TypeError("retry decision index is invalid");
  const timestamp = validTimestamp(input.now ?? new Date().toISOString(), "retry decision created_at");
  const digest = sha256JSON({ eval_id: input.evalId, slot_id: slotId, trigger_trial_id: input.trigger.trial_id, retry_index: input.retryIndex });
  const decision: RetryDecisionV1 = {
    decision_id: `retry_decision_${digest.slice("sha256:".length, "sha256:".length + 32)}`,
    slot_id: slotId,
    trigger_trial_id: input.trigger.trial_id,
    ...(input.trigger.run_id ? { trigger_run_id: input.trigger.run_id } : {}),
    retry_index: input.retryIndex,
    classification: input.classification,
    disposition: input.disposition,
    ...(input.retryWorkId ? { retry_work_id: input.retryWorkId } : {}),
    ...(input.notBefore ? { not_before: validTimestamp(input.notBefore, "retry decision not_before") } : {}),
    state: input.state,
    created_at: timestamp,
    updated_at: timestamp,
  };
  return mutateState(input.evalDirectory, input.evalId, (current) => {
    const existing = current.decisions.find((entry) => entry.decision_id === decision.decision_id);
    if (existing) {
      if (JSON.stringify(immutableDecision(existing)) !== JSON.stringify(immutableDecision(decision))) {
        throw new TypeError(`retry decision identity conflict: ${decision.decision_id}`);
      }
      return { current, value: existing, changed: false };
    }
    return { current: { ...current, decisions: canonicalDecisions([...current.decisions, decision]) }, value: decision, changed: true };
  });
}

async function mutateState<T>(
  evalDirectory: string,
  evalId: string,
  operation: (state: EvalRetryStateV1) => { current: EvalRetryStateV1; value: T; changed: boolean },
): Promise<T> {
  await ensureDir(evalDirectory);
  return withFileLock(path.join(evalDirectory, ".locks"), "retry-state", async () => {
    const existing = await readEvalRetryState(evalDirectory, evalId);
    const now = new Date().toISOString();
    const state = existing ?? { schema_version: "1", eval_id: evalId, generation: 0, decisions: [], updated_at: now };
    const result = operation(state);
    if (result.changed) {
      const next = parseEvalRetryState({ ...result.current, generation: state.generation + 1, updated_at: now }, evalId);
      await atomicWriteJSON(path.join(evalDirectory, "retry-state.json"), next);
    }
    return result.value;
  }, { timeoutCode: "eval_retry_state_locked", timeoutExitCode: 12 });
}

export function parseEvalRetryState(value: unknown, expectedEvalId?: string): EvalRetryStateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("eval retry state must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schema_version", "eval_id", "generation", "decisions", "updated_at"].includes(key))
    || record.schema_version !== "1" || typeof record.eval_id !== "string" || !/^eval_[a-f0-9]{32}$/.test(record.eval_id)
    || expectedEvalId !== undefined && record.eval_id !== expectedEvalId
    || !Number.isSafeInteger(record.generation) || (record.generation as number) < 0 || !Array.isArray(record.decisions)) {
    throw new TypeError("eval retry state identity is invalid");
  }
  const decisions = record.decisions.map(parseDecision);
  if (new Set(decisions.map((decision) => decision.decision_id)).size !== decisions.length) throw new TypeError("retry decision identities are duplicated");
  const sorted = canonicalDecisions(decisions);
  if (sorted.some((decision, index) => decision !== decisions[index])) throw new TypeError("retry decisions are not canonically sorted");
  return {
    schema_version: "1", eval_id: record.eval_id, generation: record.generation as number,
    decisions, updated_at: validTimestamp(record.updated_at, "eval retry state updated_at"),
  };
}

function parseDecision(value: unknown): RetryDecisionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("retry decision must be an object");
  const record = value as Record<string, unknown>;
  const optional = ["trigger_run_id", "retry_work_id", "not_before"];
  const required = ["decision_id", "slot_id", "trigger_trial_id", "retry_index", "classification", "disposition", "state", "created_at", "updated_at"];
  if (Object.keys(record).some((key) => !required.includes(key) && !optional.includes(key))
    || typeof record.decision_id !== "string" || !/^retry_decision_[a-f0-9]{32}$/.test(record.decision_id)
    || typeof record.slot_id !== "string" || !record.slot_id || typeof record.trigger_trial_id !== "string" || !record.trigger_trial_id
    || !Number.isSafeInteger(record.retry_index) || (record.retry_index as number) < 1) throw new TypeError("retry decision identity is invalid");
  const classification = parseFailureClassification(record.classification);
  if (!isOneOf(record.disposition, ["physical-retry", "verifier-only", "collect-only", "no-retry", "operator-required"])
    || !isOneOf(record.state, ["planned", "running", "repaired", "invalid", "skipped", "exhausted"])) throw new TypeError("retry decision action is invalid");
  for (const field of optional) if (record[field] !== undefined && (typeof record[field] !== "string" || !record[field])) throw new TypeError(`retry decision ${field} is invalid`);
  if (record.not_before !== undefined) validTimestamp(record.not_before, "retry decision not_before");
  if (record.disposition === "physical-retry" && typeof record.retry_work_id !== "string") throw new TypeError("physical retry decision work identity is missing");
  return {
    decision_id: record.decision_id, slot_id: record.slot_id, trigger_trial_id: record.trigger_trial_id,
    ...(record.trigger_run_id ? { trigger_run_id: record.trigger_run_id as string } : {}), retry_index: record.retry_index as number,
    classification, disposition: record.disposition, ...(record.retry_work_id ? { retry_work_id: record.retry_work_id as string } : {}),
    ...(record.not_before ? { not_before: record.not_before as string } : {}), state: record.state,
    created_at: validTimestamp(record.created_at, "retry decision created_at"), updated_at: validTimestamp(record.updated_at, "retry decision updated_at"),
  };
}

function dispositionFor(classification: FailureClassificationV1): RetryDispositionV1 {
  if (classification.retryability === "verifier-only") return "verifier-only";
  if (classification.retryability === "collect-only") return "collect-only";
  if (classification.retryability === "operator-required") return "operator-required";
  return "no-retry";
}

function immutableDecision(decision: RetryDecisionV1): unknown {
  const { state: _state, created_at: _created, updated_at: _updated, not_before: _notBefore, ...identity } = decision;
  return identity;
}

function allowedTransition(from: RetryDecisionStateV1, to: RetryDecisionStateV1): boolean {
  return from === "planned" && (to === "running" || to === "skipped")
    || from === "running" && (to === "repaired" || to === "invalid" || to === "exhausted");
}

function canonicalDecisions(decisions: RetryDecisionV1[]): RetryDecisionV1[] {
  return [...decisions].sort((left, right) => Buffer.compare(Buffer.from(left.slot_id), Buffer.from(right.slot_id))
    || left.retry_index - right.retry_index || Buffer.compare(Buffer.from(left.decision_id), Buffer.from(right.decision_id)));
}

function validTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label} is invalid`);
  return value;
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.includes(value as T);
}
