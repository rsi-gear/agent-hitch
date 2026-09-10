import path from "node:path";
import type { EvalTrialRefV1 } from "../domain/index.js";
import { HitchError, readJSON, sha256JSON, statePaths } from "../foundation/index.js";
import { loadRunRecord, verifyResultBundleIndex } from "../runs/index.js";
import { parseExecutionEvidence } from "./execution-evidence.js";
import { parseEvalTrialRef } from "./progress.js";
import { validateEvalTrialReferences } from "./trial-import.js";
import { verifyImportedRemoteVerifierSource } from "./verifier-source-import.js";

/** Locate imported artifacts using the canonical candidate's actual execution, including candidate-restart work. */
export async function loadRemoteVerifierSource(input: {
  root: string; evalDirectory: string; evalId: string; provider: string; sourceRef: EvalTrialRefV1;
  taskDirectory: string; benchmarkId: string; benchmarkRevision: string;
}) {
  const original = parseEvalTrialRef(input.sourceRef);
  if (original.run_group || original.assessment || original.observation_status !== "invalid"
    || !["verifier_infrastructure_failure", "verifier_result_missing"].includes(original.invalid_reason ?? "")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(original.trial_id)) throw invalid();
  await validateEvalTrialReferences(input.root, input.evalId, [original], { benchmarkId: input.benchmarkId, benchmarkRevision: input.benchmarkRevision });
  const runDirectory = path.join(statePaths(input.root).runs, original.run_id);
  const bundle = await verifyResultBundleIndex(runDirectory), candidate = await loadRunRecord(runDirectory, { verifyTrajectory: true });
  if (candidate.record.status !== "succeeded" || candidate.record_status !== "valid" || candidate.trajectory_status !== "valid") throw invalid();
  const execution = parseExecutionEvidence(await readJSON(path.join(runDirectory, "execution.json")));
  if (execution.eval_id !== input.evalId || execution.provider !== input.provider || execution.task_id !== original.task_id) throw invalid();
  const trialDirectory = path.join(input.evalDirectory, "harbor", "work-items", execution.work_id,
    `epoch-${String(execution.lease_epoch).padStart(6, "0")}`, "job", original.trial_id);
  const manifest = await verifyImportedRemoteVerifierSource({ root: input.root, runId: original.run_id, trialDirectory, taskDirectory: input.taskDirectory });
  if (!manifest.original_result_digest || !manifest.regrade_config_digest) throw invalid();
  const sourceTrial = await readJSON<Record<string, unknown>>(path.join(trialDirectory, "result.json"));
  const candidateResult = await readJSON<Record<string, unknown>>(path.join(runDirectory, "result.json"));
  return { original, manifest, sourceTrial, candidateResult, execution, trialDirectory, sourceSnapshotDirectory: path.join(trialDirectory, "verifier-source"),
    canonicalBundleDigest: sha256JSON(bundle), candidateResultDigest: sha256JSON(candidateResult) };
}
function invalid(): HitchError { return new HitchError("remote verifier source has no intact original candidate and import receipt", { code: "eval_verifier_only_unavailable", exitCode: 2 }); }
