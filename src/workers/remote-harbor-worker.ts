import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { loadPreparedArtifact } from "../artifacts/index.js";
import { runHarborBackend } from "../backends/index.js";
import type { HarborPreparedArtifactUse } from "../backends/index.js";
import { useControllerRuntimeDirectory } from "../controller-runtime/index.js";
import type { ExecutionLeaseV1, RemoteWorkInputRefV1, RemoteWorkOfferV1 } from "../domain/index.js";
import { atomicWriteJSON, ensureDir, statePaths } from "../foundation/index.js";
import { dockerResourceOwnership, importEvalTrialRun, reapOwnedDockerResources, releaseExecutionLease, resolvedImageMapping, runtimeResourcesForTask, startDockerResourceObserver, startEvalModelCaptureRuntime } from "../evals/index.js";
import { encodeRemoteResultEnvelope, materializeRemoteTreeEnvelope } from "../control-plane/index.js";
import type { RemoteWorkerExecutor, RemoteWorkerExecutionResult } from "../control-plane/index.js";
import { parseRemoteHarborWorkSpec } from "./remote-harbor-work-spec.js";

export interface RemoteHarborWorkerOptions {
  root: string;
  env?: NodeJS.ProcessEnv;
  harborExecutable?: string;
  trialBundleGraceMs?: number;
  dockerExecutable?: string;
}

