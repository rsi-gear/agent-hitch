import path from "node:path";
import type { EvalTrialRefV1, RunObservationV1 } from "../domain/index.js";
import { statePaths } from "../foundation/index.js";
import { benchmarkVerifierIdentity, loadRunRecord } from "../runs/index.js";
import { readRegradeObservation } from "./regrade-evidence.js";
import { readNativePhaseObservation } from "./native-phase-evidence.js";

export async function validateEvalTrialReferences(
  root: string,
  evalId: string,
  trials: EvalTrialRefV1[],
  expected?: { benchmarkId: string; benchmarkRevision: string },
): Promise<void> {
  for (const trial of trials) {
    let observation: RunObservationV1 | undefined;
    if (trial.run_group) observation = await readNativePhaseObservation(root, evalId, trial, expected);
    else {
      const loaded = await loadRunRecord(path.join(statePaths(root).runs, trial.run_id), { verifyTrajectory: false });
      const record = loaded.record;
      if (record.context.kind !== "benchmark_task") throw new Error(`eval trial ${trial.trial_id} references a non-benchmark run`);
      if (expected && (
        record.context.benchmark_id !== expected.benchmarkId
        || record.context.benchmark_revision !== expected.benchmarkRevision
        || record.context.verifier_identity !== benchmarkVerifierIdentity(expected.benchmarkId, expected.benchmarkRevision)
      )) throw new Error(`eval trial ${trial.trial_id} benchmark identity mismatch`);
      if (record.parent?.eval_id !== evalId || record.parent.trial_id !== trial.trial_id || record.parent.attempt !== trial.attempt) {
        throw new Error(`eval trial ${trial.trial_id} parent mismatch`);
      }
      if (record.context.task_id !== trial.task_id) throw new Error(`eval trial ${trial.trial_id} task mismatch`);
      observation = trial.assessment ? await readRegradeObservation(root, evalId, trial) : record.observation;
    }
    if (observation?.status !== trial.observation_status) throw new Error(`eval trial ${trial.trial_id} observation status mismatch`);
    if (observation?.reward !== trial.reward) throw new Error(`eval trial ${trial.trial_id} reward mismatch`);
    if (observation?.verifier_result_ref !== trial.verifier_result_ref) throw new Error(`eval trial ${trial.trial_id} verifier ref mismatch`);
    if (observation?.invalid_reason !== trial.invalid_reason) throw new Error(`eval trial ${trial.trial_id} invalid reason mismatch`);
  }
}
