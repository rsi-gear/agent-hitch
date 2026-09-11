import path from "node:path";
import type { RemoteVerifierSourceManifestV2 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, readJSON, sha256JSON, statePaths } from "../foundation/index.js";
import { verifyResultBundleIndex } from "../runs/index.js";
import { parseRemoteVerifierSourceManifest, verifyRemoteVerifierSourceContents } from "./verifier-source.js";

/** The worker bundle and controller publication have distinct indexes. Bind them without rewriting either identity. */
export async function sealRemoteVerifierSourceImport(input: {
  root: string; runId: string; trialDirectory: string; manifest: RemoteVerifierSourceManifestV2;
  candidateResultDigest: string; candidateIdentityDigest: string; executionDigest: string;
}): Promise<void> {
  const manifest = parseRemoteVerifierSourceManifest(input.manifest);
  if (manifest.status !== "available" || manifest.run_id !== input.runId) throw invalid("verifier source publication changed its candidate");
  const canonical = await canonicalIdentity(input.root, input.runId);
  if (canonical.candidate_result_digest !== input.candidateResultDigest) throw invalid("verifier source publication changed the candidate result");
  if (canonical.candidate_identity_digest !== input.candidateIdentityDigest || canonical.execution_digest !== input.executionDigest) throw invalid("verifier source publication changed the candidate identity or execution");
  const stored = await readJSON(path.join(input.trialDirectory, "verifier-source.json"));
  if (sha256JSON(stored) !== sha256JSON(manifest)
    || sha256JSON(await readJSON(path.join(input.trialDirectory, "result.json"))) !== manifest.source_result_digest) throw invalid("verifier source changed before publication");
  await atomicWriteJSON(path.join(input.trialDirectory, "verifier-source.import.json"), {
    schema_version: "2", source_manifest_digest: sha256JSON(manifest), ...canonical,
  });
}

export async function verifyImportedRemoteVerifierSource(input: {
  root: string; runId: string; trialDirectory: string; taskDirectory: string;
}): Promise<RemoteVerifierSourceManifestV2 & { status: "available" }> {
  const manifest = parseRemoteVerifierSourceManifest(await readJSON(path.join(input.trialDirectory, "verifier-source.json")));
  if (manifest.status !== "available" || manifest.run_id !== input.runId) throw invalid("verifier source is unavailable for this candidate");
  const canonical = await canonicalIdentity(input.root, input.runId);
  const receipt = await readJSON(path.join(input.trialDirectory, "verifier-source.import.json"));
  if (sha256JSON(receipt) !== sha256JSON({ schema_version: "2", source_manifest_digest: sha256JSON(manifest), ...canonical })
    || sha256JSON(await readJSON(path.join(input.trialDirectory, "result.json"))) !== manifest.source_result_digest) throw invalid("verifier source import receipt does not match its candidate");
  await verifyRemoteVerifierSourceContents({ manifest, snapshotDirectory: path.join(input.trialDirectory, "verifier-source"),
    taskDirectory: input.taskDirectory, bundleDirectory: path.join(statePaths(input.root).runs, input.runId) });
  return manifest;
}

async function canonicalIdentity(root: string, runId: string): Promise<Record<string, string>> {
  if (!/^run_[a-f0-9]{32}$/.test(runId)) throw invalid("invalid verifier source candidate identity");
  const directory = path.join(statePaths(root).runs, runId), index = await verifyResultBundleIndex(directory);
  const result = await readJSON<Record<string, unknown>>(path.join(directory, "result.json"));
  if (index.run_id !== runId || result.run_id !== runId || result.status !== "succeeded") throw invalid("verifier source candidate did not succeed");
  const { observation: _observation, ...candidateIdentity } = await readJSON<Record<string, unknown>>(path.join(directory, "manifest.json"));
  return { canonical_bundle_digest: sha256JSON(index), candidate_result_digest: sha256JSON(result),
    candidate_identity_digest: sha256JSON(candidateIdentity), execution_digest: sha256JSON(await readJSON(path.join(directory, "execution.json"), null)) };
}
function invalid(message: string): HitchError { return new HitchError(message, { code: "remote_verifier_source_invalid", exitCode: 12 }); }