export function remoteHarborWorker(options: RemoteHarborWorkerOptions): RemoteWorkerExecutor {
  if (!options.root) throw new TypeError("remote Harbor worker root is required");
  const root = path.resolve(options.root);
  const env = options.env ?? process.env;
  return async ({ offer, inputs, credentials, signal, emit }): Promise<RemoteWorkerExecutionResult> => {
    const workspace = path.join(statePaths(root).workerStaging, offer.lease.lease_id, `epoch-${String(offer.lease.epoch).padStart(6, "0")}`);
    await removeWorkerWorkspace(workspace);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const spec = parseRemoteHarborWorkSpec(parseJSON(required(inputs, "work-spec")), offer);
    if (JSON.stringify([...credentials.keys()].sort()) !== JSON.stringify(spec.credential_names)) {
      throw new TypeError("remote credential envelope does not match its work spec");
    }
    const executionEnv: NodeJS.ProcessEnv = { ...env, ...Object.fromEntries(credentials) };
    const harnessDirectory = path.join(workspace, "harness-artifact");
    const runtimeDirectory = path.join(workspace, "controller-runtime");
    const datasetDirectory = await ensureDir(path.join(workspace, "dataset"));
    await Promise.all([
      materializeRemoteTreeEnvelope(parseJSON(required(inputs, "harness-artifact")), harnessDirectory),
      materializeRemoteTreeEnvelope(parseJSON(required(inputs, "controller-runtime")), runtimeDirectory),
      materializeRemoteTreeEnvelope(parseJSON(required(inputs, "task-input")), path.join(datasetDirectory, spec.task.task_id)),
    ]);
    const prepared = await loadPreparedArtifact(harnessDirectory, spec.harness_artifact);
    if (JSON.stringify(prepared.resolved_revision) !== JSON.stringify(spec.resolution)
      || prepared.toolchain.node !== spec.harness_artifact.node_version) throw new TypeError("remote prepared artifact evidence does not match its work spec");
    const runtime = await useControllerRuntimeDirectory(runtimeDirectory, spec.controller_runtime.runtime_id);
    const evalDirectory = await ensureDir(path.join(statePaths(root).evals, offer.lease.eval_id));
    await persistRunningLease(evalDirectory, offer.lease);
    const taskId = spec.task.task_id;
    const runtimeResources = runtimeResourcesForTask(spec.plan, taskId, offer.lease.reservation);
    const ownership = dockerResourceOwnership(root, offer.lease, taskId);
    const observer = startDockerResourceObserver({
      ownership, workerId: offer.worker_id, collisionDomainId: offer.lease.collision_domain_id,
      reservation: offer.lease.reservation, mainLimits: runtimeResources.mainLimits,
      sidecarLimits: runtimeResources.sidecarLimits, env, signal,
    });
    const backendDirectory = path.join(evalDirectory, "remote-work", offer.work.work_id, `epoch-${String(offer.lease.epoch).padStart(6, "0")}`);
    const captureRuntime = await startEvalModelCaptureRuntime({
      plan: spec.plan.model_capture ?? { requested_mode: "native", effective_mode: "native", required: false },
      evalId: offer.lease.eval_id,
      // A remote worker may run multiple work items from one eval concurrently.
      // Keep the capability token, append state and capture files lease-local.
      evalDirectory: backendDirectory,
      env: executionEnv,
      runtimeTopology: "in-sandbox",
      preservePlanOnOptionalFailure: true,
    });
    let stoppedEvidence: Awaited<ReturnType<typeof observer.stop>> | undefined;
    const stopObserver = async () => stoppedEvidence ??= await observer.stop();
    const release = releaseRemoteResources({
      root, evalDirectory, lease: offer.lease, workspace, env,
      ...(options.dockerExecutable ? { dockerExecutable: options.dockerExecutable } : {}),
    });
    let eventTail = Promise.resolve();
    const publishEvent = (event: Record<string, unknown>): void => {
      eventTail = eventTail.then(() => emit(String(event.type ?? "harbor.event"), event));
    };
    try {
      const run = await runHarborBackend({
        evalId: offer.lease.eval_id, evalDirectory, backendDirectory,
        logicalAttempt: offer.work.logical_attempt as number, taskNames: [taskId],
        request: { ...spec.request, dataset: datasetDirectory, attempts: 1, max_concurrent: 1 },
        root, resolvedRevision: spec.resolution, runtimeDirectory: runtime.directory,
        runtimeId: runtime.runtime_id, preparedArtifact: preparedUse(prepared, harnessDirectory, spec.harness_artifact),
        executionResources: runtimeResources.mainLimits,
        ...(Object.keys(runtimeResources.sidecarLimits).length > 0 ? { dockerServiceLimits: runtimeResources.sidecarLimits } : {}),
        dockerOwnership: ownership, resolvedImages: resolvedImageMapping(offer.work.image_refs ?? []),
        ...(captureRuntime.exporter ? { modelProxy: captureRuntime.exporter.route } : {}),
        env: executionEnv, ...(options.harborExecutable ? { harborExecutable: options.harborExecutable } : {}), signal,
        ...(options.trialBundleGraceMs === undefined ? {} : { trialBundleGraceMs: options.trialBundleGraceMs }),
        emit: publishEvent,
      });
      await eventTail;
      const executionEvidence = await stopObserver();
      if (signal.aborted) return { status: "cancelled", artifacts: [failureDiagnostic("cancelled")], release };
      const trial = singleTrial(run.rawResult, taskId);
      if (run.backend.process_exit_code !== 0 || !trial) return {
        status: "failed", artifacts: [failureDiagnostic(run.rawResult ? "harbor-process-failed" : "harbor-result-missing")], release,
      };
      const ref = await importEvalTrialRun({
        root, evalId: offer.lease.eval_id, evalDirectory, harborJobDirectory: path.join(backendDirectory, "job"),
        expectedAttempt: offer.work.logical_attempt as number,
        request: spec.request, resolvedRevision: spec.resolution,
        benchmarkId: spec.request.benchmark_id, benchmarkRevision: spec.request.benchmark_revision,
        runtimeId: runtime.runtime_id, executionEvidence,
        signal,
        ...(spec.plan.model_capture ? { modelCapturePlan: spec.plan.model_capture } : {}),
        ...(captureRuntime.exporter ? { interactionCaptureExporter: captureRuntime.exporter } : {}),
        requireCompleteMarker: true, allowMissingBundleDiagnostic: true,
      }, trial);
      if (ref.run_group) throw new Error("remote single-bundle transport cannot export native phase groups");
      const body = await encodeRemoteResultEnvelope({
        evalId: offer.lease.eval_id, workId: offer.work.work_id,
        leaseId: offer.lease.lease_id, leaseEpoch: offer.lease.epoch, trial,
        bundleDirectory: path.join(statePaths(root).runs, ref.run_id),
      });
      return { status: "succeeded", artifacts: [{ kind: "result-bundle", body }], release };
    } catch (error) {
      await eventTail.catch(() => undefined);
      await stopObserver().catch(() => undefined);
      return { status: signal.aborted ? "cancelled" : "failed", artifacts: [failureDiagnostic(errorCode(error))], release };
    } finally {
      await captureRuntime.close().catch(() => undefined);
      for (const name of spec.credential_names) delete executionEnv[name];
    }
  };
}

