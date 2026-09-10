import path from "node:path";
import type { EvalId } from "../domain/index.js";
import { HitchError, atomicWriteJSON, readJSON, sha256Bytes, sha256JSON, statePaths, withFileLock } from "../foundation/index.js";
import { newEvalId, validateEvalId } from "../evals/index.js";
import { idempotencyIndexPath, validateIdempotencyKey } from "./eval-records.js";
import type { EvalScheduler } from "./eval-scheduler.js";
import type { EvalRerunScheduler } from "./rerun-scheduler.js";

type Json = Record<string, unknown>;
export interface OrderedEvalCommandV2 {
  schema_version: "2"; key: string; subject_digest: string; sequence: number; action: "start" | "pause";
  submission?: unknown; rerun?: { eval_id: string; input: Json };
}
interface CommandRecord extends Omit<OrderedEvalCommandV2, "submission" | "rerun" | "key"> {
  key_hash: `sha256:${string}`; eval_id: EvalId; reruns: Record<string, { digest: string; sequence: number; cancelled_by?: number }>;
}
export interface OrderedEvalSubmission { evalId: EvalId; subjectDigest: string; sequence: number; authority: symbol }
const authorities = new Map<string, symbol>();
const fail = (message: string, code = "eval_control_invalid"): never => { throw new HitchError(message, { code, exitCode: 12 }); };
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : fail("eval control requires an object");
export const evalCommandPath = (root: string, hash: string): string => path.join(statePaths(root).indexes, "eval-commands", `${hash.slice(7)}.json`);
const bindingPath = (root: string, id: EvalId): string => path.join(statePaths(root).indexes, "eval-command-bindings", `${id}.json`);

export function parseOrderedEvalCommand(value: unknown): OrderedEvalCommandV2 {
  const input = object(value);
  if (Object.keys(input).some(key => !["schema_version", "key", "subject_digest", "sequence", "action", "submission", "rerun"].includes(key))
    || input.schema_version !== "2" || typeof input.key !== "string" || !/^sha256:[a-f0-9]{64}$/.test(String(input.subject_digest))
    || !Number.isSafeInteger(input.sequence) || Number(input.sequence) < 0 || !["start", "pause"].includes(String(input.action))) fail("invalid ordered eval intent");
  validateIdempotencyKey(input.key as string);
  if (input.submission !== undefined && input.rerun !== undefined || input.action === "pause" && (input.submission !== undefined || input.rerun !== undefined)) fail("pause cannot submit work");
  if (input.submission !== undefined) {
    const submission = object(input.submission), request = object(submission.request);
    if (request.backend !== "harbor" || Object.keys(submission).some(key => !["schema_version", "request", "execution", "idempotency_key"].includes(key))) fail("controlled submission requires a canonical submission envelope");
  }
  if (input.rerun !== undefined) {
    const rerun = object(input.rerun); const body = object(rerun.input);
    if (Object.keys(rerun).some(key => !["eval_id", "input"].includes(key)) || !/^rerun_[a-f0-9]{32}$/.test(String(body.rerun_id))) fail("controlled rerun requires a stable identity");
    validateEvalId(String(rerun.eval_id));
  }
  return input as unknown as OrderedEvalCommandV2;
}
export async function readOrderedEvalIntent(file: string): Promise<OrderedEvalCommandV2> {
  const command = parseOrderedEvalCommand(await readJSON(file));
  if (command.submission !== undefined || command.rerun !== undefined) fail("control file must contain only an intent");
  return command;
}

export async function assertOrderedSubmission(root: string, keyHash: string, input: OrderedEvalSubmission): Promise<void> {
  const file = evalCommandPath(root, keyHash);
  if (authorities.get(file) !== input.authority) fail("ordered submission must hold its command lock", "eval_control_required");
  const record = await readJSON<CommandRecord | null>(file, null);
  if (!record || record.eval_id !== input.evalId || record.subject_digest !== input.subjectDigest || record.sequence !== input.sequence || record.action !== "start") fail("a newer eval command fences submission", "eval_control_stale");
}

