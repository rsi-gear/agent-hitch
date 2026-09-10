import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseTOML } from "smol-toml";
import { parsePortableHarborRegradeConfig, restorePortableHarborRegradeConfig, runHarborRegrade } from "../backends/index.js";
import { useControllerRuntimeDirectory } from "../controller-runtime/index.js";
import type { EvalExecutionPlanV1, ExecutionLeaseV1, RemoteVerifierSourceManifestV2 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, readJSON, sha256JSON, statePaths } from "../foundation/index.js";
import { dockerOwnershipLabelMap, dockerResourceOwnership } from "./docker-ownership.js";
import { startDockerResourceObserver } from "./docker-resource-observer.js";
import { runtimeResourcesForTask } from "./execution-plan-resources.js";
import { readExecutionLeases } from "./execution-leases.js";
import { regradeTreeDigest } from "./regrade-evidence.js";
import { portableRemoteTrial } from "./remote-trial.js";
import { parseRemoteVerifierSourceManifest, verifyRemoteVerifierSourceContents } from "./verifier-source.js";
import { verifierRuntimeRepair } from "./verifier-runtime.js";

/** Executes only the artifact regrade phase. The worker runner owns heartbeat, cancellation and proven resource release. */
export async function runRemoteVerifierWork(input: {
  root: string; directory: string; sourceSnapshotDirectory: string; taskDirectory: string;
  sourceManifest: RemoteVerifierSourceManifestV2; sourceTrial: Record<string, unknown>;
  candidateResult: Record<string, unknown>; candidateResultDigest: string;
  runtimeDirectory: string; verifierRuntimeDirectory: string; verifierRuntimeId: string;
  trialName: string; plan: EvalExecutionPlanV1; lease: ExecutionLeaseV1;
  env: NodeJS.ProcessEnv; harborExecutable?: string; signal?: AbortSignal;
  processHooks?: Pick<import("../backends/index.js").RunHarborBackendOptions, "onProcessStarted" | "recoverableProcess">;
}) {
  const source = parseRemoteVerifierSourceManifest(input.sourceManifest);
  const checkLease = async () => {
    const current = (await readExecutionLeases(path.join(statePaths(input.root).evals, input.lease.eval_id))).find(lease => lease.lease_id === input.lease.lease_id);
    const fields = ["lease_id", "eval_id", "work_id", "worker_id", "provider", "collision_domain_id", "epoch", "reservation", "resource_epochs"] as const;
    if (!current || current.state !== "running" || Date.parse(current.expires_at) <= Date.now()
      || fields.some(field => sha256JSON(current[field] ?? null) !== sha256JSON(input.lease[field] ?? null))) throw unavailable("remote verifier has no current execution lease");
  };
  await checkLease();
  if (source.status !== "available" || !source.regrade_config_digest || !source.original_result_digest
    || !/^sha256:[a-f0-9]{64}$/.test(input.candidateResultDigest) || sha256JSON(input.candidateResult) !== input.candidateResultDigest
    || input.candidateResult.run_id !== source.run_id || input.candidateResult.status !== "succeeded"
    || sha256JSON(portableRemoteTrial(input.sourceTrial)) !== source.source_result_digest || input.sourceTrial.config !== undefined
    || input.sourceTrial.trial_name !== source.trial_id
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(input.trialName)
    || !input.plan.slots.some(slot => slot.task_id === source.task_id) || input.plan.eval_id !== input.lease.eval_id
    || input.plan.provider !== input.lease.provider) throw unavailable("remote verifier source/work identity differs");
  const metadata = (input.sourceTrial.agent_result as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  if (metadata?.hitch_run_id !== source.run_id || metadata.controller_runtime_id !== source.controller_runtime_id) throw unavailable("remote verifier candidate/runtime identity differs");
  const task = parseTOML(await readFile(path.join(input.taskDirectory, "task.toml"), "utf8"));
  const taskName = (task.task as Record<string, unknown> | undefined)?.name ?? path.basename(input.taskDirectory);
  if (input.sourceTrial.task_name !== taskName) throw unavailable("remote verifier task name differs");
  const runtime = await useControllerRuntimeDirectory(input.runtimeDirectory, source.controller_runtime_id);
  const verifierRuntime = await useControllerRuntimeDirectory(input.verifierRuntimeDirectory, input.verifierRuntimeId);
  const repair = verifierRuntimeRepair(runtime, verifierRuntime);
  const portable = parsePortableHarborRegradeConfig(await readJSON(path.join(input.sourceSnapshotDirectory, "regrade-config.json")));
  if (sha256JSON(portable) !== source.regrade_config_digest || portable.source_config_digest !== source.source_config_digest) throw unavailable("remote verifier config identity differs");
  if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
  await mkdir(input.directory, { recursive: false, mode: 0o700 });
  const candidateDirectory = path.join(input.directory, "candidate");
  await atomicWriteJSON(path.join(candidateDirectory, "result.json"), input.candidateResult);
  const verifySource = () => verifyRemoteVerifierSourceContents({ manifest: source, snapshotDirectory: input.sourceSnapshotDirectory,
    taskDirectory: input.taskDirectory, bundleDirectory: candidateDirectory });
  await verifySource();
  await checkLease();
  if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
  const replay = path.join(input.directory, "source-trial");
  await cp(input.sourceSnapshotDirectory, replay, { recursive: true, force: false, errorOnExist: true, dereference: false });
  if (await regradeTreeDigest(replay) !== source.snapshot_digest) throw unavailable("remote verifier source changed while copying");
  const ownership = dockerResourceOwnership(input.root, input.lease, source.task_id);
  const { sourceConfig, regradeConfig } = restorePortableHarborRegradeConfig({ portable, sourceConfigDigest: source.source_config_digest,
    taskDirectory: input.taskDirectory, sourceDirectory: replay, outputDirectory: path.join(input.directory, "trials"),
    trialName: input.trialName, sourceResult: input.sourceTrial, ownershipLabels: dockerOwnershipLabelMap(ownership) });
  await atomicWriteJSON(path.join(replay, "config.json"), sourceConfig);
  // Harbor's TrialResult requires config for decoding; the private original stays on its original worker.
  await atomicWriteJSON(path.join(replay, "result.json"), { ...input.sourceTrial, config: sourceConfig });
  const replayDigest = await regradeTreeDigest(replay);
  const limits = runtimeResourcesForTask(input.plan, source.task_id, input.lease.reservation);
  const environment = regradeConfig.environment as Record<string, unknown>, kwargs = environment.kwargs as Record<string, unknown>;
  if (environment.cpu_enforcement_policy !== "limit" || environment.memory_enforcement_policy !== "limit"
    || environment.override_cpus !== limits.mainLimits.cpu_millis / 1000 || environment.override_memory_mb !== limits.mainLimits.memory_bytes / 1024 ** 2
    || (kwargs.hitch_main_gpu_count ?? 0) !== (limits.mainLimits.gpu_count ?? 0)
    || environment.override_gpus != null && environment.override_gpus !== (limits.mainLimits.gpu_count ?? 0)
    || sha256JSON(kwargs.hitch_service_resource_limits ?? {}) !== sha256JSON(limits.sidecarLimits)) throw unavailable("remote verifier resource settings differ from its lease plan");
  const observer = startDockerResourceObserver({ ownership, workerId: input.lease.worker_id, collisionDomainId: input.lease.collision_domain_id,
    reservation: input.lease.reservation, mainLimits: limits.mainLimits, sidecarLimits: limits.sidecarLimits, env: input.env,
    ...(input.signal ? { signal: input.signal } : {}) });
  let outcome: Awaited<ReturnType<typeof runHarborRegrade>>;
  try {
    outcome = await runHarborRegrade({ root: input.root, directory: input.directory, config: regradeConfig,
      runtimeDirectory: verifierRuntime.directory, trustedResult: input.candidateResult, env: input.env,
      ...(input.processHooks ? { processHooks: input.processHooks } : {}),
      ...(input.harborExecutable ? { harborExecutable: input.harborExecutable } : {}), ...(input.signal ? { signal: input.signal } : {}) });
  } finally { await atomicWriteJSON(path.join(input.directory, "execution.json"), await observer.stop()); }
  await verifySource();
  await checkLease();
  if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
  if (await regradeTreeDigest(replay) !== replayDigest || outcome.trial.trial_name !== input.trialName || outcome.trial.task_name !== taskName
    || sha256JSON(outcome.trial.agent_result) !== sha256JSON(input.sourceTrial.agent_result)) throw unavailable("remote verifier mutated its source candidate");
  return { trial: portableRemoteTrial(outcome.trial), backend: outcome.backend, execution: await readJSON(path.join(input.directory, "execution.json")),
    source_manifest_digest: sha256JSON(source), candidate_result_digest: input.candidateResultDigest,
    config_digest: sha256JSON(regradeConfig), controller_runtime_id: verifierRuntime.runtime_id,
    ...(repair ? { runtime_repair: repair } : {}), trial_directory: path.join(input.directory, "trials", input.trialName) };
}
function unavailable(message: string): HitchError { return new HitchError(message, { code: "eval_verifier_only_unavailable", exitCode: 2 }); }
