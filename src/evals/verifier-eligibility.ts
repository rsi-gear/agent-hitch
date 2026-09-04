import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export interface CandidateIneligibleDiagnosticV1 {
  schema_version: "1";
  code: "candidate_evidence_unavailable";
  run_id: string;
  candidate_bundle: "missing" | "invalid";
  reason_code: string;
  verifier_executed: false;
}

export async function readCandidateIneligibleDiagnostic(trialDirectory: string): Promise<CandidateIneligibleDiagnosticV1 | null> {
  const source = path.join(trialDirectory, "verifier", "candidate-ineligible.json");
  try {
    const info = await lstat(source);
    if (!info.isFile() || info.size <= 0 || info.size > 16 * 1024) return null;
    const value = JSON.parse(await readFile(source, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["schema_version", "code", "run_id", "candidate_bundle", "reason_code", "verifier_executed"].includes(key))
      || record.schema_version !== "1" || record.code !== "candidate_evidence_unavailable"
      || typeof record.run_id !== "string" || !/^run_[a-f0-9]{32}$/.test(record.run_id)
      || record.candidate_bundle !== "missing" && record.candidate_bundle !== "invalid"
      || typeof record.reason_code !== "string" || !record.reason_code || record.verifier_executed !== false) return null;
    return record as unknown as CandidateIneligibleDiagnosticV1;
  } catch {
    return null;
  }
}
