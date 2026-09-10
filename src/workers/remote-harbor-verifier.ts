import path from "node:path";
import type { ExecutionLeaseV1 } from "../domain/index.js";
import { atomicWriteJSON, sha256JSON, statePaths } from "../foundation/index.js";
import { assertRemoteVerifierOutcome, parseExecutionLease, parseRemoteVerifierOutcome, remoteVerifierTrialName, runRemoteVerifierWork } from "../evals/index.js";
import { encodeRemoteVerifierResultEnvelope, materializeRemoteTreeEnvelope } from "../control-plane/index.js";
import type { RemoteWorkerExecutionResult, RemoteWorkerExecutorInput } from "../control-plane/index.js";
import type { RemoteHarborWorkSpecV2 } from "./remote-harbor-work-spec.js";

export async function executeRemoteHarborVerifier(input: RemoteWorkerExecutorInput & {
  root: string; workspace: string; runtimeDirectory: string; taskDirectory: string; spec: RemoteHarborWorkSpecV2;
  env: NodeJS.ProcessEnv; harborExecutable?: string; release: () => Promise<void>;
  processHooks?: ReturnType<typeof import("./remote-harbor-ownership.js").remoteHarborProcessHooks>;
}): Promise<RemoteWorkerExecutionResult> {
  if (!input.spec.verifier_only || !input.readExecutionLease) throw new TypeError("remote verifier requires current controller execution lease grants");
  const verifier = input.spec.verifier_only, controller = new AbortController(), signal = AbortSignal.any([input.signal, controller.signal]);
  const sourceSnapshotDirectory = path.join(input.workspace, "verifier-source"), verifierRuntimeDirectory = path.join(input.workspace, "verifier-runtime");
  let expiry: ReturnType<typeof setTimeout> | undefined, timer: ReturnType<typeof setInterval> | undefined, pending: Promise<void> | undefined;
  let lease: ExecutionLeaseV1;
  const refresh = async () => {
    const grant = parseExecutionLease(await input.readExecutionLease!(AbortSignal.any([signal, AbortSignal.timeout(5_000)])));
    const fields = ["lease_id", "eval_id", "work_id", "worker_id", "provider", "collision_domain_id", "epoch", "reservation"] as const;
    if (!grant || !["offered", "accepted", "running"].includes(grant.state) || Date.parse(grant.expires_at) <= Date.now()
      || fields.some(field => sha256JSON(grant[field]) !== sha256JSON(input.offer.lease[field]))
      || sha256JSON(grant.resource_epochs ?? [grant.epoch]) !== sha256JSON(input.offer.lease.resource_epochs ?? [input.offer.lease.epoch])) {
      const error = new TypeError("remote verifier execution lease identity changed"); controller.abort(error); throw error;
    }
    signal.throwIfAborted();
    const acceptedAt = grant.accepted_at ?? input.offer.accepted_at;
    if (!acceptedAt) throw new TypeError("remote verifier has no acknowledged acceptance");
    lease = { ...grant, state: "running", accepted_at: acceptedAt, resource_epochs: grant.resource_epochs ?? [grant.epoch] };
    await atomicWriteJSON(path.join(statePaths(input.root).evals, lease.eval_id, "leases", `${lease.lease_id}.json`), lease);
    signal.throwIfAborted();
    clearTimeout(expiry);
    expiry = setTimeout(() => controller.abort(new Error("remote verifier execution lease expired")), Math.max(1, Date.parse(grant.expires_at) - Date.now()));
    expiry.unref();
  };
  try {
    await refresh();
    timer = setInterval(() => {
      // A transient read failure grants no additional time; the last controller expiry still aborts work.
      pending ??= refresh().catch(() => undefined).finally(() => { pending = undefined; });
    }, 1_000); timer.unref();
    const tree = (kind: "verifier-source" | "verifier-runtime") => {
      const body = input.inputs.get(kind); if (!body) throw new TypeError(`remote verifier is missing ${kind}`); return JSON.parse(body.toString());
    };
    await Promise.all([materializeRemoteTreeEnvelope(tree("verifier-source"), sourceSnapshotDirectory),
      materializeRemoteTreeEnvelope(tree("verifier-runtime"), verifierRuntimeDirectory)]);
    const outcome = await runRemoteVerifierWork({ root: input.root, directory: path.join(input.workspace, "verifier-work"),
      sourceSnapshotDirectory, verifierRuntimeDirectory, taskDirectory: input.taskDirectory,
      sourceManifest: verifier.source_manifest, sourceTrial: verifier.source_trial,
      candidateResult: verifier.candidate_result, candidateResultDigest: verifier.candidate_result_digest,
      runtimeDirectory: input.runtimeDirectory, verifierRuntimeId: verifier.verifier_runtime_id, trialName: remoteVerifierTrialName(verifier.assessment_id),
      plan: input.spec.plan, lease: lease!, env: input.env, signal,
      ...(input.processHooks ? { processHooks: input.processHooks } : {}),
      ...(input.harborExecutable ? { harborExecutable: input.harborExecutable } : {}) });
    assertRemoteVerifierOutcome({ verifier, plan: input.spec.plan, work: input.offer.work, lease: lease!, outcome: parseRemoteVerifierOutcome({
      trial: outcome.trial, backend: { process_exit_code: outcome.backend.process_exit_code, signal: outcome.backend.signal },
      execution: outcome.execution, config_digest: outcome.config_digest, controller_runtime_id: outcome.controller_runtime_id,
      ...(outcome.runtime_repair ? { runtime_repair: outcome.runtime_repair } : {}) }) });
    const body = await encodeRemoteVerifierResultEnvelope({ lease: lease!, verifier, outcome, verifierDirectory: path.join(outcome.trial_directory, "verifier") });
    signal.throwIfAborted();
    return { status: "succeeded", artifacts: [{ kind: "result-bundle", body }], release: input.release };
  } catch {
    return { status: signal.aborted ? "cancelled" : "failed",
      artifacts: [{ kind: "diagnostic", body: Buffer.from(`${JSON.stringify({ schema_version: "2", code: signal.aborted ? "remote_verifier_cancelled" : "remote_verifier_failed" })}\n`) }], release: input.release };
  } finally {
    clearInterval(timer); clearTimeout(expiry); controller.abort(); await pending;
  }
}
