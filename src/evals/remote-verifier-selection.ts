import { readdir } from "node:fs/promises";
import path from "node:path";
import type { EvalExecutionPlanV1, EvalProgressV1, EvalRequest, EvalTrialRefV1, RemoteVerifierWorkV2 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, readJSON, sha256JSON } from "../foundation/index.js";
import { verifierOnlyWorkItem } from "./physical-work-plan.js";
import { assertRemoteVerifierWork, parseRemoteVerifierWork } from "./remote-verifier-contract.js";
import { loadRemoteVerifierSource } from "./remote-verifier-source.js";
import type { EvalTrialSlot } from "./rerun-slots.js";

export async function freezeRemoteVerifierSelection(input: {
  root: string; evalId: string; evalDirectory: string; rerunId: string; rerunDirectory: string;
  plan: EvalExecutionPlanV1; request: EvalRequest; slots: EvalTrialSlot[]; progress: EvalProgressV1;
  taskRoot: string; sourceRuntimeId: string; verifierRuntimeId: string;
}) {
  const identity = { schema_version: "2", eval_id: input.evalId, rerun_id: input.rerunId,
    plan_digest: sha256JSON(input.plan), request_digest: sha256JSON(input.request), selected_slots_digest: sha256JSON(input.slots),
    source_runtime_id: input.sourceRuntimeId, verifier_runtime_id: input.verifierRuntimeId };
  const file = path.join(input.rerunDirectory, "verifier-selection.json");
  const saved = await readJSON<{ identity: unknown; items: Array<{ slot: EvalTrialSlot; source_work_id: string; work_id: string; descriptor: RemoteVerifierWorkV2 }> } | null>(file, null);
  if (saved && (sha256JSON(saved.identity) !== sha256JSON(identity) || !Array.isArray(saved.items) || saved.items.length !== input.slots.length)) throw ambiguous();
  if (!saved && (await readdir(path.join(input.rerunDirectory, "remote-work")).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  })).length) throw ambiguous();
  const items = [];
  for (const [index, slot] of input.slots.entries()) {
    const frozen = saved?.items[index];
    if (saved && (!frozen || sha256JSON(frozen.slot) !== sha256JSON(slot))) throw ambiguous();
    const original = frozen ? parseRemoteVerifierWork(frozen.descriptor).source_ref
      : input.progress.trials.find(ref => ref.task_id === slot.task_id && ref.attempt === slot.attempt);
    if (!original) throw ambiguous();
    const source = await loadRemoteVerifierSource({ ...input, sourceRef: original, provider: input.plan.provider,
      taskDirectory: path.join(input.taskRoot, slot.task_id), benchmarkId: input.request.benchmark_id, benchmarkRevision: input.request.benchmark_revision });
    const logical = input.plan.slots.find(s => s.task_id === slot.task_id && s.attempt === slot.attempt);
    const planned = logical && input.plan.work_items.find(w => w.slots.includes(logical.slot_id));
    if (!planned) throw ambiguous();
    const assessmentId = `assessment_${sha256JSON({ rerun_id: input.rerunId, source_ref: original,
      source_manifest: source.manifest, verifier_runtime_id: input.verifierRuntimeId }).slice(7, 39)}`;
    const descriptor = parseRemoteVerifierWork({ schema_version: "2", kind: "verifier-only", assessment_id: assessmentId,
      source_ref: original, source_manifest: source.manifest, source_trial: source.sourceTrial, candidate_result: source.candidateResult,
      candidate_result_digest: source.candidateResultDigest, canonical_bundle_digest: source.canonicalBundleDigest, verifier_runtime_id: input.verifierRuntimeId });
    const work = verifierOnlyWorkItem(planned, input.rerunId, assessmentId);
    const physical = { schema_version: "2" as const, kind: "verifier-only" as const, source_work_id: planned.work_id, rerun_id: input.rerunId, assessment_id: assessmentId };
    assertRemoteVerifierWork({ verifier: descriptor, plan: input.plan, work, physical, runtimeId: input.sourceRuntimeId });
    const record = { slot, source_work_id: planned.work_id, work_id: work.work_id, descriptor };
    if (frozen && sha256JSON(frozen) !== sha256JSON(record)) throw ambiguous();
    items.push({ record, work, physical, source });
  }
  // Seal the entire selection before the first offer, including undispatched slots.
  if (!saved) await atomicWriteJSON(file, { identity, items: items.map(item => item.record) });
  return items;
}

export function assertRemoteVerifierPublication(original: EvalTrialRefV1, ref: EvalTrialRefV1, assessmentId: string): void {
  if (ref.task_id !== original.task_id || ref.attempt !== original.attempt || ref.trial_id !== original.trial_id || ref.run_id !== original.run_id
    || ref.observation_status === "valid" && ref.assessment?.id !== assessmentId
    || ref.observation_status !== "valid" && sha256JSON(ref) !== sha256JSON(original)) throw ambiguous();
}
function ambiguous(): HitchError { return new HitchError("remote verifier selection or original candidate changed", { code: "execution_state_ambiguous", exitCode: 12 }); }