/** Admission and all controlled mutations use the original idempotency lock. */
export async function orderedEvalControl(root: string, value: unknown, evals: EvalScheduler, reruns: EvalRerunScheduler): Promise<Json> {
  const command = parseOrderedEvalCommand(value), keyHash = sha256Bytes(command.key), file = evalCommandPath(root, keyHash);
  return withFileLock(path.join(root, "locks", "eval-idempotency"), keyHash, async () => {
    let record = await readJSON<CommandRecord | null>(file, null);
    let index = await readJSON<{ eval_id: string; submission_digest: string } | null>(idempotencyIndexPath(root, keyHash), null);
    const evalId = validateEvalId(record?.eval_id ?? index?.eval_id ?? newEvalId());
    return withFileLock(path.join(root, "locks", "eval-command-mutations"), evalId, async () => {
      if (record) {
        if (record.schema_version !== "2" || record.key_hash !== keyHash || record.subject_digest !== command.subject_digest
          || !Number.isSafeInteger(record.sequence) || record.sequence < 0 || !["start", "pause"].includes(record.action) || !record.reruns || Array.isArray(record.reruns)
          || Object.entries(record.reruns).some(([id, value]) => !/^rerun_[a-f0-9]{32}$/.test(id) || !value || !/^sha256:[a-f0-9]{64}$/.test(value.digest)
            || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || value.sequence > record!.sequence
            || value.cancelled_by !== undefined && (!Number.isSafeInteger(value.cancelled_by) || value.cancelled_by < value.sequence || value.cancelled_by > record!.sequence))
          || index && index.eval_id !== evalId) fail("eval control identity changed", "eval_control_conflict");
        if (command.sequence < record.sequence) fail("a newer eval command fences this request", "eval_control_stale");
        if (command.sequence === record.sequence && command.action !== record.action) fail("eval control sequence cannot change meaning", "eval_control_conflict");
        // A newer start cannot erase a pause whose scheduler writes were interrupted.
        if (record.action === "pause" && command.action === "start") await applyPause(file, record, !!index, evals, reruns);
      }
      record = { schema_version: "2", key_hash: keyHash, subject_digest: command.subject_digest, eval_id: evalId,
        sequence: command.sequence, action: command.action, reruns: record?.reruns ?? {} };
      await atomicWriteJSON(file, record);
      await atomicWriteJSON(bindingPath(root, evalId), { schema_version: "2", key_hash: keyHash, eval_id: evalId });
      if (command.submission !== undefined) {
        const authority = Symbol("eval command"); authorities.set(file, authority);
        try {
          await evals.submit(command.submission as Parameters<EvalScheduler["submit"]>[0], { idempotencyKey: command.key,
            ordered: { evalId, subjectDigest: command.subject_digest, sequence: command.sequence, authority } });
        } finally { authorities.delete(file); }
        index = await readJSON(idempotencyIndexPath(root, keyHash), null);
      }
      let accepted: Json = {};
      if (command.rerun) {
        if (!index || command.rerun.eval_id !== evalId) fail("rerun must belong to the admitted eval", "eval_control_conflict");
        const id = String(command.rerun.input.rerun_id), digest = sha256JSON(command.rerun.input), old = record.reruns[id];
        if (old && old.digest !== digest) fail("rerun identity already belongs to another request", "eval_control_conflict");
        if (old?.cancelled_by !== undefined) fail("this rerun identity was cancelled", "eval_rerun_cancelled");
        record.reruns[id] ??= { digest, sequence: command.sequence }; await atomicWriteJSON(file, record);
        const result = await reruns.submit(evalId, command.rerun.input);
        accepted = { rerun_id: result.rerunId, rerun_type: result.rerunType };
      }
      if (command.action === "pause") {
        await applyPause(file, record, !!index, evals, reruns);
      }
      let pendingReruns = false;
      for (const id of Object.keys(record.reruns)) {
        const status = await reruns.status(evalId, id);
        pendingReruns ||= !!status && !["completed", "failed", "cancelled"].includes(String(status.state.status));
      }
      return { schema_version: "2", eval_id: evalId, subject_digest: command.subject_digest, sequence: command.sequence,
        action: command.action, submitted: !!index, pending_reruns: pendingReruns, ...accepted };
    });
  }, { timeoutCode: "idempotency_locked", timeoutExitCode: 12 });
}

async function applyPause(file: string, record: CommandRecord, submitted: boolean, evals: EvalScheduler, reruns: EvalRerunScheduler): Promise<void> {
  for (const value of Object.values(record.reruns)) value.cancelled_by ??= record.sequence;
  await atomicWriteJSON(file, record);
  if (submitted) await evals.cancel(record.eval_id);
  for (const id of Object.keys(record.reruns)) await reruns.cancel(record.eval_id, id);
}

/** Consult the durable intent before recovery can enqueue or resume execution. */
export async function orderedEvalCancelled(root: string, evalIdValue: string, rerunId?: string): Promise<boolean> {
  const evalId = validateEvalId(evalIdValue);
  const binding = await readJSON<{ key_hash: string } | null>(bindingPath(root, evalId), null);
  const submission = await readJSON<{ idempotency_key_hash?: string } | null>(path.join(statePaths(root).evals, evalId, "submission.json"), null);
  const hash = binding?.key_hash ?? submission?.idempotency_key_hash;
  if (!hash) return false;
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) fail("eval control key is invalid", "eval_control_conflict");
  const record = await readJSON<CommandRecord | null>(evalCommandPath(root, hash), null);
  if (!record) {
    if (binding) fail("eval control intent is missing", "eval_control_conflict");
    return false;
  }
  if (record.schema_version !== "2" || record.key_hash !== hash || record.eval_id !== evalId
    || !["start", "pause"].includes(record.action) || !record.reruns || typeof record.reruns !== "object" || Array.isArray(record.reruns)) {
    fail("eval control recovery identity changed", "eval_control_conflict");
  }
  return rerunId ? !!record.reruns[rerunId] && (record.action === "pause" || record.reruns[rerunId]!.cancelled_by !== undefined)
    : record.action === "pause";
}

/** Old daemon requests cannot mutate an eval after ordered control adopts it. */
export async function withLegacyEvalMutation<R>(root: string, evalIdValue: string, action: () => Promise<R>): Promise<R> {
  const evalId = validateEvalId(evalIdValue);
  const binding = await readJSON<{ key_hash: string } | null>(bindingPath(root, evalId), null);
  const submission = await readJSON<{ idempotency_key_hash?: string } | null>(path.join(statePaths(root).evals, evalId, "submission.json"), null);
  const hash = binding?.key_hash ?? submission?.idempotency_key_hash;
  const locked = () => withFileLock(path.join(root, "locks", "eval-command-mutations"), evalId, async () => {
    if (await readJSON(bindingPath(root, evalId), null) || hash && await readJSON(evalCommandPath(root, hash), null)) fail("eval requires ordered control", "eval_control_required");
    return action();
  });
  return hash ? withFileLock(path.join(root, "locks", "eval-idempotency"), hash, locked) : locked();
}
