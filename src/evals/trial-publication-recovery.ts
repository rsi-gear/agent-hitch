import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { EvalExecutionPlanV1, EvalProgressV1, EvalTrialRefV1 } from "../domain/index.js";
import { HitchError, readJSON, sha256Bytes, statePaths } from "../foundation/index.js";
import { verifyResultBundleIndex } from "../runs/index.js";
import { evalTrialKey, mergeEvalProgressTrial, replaceInvalidEvalProgressTrial, writeEvalProgress } from "./progress.js";
import type { EvalEventSink } from "./events.js";
import { validateEvalTrialReferences } from "./trial-import.js";
import { EVAL_TRIAL_PUBLICATION_REF, parseEvalTrialPublication } from "./trial-publication.js";
import type { EvalTrialPublicationMode, EvalTrialPublicationV1 } from "./trial-publication.js";

const RUN_ID = /^run_[a-f0-9]{32}$/;

export interface RecoveredEvalTrialPublication {
  mode: EvalTrialPublicationMode;
  trial: EvalTrialRefV1;
}

export async function recoverPromotedEvalTrialPublications(input: {
  root: string;
  evalDirectory: string;
  plan: EvalExecutionPlanV1;
  progress: EvalProgressV1;
  sink?: EvalEventSink;
}): Promise<{ progress: EvalProgressV1; recovered: RecoveredEvalTrialPublication[] }> {
  const evalId = input.plan.eval_id;
  const publications = await readEvalTrialPublications(input.root, evalId);
  const bySlot = new Map<string, EvalTrialPublicationV1[]>();
  for (const publication of publications) {
    assertPublicationBelongsToPlan(publication, input.plan);
    if (!publication.trial.run_group) await verifyResultBundleIndex(path.join(statePaths(input.root).runs, publication.trial.run_id));
    await validateEvalTrialReferences(input.root, evalId, [publication.trial], {
      benchmarkId: input.plan.benchmark.id,
      benchmarkRevision: input.plan.benchmark.revision,
    });
    const key = evalTrialKey(publication.trial);
    const entries = bySlot.get(key) ?? [];
    entries.push(publication);
    bySlot.set(key, entries);
  }

  let progress = input.progress;
  const recovered: RecoveredEvalTrialPublication[] = [];
  for (const key of [...bySlot.keys()].sort()) {
    const entries = bySlot.get(key) as EvalTrialPublicationV1[];
    const settlements = entries.filter((entry) => entry.mode === "settle");
    const repairs = entries.filter((entry) => entry.mode === "replace-invalid" && entry.trial.observation_status === "valid");
    if (settlements.length > 1) throw conflict(`multiple promoted authoritative runs exist for ${formatTrial(settlements[0]!.trial)}`);
    if (repairs.length > 1) throw conflict(`multiple promoted repair runs exist for ${formatTrial(repairs[0]!.trial)}`);
    const selected = repairs[0] ?? settlements[0];
    if (!selected) continue;
    const current = progress.trials.find((trial) => evalTrialKey(trial) === key);
    if (current && JSON.stringify(current) === JSON.stringify(selected.trial)) continue;
    if (current && selected.mode === "settle") {
      throw conflict(`promoted run conflicts with durable progress for ${formatTrial(selected.trial)}`);
    }
    if (current?.observation_status === "valid") {
      throw conflict(`promoted repair conflicts with an existing valid run for ${formatTrial(selected.trial)}`);
    }
    progress = selected.mode === "replace-invalid"
      ? replaceInvalidEvalProgressTrial(progress, selected.trial)
      : mergeEvalProgressTrial(progress, selected.trial);
    recovered.push({ mode: selected.mode, trial: selected.trial });
  }
  if (recovered.length > 0) await writeEvalProgress(input.evalDirectory, progress);
  for (const item of recovered) input.sink?.emit({
    type: "eval.trial.publication-recovered", mode: item.mode, trial_id: item.trial.trial_id,
    task_id: item.trial.task_id, attempt: item.trial.attempt, run_id: item.trial.run_id,
    ...(item.trial.run_group ? { run_group_id: item.trial.run_group.run_group_id } : {}),
    observation_status: item.trial.observation_status, generation: progress.generation,
  });
  return { progress, recovered };
}