/** Recover cleanup after a worker restart without re-executing accepted work. */
export async function releaseRemoteHarborOffer(options: RemoteHarborWorkerOptions, offer: RemoteWorkOfferV1): Promise<void> {
  const root = path.resolve(options.root);
  const evalDirectory = path.join(statePaths(root).evals, offer.lease.eval_id);
  const workspace = path.join(statePaths(root).workerStaging, offer.lease.lease_id, `epoch-${String(offer.lease.epoch).padStart(6, "0")}`);
  await releaseRemoteResources({
    root, evalDirectory, lease: offer.lease, workspace, env: options.env ?? process.env,
    ...(options.dockerExecutable ? { dockerExecutable: options.dockerExecutable } : {}),
  })();
}

function releaseRemoteResources(input: {
  root: string;
  evalDirectory: string;
  lease: ExecutionLeaseV1;
  workspace: string;
  env: NodeJS.ProcessEnv;
  dockerExecutable?: string;
}): () => Promise<void> {
  let done = false;
  return async () => {
    if (done) return;
    const leaseFile = path.join(input.evalDirectory, "leases", `${input.lease.lease_id}.json`);
    if (!(await lstat(leaseFile).catch(() => null))?.isFile()) {
      await removeWorkerWorkspace(input.workspace);
      done = true;
      return;
    }
    await releaseExecutionLease({ evalDirectory: input.evalDirectory, leaseId: input.lease.lease_id, expectedEpoch: input.lease.epoch });
    const report = await reapOwnedDockerResources({
      root: input.root, leaseIds: [input.lease.lease_id], env: input.env,
      ...(input.dockerExecutable ? { dockerExecutable: input.dockerExecutable } : {}),
    });
    if (report.issues.length > 0 || report.retained.length > 0) throw new Error("remote Harbor resource cleanup is incomplete");
    await removeWorkerWorkspace(input.workspace);
    done = true;
  };
}

async function removeWorkerWorkspace(directory: string): Promise<void> {
  const info = await lstat(directory).catch(() => null);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError("remote worker workspace is not a regular directory");
  await makeTreeWritable(directory);
  await rm(directory, { recursive: true, force: true });
}

async function makeTreeWritable(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeTreeWritable(target);
      await chmod(target, 0o700);
    } else if (!entry.isSymbolicLink()) await chmod(target, 0o600);
  }
  await chmod(directory, 0o700);
}

async function persistRunningLease(evalDirectory: string, lease: ExecutionLeaseV1): Promise<void> {
  const now = new Date().toISOString();
  await atomicWriteJSON(path.join(await ensureDir(path.join(evalDirectory, "leases")), `${lease.lease_id}.json`), {
    ...lease, state: "running", accepted_at: lease.accepted_at ?? now, heartbeat_at: now,
    resource_epochs: lease.resource_epochs ?? [lease.epoch],
  });
}

function preparedUse(prepared: Awaited<ReturnType<typeof loadPreparedArtifact>>, directory: string, pinned: HarborPreparedArtifactUse): HarborPreparedArtifactUse {
  return {
    directory,
    artifact_id: prepared.artifact_id, artifact_integrity: prepared.artifact_integrity as string,
    entrypoint_integrity: prepared.entrypoint_integrity as string, harness_id: prepared.harness_id,
    revision_identity: prepared.revision_identity, adapter_version: prepared.adapter_version,
    recipe_version: prepared.recipe_version, platform: prepared.platform,
    node_version: prepared.toolchain.node || pinned.node_version, source_type: prepared.source_type,
  };
}

function singleTrial(raw: Record<string, unknown> | null, taskId: string): Record<string, unknown> | null {
  const trials = Array.isArray(raw?.trial_results) ? raw.trial_results : [];
  if (trials.length !== 1 || !trials[0] || typeof trials[0] !== "object" || Array.isArray(trials[0])
    || (trials[0] as Record<string, unknown>).task_name !== taskId) return null;
  return trials[0] as Record<string, unknown>;
}

function required(inputs: ReadonlyMap<RemoteWorkInputRefV1["kind"], Buffer>, kind: RemoteWorkInputRefV1["kind"]): Buffer {
  const body = inputs.get(kind);
  if (!body) throw new TypeError(`remote Harbor worker input is missing: ${kind}`);
  return body;
}

function parseJSON(body: Buffer): unknown {
  try { return JSON.parse(body.toString("utf8")) as unknown; }
  catch { throw new TypeError("remote Harbor worker input is not valid JSON"); }
}

function failureDiagnostic(code: string): { kind: "diagnostic"; body: Buffer } {
  const safe = /^[a-z0-9][a-z0-9._-]{0,127}$/.test(code) ? code : "remote-worker-failed";
  return { kind: "diagnostic", body: Buffer.from(`${JSON.stringify({ schema_version: "1", code: safe, at: new Date().toISOString() })}\n`) };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : "remote-worker-failed";
}
