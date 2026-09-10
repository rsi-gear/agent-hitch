import path from "node:path";
import type { RemoteVerifierSourceManifestV2, RemoteWorkOfferV1 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, readJSON, sha256JSON } from "../foundation/index.js";
import { parseRemoteVerifierSourceManifest, sealRemoteVerifierSourceImport, verifyRemoteVerifierSourceSnapshot } from "../evals/index.js";
import type { RemoteVerifierSourceCapture } from "../evals/index.js";
import { RemoteWorkInputStore, encodeRemoteTreeEnvelope, materializeRemoteTreeEnvelope, parseRemoteTreeEnvelope } from "./remote-work-inputs.js";
import type { RemoteTreeEnvelopeV1 } from "./remote-work-inputs.js";

export interface RemoteVerifierSourceTransportV2 { manifest: RemoteVerifierSourceManifestV2; tree?: RemoteTreeEnvelopeV1 }

export async function verifierSourceRequested(root: string, offer: RemoteWorkOfferV1): Promise<boolean> {
  const ref = offer.inputs?.find(input => input.kind === "work-spec");
  if (!ref) return false;
  const spec = await readJSON<Record<string, unknown>>((await new RemoteWorkInputStore(root).verify(ref)).path);
  if (spec.verifier_source === undefined) return false;
  if (spec.schema_version !== "2" || spec.verifier_source !== "2") throw invalid("sealed work spec has an invalid verifier source contract");
  return true;
}

export async function encodeVerifierSource(capture: RemoteVerifierSourceCapture): Promise<RemoteVerifierSourceTransportV2> {
  const manifest = parseRemoteVerifierSourceManifest(capture.manifest);
  if (manifest.status === "unavailable") return { manifest };
  if (!capture.directory) throw invalid("available verifier source has no snapshot");
  return parseVerifierSource({ manifest, tree: JSON.parse((await encodeRemoteTreeEnvelope(capture.directory)).toString()) });
}

export function parseVerifierSource(value: unknown): RemoteVerifierSourceTransportV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("verifier source transport is invalid");
  const r = value as Record<string, unknown>, manifest = parseRemoteVerifierSourceManifest(r.manifest);
  if (Object.keys(r).sort().join(",") !== (manifest.status === "available" ? "manifest,tree" : "manifest")) throw invalid("verifier source has unexpected fields");
  if (manifest.status === "unavailable") return { manifest };
  const tree = parseRemoteTreeEnvelope(r.tree);
  if (tree.symlinks.length || tree.directories.some(d => d.path !== "artifacts" && !d.path.startsWith("artifacts/"))
    || tree.files.some(f => !f.path.startsWith("artifacts/") && !["benchmark-lifecycle.json", "hitch-final-response.json", "regrade-config.json"].includes(f.path))
    || tree.files.some(f => f.path === "regrade-config.json") !== !!manifest.regrade_config_digest
    || !tree.directories.some(d => d.path === "artifacts") || !tree.files.some(f => f.path === "benchmark-lifecycle.json")) {
    throw invalid("verifier source may contain only recorded artifacts and host receipts");
  }
  return { manifest, tree };
}

export async function importVerifierSource(input: {
  source: RemoteVerifierSourceTransportV2; trial: Record<string, unknown>; trialDirectory: string;
  taskId: string; taskDirectory: string; bundleDirectory: string; runtimeId?: string;
}): Promise<(input: { root: string; runId: string }) => Promise<void>> {
  const source = parseVerifierSource(input.source), m = source.manifest;
  const candidate = await readJSON<Record<string, unknown>>(path.join(input.bundleDirectory, "manifest.json"));
  const metadata = (input.trial.agent_result as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  if (m.task_id !== input.taskId || m.trial_id !== input.trial.trial_name || m.run_id !== candidate.run_id
    || m.source_result_digest !== sha256JSON(input.trial) || input.runtimeId && m.controller_runtime_id !== input.runtimeId
    || m.status === "available" && (m.run_id !== metadata?.hitch_run_id || m.controller_runtime_id !== metadata.controller_runtime_id)) {
    throw invalid("verifier source differs from its original candidate/task/runtime");
  }
  if (m.status === "available") {
    const snapshotDirectory = path.join(input.trialDirectory, "verifier-source");
    await materializeRemoteTreeEnvelope(source.tree, snapshotDirectory);
    await verifyRemoteVerifierSourceSnapshot({ manifest: m, snapshotDirectory, taskDirectory: input.taskDirectory, bundleDirectory: input.bundleDirectory });
  }
  await atomicWriteJSON(path.join(input.trialDirectory, "verifier-source.json"), m);
  await atomicWriteJSON(path.join(input.trialDirectory, "result.json"), input.trial);
  const candidateResultDigest = sha256JSON(await readJSON(path.join(input.bundleDirectory, "result.json")));
  const { observation: _observation, ...candidateIdentity } = candidate;
  const candidateIdentityDigest = sha256JSON(candidateIdentity);
  const executionDigest = sha256JSON(await readJSON(path.join(input.bundleDirectory, "execution.json"), null));
  return async ({ root, runId }) => {
    if (m.status === "available") await sealRemoteVerifierSourceImport({ root, runId, trialDirectory: input.trialDirectory,
      manifest: m, candidateResultDigest, candidateIdentityDigest, executionDigest });
  };
}
function invalid(message: string): HitchError { return new HitchError(message, { code: "remote_verifier_source_invalid", exitCode: 12 }); }
