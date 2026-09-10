import { lstat, readFile } from "node:fs/promises";
import type { ExecutionLeaseV1, RemoteVerifierOutcomeV2, RemoteVerifierWorkV2 } from "../domain/index.js";
import { HitchError, sha256JSON } from "../foundation/index.js";
import { parseRemoteVerifierOutcome, parseRemoteVerifierWork, portableRemoteTrial, regradeTreeDigest } from "../evals/index.js";
import type { runRemoteVerifierWork } from "../evals/index.js";
import { encodeRemoteTreeEnvelope, parseRemoteTreeEnvelope } from "./remote-work-inputs.js";
import type { RemoteTreeEnvelopeV1 } from "./remote-work-inputs.js";

const MAX_BYTES = 64 * 1024 ** 2;
export interface RemoteVerifierResultEnvelopeV2 {
  schema_version: "2";
  kind: "verifier-only-result";
  eval_id: string; work_id: string; lease_id: string; lease_epoch: number;
  verifier_work_digest: string;
  outcome: RemoteVerifierOutcomeV2;
  evidence: RemoteTreeEnvelopeV1;
}

export async function encodeRemoteVerifierResultEnvelope(input: {
  lease: ExecutionLeaseV1; verifier: RemoteVerifierWorkV2; outcome: Awaited<ReturnType<typeof runRemoteVerifierWork>>;
  verifierDirectory: string;
}): Promise<Buffer> {
  const verifier = parseRemoteVerifierWork(input.verifier), outcome = input.outcome;
  if (outcome.source_manifest_digest !== sha256JSON(verifier.source_manifest) || outcome.candidate_result_digest !== verifier.candidate_result_digest) throw invalid();
  const evidence = await verifierTree(input.verifierDirectory);
  const value = parseRemoteVerifierResultEnvelope({ schema_version: "2", kind: "verifier-only-result",
    eval_id: input.lease.eval_id, work_id: input.lease.work_id, lease_id: input.lease.lease_id, lease_epoch: input.lease.epoch,
    verifier_work_digest: sha256JSON(verifier), evidence,
    outcome: { trial: portableRemoteTrial(outcome.trial), backend: { process_exit_code: outcome.backend.process_exit_code, signal: outcome.backend.signal },
      execution: outcome.execution, config_digest: outcome.config_digest, controller_runtime_id: outcome.controller_runtime_id,
      ...(outcome.runtime_repair ? { runtime_repair: outcome.runtime_repair } : {}) } });
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  if (body.length > MAX_BYTES) throw invalid();
  return body;
}

export async function readRemoteVerifierResultEnvelope(file: string): Promise<RemoteVerifierResultEnvelopeV2> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES) throw invalid();
  return parseRemoteVerifierResultEnvelope(JSON.parse(await readFile(file, "utf8")));
}

export function parseRemoteVerifierResultEnvelope(value: unknown): RemoteVerifierResultEnvelopeV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const r = value as Record<string, unknown>;
  const keys = ["schema_version", "kind", "eval_id", "work_id", "lease_id", "lease_epoch", "verifier_work_digest", "outcome", "evidence"];
  if (Object.keys(r).length !== keys.length || Object.keys(r).some(key => !keys.includes(key)) || r.schema_version !== "2" || r.kind !== "verifier-only-result"
    || !["eval", "work", "lease"].every(prefix => typeof r[`${prefix}_id`] === "string" && new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(r[`${prefix}_id`] as string))
    || !Number.isSafeInteger(r.lease_epoch) || Number(r.lease_epoch) < 1
    || typeof r.verifier_work_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(r.verifier_work_digest)) throw invalid();
  const evidence = parseRemoteTreeEnvelope(r.evidence), outcome = parseRemoteVerifierOutcome(r.outcome);
  if (evidence.symlinks.length || !evidence.directories.some(d => d.path === "verifier")
    || evidence.directories.some(d => d.path !== "verifier" && !d.path.startsWith("verifier/"))
    || evidence.files.some(f => !f.path.startsWith("verifier/")) || evidence.files.reduce((total, file) => total + file.size, 0) > MAX_BYTES
    || outcome.execution.eval_id !== r.eval_id || outcome.execution.work_id !== r.work_id
    || outcome.execution.lease_id !== r.lease_id || outcome.execution.lease_epoch !== r.lease_epoch) throw invalid();
  return { ...r, outcome, evidence } as unknown as RemoteVerifierResultEnvelopeV2;
}

async function verifierTree(directory: string): Promise<RemoteTreeEnvelopeV1> {
  const info = await lstat(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw invalid();
  const before = info ? await regradeTreeDigest(directory, MAX_BYTES) : undefined;
  const tree = info ? JSON.parse((await encodeRemoteTreeEnvelope(directory)).toString()) as RemoteTreeEnvelopeV1
    : { schema_version: "1" as const, files: [], directories: [], symlinks: [] };
  if (info && await regradeTreeDigest(directory, MAX_BYTES) !== before) throw invalid();
  return parseRemoteTreeEnvelope({ schema_version: "1", files: tree.files.map(f => ({ ...f, path: `verifier/${f.path}` })),
    directories: [{ path: "verifier", mode: 0o700 }, ...tree.directories.map(d => ({ ...d, path: `verifier/${d.path}` }))], symlinks: tree.symlinks });
}
function invalid(): HitchError { return new HitchError("remote verifier result is not bounded scoring evidence for its sealed work", { code: "remote_verifier_result_invalid", exitCode: 12 }); }
