import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { EvalTrialRefV1, RunObservationV1 } from "../domain/index.js";
import { validateRunObservation } from "../domain/index.js";
import { atomicWriteJSON, sha256Bytes, sha256JSON, statePaths } from "../foundation/index.js";
import { verifyResultBundleIndex } from "../runs/index.js";

/** A bounded inventory includes empty directories and rejects symlinks. */
export async function regradeTreeDigest(directory: string): Promise<string> {
  const files: unknown[] = [];
  let total = 0;
  async function visit(relative: string): Promise<void> {
    const absolute = path.join(directory, relative);
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("regrade input contains a symlink or special file");
    if (files.length >= 100_000 || (total += info.isFile() ? info.size : 0) > 4 * 1024 ** 3) throw new Error("regrade input exceeds inventory limits");
    if (info.isDirectory()) {
      files.push({ path: relative, type: "directory" });
      for (const name of (await readdir(absolute)).sort()) await visit(relative ? `${relative}/${name}` : name);
    } else {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(absolute)) hash.update(chunk);
      files.push({ path: relative, bytes: info.size, mode: info.mode & 0o777, sha256: `sha256:${hash.digest("hex")}` });
    }
  }
  await visit("");
  return sha256JSON(files);
}

export async function sealRegradeAssessment(directory: string, record: Record<string, unknown>): Promise<{ id: string; digest: string }> {
  const evidenceDigest = await regradeTreeDigest(path.join(directory, "evidence"));
  const manifest = { ...record, schema_version: "1", kind: "verifier-only-assessment", candidate_executes: false, evidence_digest: evidenceDigest };
  await atomicWriteJSON(path.join(directory, "assessment.json"), manifest);
  return { id: path.basename(directory), digest: sha256Bytes(await readFile(path.join(directory, "assessment.json"))) };
}

export async function readRegradeObservation(root: string, evalId: string, trial: EvalTrialRefV1): Promise<RunObservationV1> {
  if (trial.run_group) throw new Error("phase groups require their native phase assessment");
  const reference = trial.assessment;
  if (!reference || !/^assessment_[a-f0-9]{32}$/.test(reference.id) || !/^sha256:[a-f0-9]{64}$/.test(reference.digest)) throw new Error("invalid regrade assessment reference");
  const directory = path.join(statePaths(root).evals, evalId, "assessments", reference.id);
  const raw = await readFile(path.join(directory, "assessment.json"));
  if (sha256Bytes(raw) !== reference.digest) throw new Error("regrade assessment digest mismatch");
  const record = JSON.parse(raw.toString()) as Record<string, unknown>;
  const source = record.source as Record<string, unknown> | undefined;
  if (record.schema_version !== "1" || record.kind !== "verifier-only-assessment" || record.candidate_executes !== false
    || record.eval_id !== evalId || record.task_id !== trial.task_id || record.attempt !== trial.attempt
    || source?.trial_id !== trial.trial_id || source.run_id !== trial.run_id) throw new Error("regrade assessment source identity mismatch");
  if (record.evidence_digest !== await regradeTreeDigest(path.join(directory, "evidence"))) throw new Error("regrade assessment evidence changed");
  const sourceIndex = await verifyResultBundleIndex(path.join(statePaths(root).runs, trial.run_id));
  if (source.bundle_index_digest !== sha256JSON(sourceIndex)) throw new Error("regrade source run bundle changed");
  return validateRunObservation(record.observation);
}
