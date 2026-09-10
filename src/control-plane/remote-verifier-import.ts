import { lstat, mkdtemp, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { EvalTrialRefV1 } from "../domain/index.js";
import { HitchError, ensureDir, readJSON, sha256Bytes, sha256JSON, statePaths, withFileLock } from "../foundation/index.js";
import { parseEvalTrialRef, regradeTreeDigest, sealRemoteVerifierAssessment, validateEvalTrialReferences, validateRemoteVerifierAssessment } from "../evals/index.js";
import type { RemoteVerifierAssessmentInput } from "../evals/index.js";
import { materializeRemoteTreeEnvelope, removeMaterializedTree } from "./remote-work-inputs.js";
import { readRemoteVerifierResultEnvelope } from "./remote-verifier-result.js";

export async function importRemoteVerifierResultEnvelope(input: Omit<RemoteVerifierAssessmentInput, "outcome" | "resultDigest"> & { artifactPath: string; signal?: AbortSignal }) {
  const envelope = await readRemoteVerifierResultEnvelope(input.artifactPath), resultDigest = sha256JSON(envelope);
  if (path.resolve(input.evalDirectory) !== path.join(statePaths(input.root).evals, input.plan.eval_id)
    || envelope.verifier_work_digest !== sha256JSON(input.verifier) || envelope.eval_id !== input.lease.eval_id
    || envelope.work_id !== input.lease.work_id || envelope.lease_id !== input.lease.lease_id || envelope.lease_epoch !== input.lease.epoch) throw invalid();
  const args = { ...input, outcome: envelope.outcome, resultDigest };
  await validateRemoteVerifierAssessment(args);
  const parent = await ensureDir(path.join(input.evalDirectory, "assessments")), directory = path.join(parent, input.verifier.assessment_id);
  return withFileLock(path.join(input.evalDirectory, "assessment-locks"), input.verifier.assessment_id, async () => {
    input.signal?.throwIfAborted();
    const existing = await lstat(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw invalid();
    if (!existing) {
      const staging = await mkdtemp(path.join(parent, `.${input.verifier.assessment_id}-`));
      try {
        await materializeRemoteTreeEnvelope(envelope.evidence, path.join(staging, "evidence"));
        await sealRemoteVerifierAssessment({ ...args, directory: staging });
        input.signal?.throwIfAborted();
        await rename(staging, directory);
      } finally { await removeMaterializedTree(staging); }
    }
    await validateRemoteVerifierAssessment(args);
    const raw = await readFile(path.join(directory, "assessment.json")), record = JSON.parse(raw.toString()) as Record<string, unknown>;
    const publication = parseEvalTrialRef(await readJSON(path.join(directory, "publication.json")));
    if (record.remote_result_digest !== resultDigest || record.remote_verifier_work_digest !== sha256JSON(input.verifier)
      || record.schema_version !== "1" || record.kind !== "verifier-only-assessment" || record.candidate_executes !== false
      || record.remote_publication_digest !== sha256JSON(publication) || record.evidence_digest !== await regradeTreeDigest(path.join(directory, "evidence"))
      || publication.trial_id !== input.verifier.source_ref.trial_id || publication.run_id !== input.verifier.source_ref.run_id
      || publication.task_id !== input.verifier.source_ref.task_id || publication.attempt !== input.verifier.source_ref.attempt
      || publication.assessment || publication.run_group
      || publication.observation_status === "invalid" && sha256JSON(publication) !== sha256JSON(input.verifier.source_ref)) throw invalid();
    const assessment = { id: input.verifier.assessment_id, digest: sha256Bytes(raw) };
    const ref: EvalTrialRefV1 = publication.observation_status === "valid" ? { ...publication, assessment } : publication;
    await validateEvalTrialReferences(input.root, input.plan.eval_id, [ref], { benchmarkId: input.plan.benchmark.id, benchmarkRevision: input.plan.benchmark.revision });
    return { ref, assessment, trial: envelope.outcome.trial, backendDirectory: directory, outcome: envelope.outcome };
  }, { timeoutCode: "remote_verifier_assessment_locked", timeoutExitCode: 12 });
}
function invalid(): HitchError { return new HitchError("remote verifier assessment publication conflicts with its sealed result", { code: "remote_verifier_result_invalid", exitCode: 12 }); }