async function readEvalTrialPublications(root: string, evalId: string): Promise<EvalTrialPublicationV1[]> {
  let entries: Dirent[];
  try { entries = await readdir(statePaths(root).runs, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
    else throw error;
  }
  const result: EvalTrialPublicationV1[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
    const value = await readJSON<unknown | null>(path.join(statePaths(root).runs, entry.name, EVAL_TRIAL_PUBLICATION_REF), null);
    if (value === null || !belongsToEval(value, evalId)) continue;
    result.push(parseEvalTrialPublication(value, entry.name));
  }
  const assessments = path.join(statePaths(root).evals, evalId, "assessments");
  let assessmentEntries;
  try { assessmentEntries = await readdir(assessments, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
  for (const entry of assessmentEntries) {
    if (!entry.isDirectory() || !/^assessment_[a-f0-9]{32}$/.test(entry.name)) continue;
    let value = await readJSON<unknown | null>(path.join(assessments, entry.name, EVAL_TRIAL_PUBLICATION_REF), null);
    if (value === null) {
      // assessment.json is the immutable commit. Recover a crash between its
      // publication and writing the convenience publication receipt.
      const manifestPath = path.join(assessments, entry.name, "assessment.json");
      const record = await readJSON<Record<string, unknown> | null>(manifestPath, null);
      if (record?.kind === "native-phase-assessment" && record.eval_id === evalId) {
        const observation = record.observation as Record<string, unknown>;
        value = { schema_version: "1", eval_id: evalId, mode: record.publication_mode, created_at: record.created_at,
          trial: { trial_id: record.trial_id, task_id: record.task_id, attempt: record.attempt, run_group: record.run_group,
            assessment: { id: entry.name, digest: sha256Bytes(await readFile(manifestPath)) }, observation_status: observation.status,
            ...(observation.reward !== undefined ? { reward: observation.reward } : {}),
            ...(record.scores !== undefined ? { scores: record.scores } : {}),
            ...(observation.invalid_reason ? { invalid_reason: observation.invalid_reason } : {}),
            ...(observation.verifier_result_ref ? { verifier_result_ref: observation.verifier_result_ref } : {}) } };
      }
    }
    if (value === null || !belongsToEval(value, evalId)) continue;
    const publication = parseEvalTrialPublication(value);
    if (!publication.trial.run_group || publication.trial.assessment.id !== entry.name) throw conflict("native phase publication assessment mismatch");
    result.push(publication);
  }
  return result;
}

function belongsToEval(value: unknown, evalId: string): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).eval_id === evalId);
}

function assertPublicationBelongsToPlan(publication: EvalTrialPublicationV1, plan: EvalExecutionPlanV1): void {
  if (publication.eval_id !== plan.eval_id) throw conflict("promoted run belongs to another eval plan");
  const trial = publication.trial;
  const planned = plan.membership === "known"
    ? plan.slots.some((slot) => slot.task_id === trial.task_id && slot.attempt === trial.attempt)
    : plan.work_items.some((work) => work.logical_attempt === trial.attempt
      && (work.task_ids.length === 0 || work.task_ids.includes(trial.task_id)));
  if (!planned) throw conflict(`promoted run is outside the frozen plan: ${formatTrial(trial)}`);
}

function formatTrial(trial: Pick<EvalTrialRefV1, "task_id" | "attempt">): string {
  return `${trial.task_id} attempt ${trial.attempt}`;
}

function conflict(message: string): HitchError {
  return new HitchError(message, { code: "eval_trial_publication_conflict", exitCode: 12 });
}
