import path from "node:path";
import type { EvalId, EvalRequest, ExecutionLeaseV1, RemoteWorkOfferV1, ResolvedRevision } from "../domain/index.js";
import { HitchError, readJSON } from "../foundation/index.js";
import { loadEnvironmentImageManifest } from "../images/index.js";
import {
  DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS,
  acceptExecutionLease,
  heartbeatExecutionLease,
  loadEvalResumeState,
  loadTrialEnvironmentImages,
  markExecutionLeaseLost,
  markExecutionLeaseRunning,
  mergeEvalProgressTrial,
  releaseExecutionLease,
  writeEvalProgress,
} from "../evals/index.js";
import type { EvalLeaseRecoveryResult } from "../evals/index.js";
import { importRemoteResultEnvelope } from "./remote-result-transport.js";
import type { RemoteWorkerProtocol } from "./remote-worker-protocol.js";
import type { RemoteWorkerRegistry } from "./remote-workers.js";

export const DEFAULT_REMOTE_WORKER_RECONNECT_TIMEOUT_MS = 45_000;

export async function recoverRemoteWorkerEvalLeases(input: {
  root: string;
  evalId: EvalId;
  evalDirectory: string;
  leases: ExecutionLeaseV1[];
  registry: RemoteWorkerRegistry;
  protocol: RemoteWorkerProtocol;
  cancelRequested?: boolean;
  pollIntervalMs: number;
  releaseTimeoutMs: number;
  reconnectTimeoutMs?: number;
  emit?: (event: Record<string, unknown>) => void;
}): Promise<EvalLeaseRecoveryResult> {
  const reconnectTimeoutMs = boundedReconnectTimeout(input.reconnectTimeoutMs ?? DEFAULT_REMOTE_WORKER_RECONNECT_TIMEOUT_MS);
  const recovered: string[] = [];
  let failure: { code: string; message: string } | undefined;
  for (const lease of input.leases.filter(activeRemoteLease)) {
    try {
      await recoverLease(input, lease, reconnectTimeoutMs);
      recovered.push(lease.lease_id);
    } catch (error) {
      const typed = error instanceof HitchError;
      failure ??= { code: typed ? error.code : "execution_state_ambiguous", message: (error as Error)?.message || String(error) };
      await markExecutionLeaseLost({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch }).catch(() => undefined);
      input.emit?.({ type: "eval.lease.recovery-failed", lease_id: lease.lease_id, code: failure.code });
      input.emit?.({ type: "eval.work.lost", work_id: lease.work_id, lease_id: lease.lease_id, worker_id: lease.worker_id, code: failure.code });
    }
  }
  return failure
    ? { status: "ambiguous", recovered_lease_ids: recovered, ...failure }
    : { status: "resumable", recovered_lease_ids: recovered };
}

async function recoverLease(input: Parameters<typeof recoverRemoteWorkerEvalLeases>[0], lease: ExecutionLeaseV1, reconnectTimeoutMs: number): Promise<void> {
  if (Date.parse(lease.expires_at) <= Date.now()) input.emit?.({ type: "lease.expired", work_id: lease.work_id, lease_id: lease.lease_id, lease_epoch: lease.epoch, worker_id: lease.worker_id });
  let offer = await input.protocol.findOfferForLease(lease.worker_id, lease.lease_id);
  if (!offer || !sameLease(offer, lease)) throw ambiguous(`remote provider has no matching durable offer for ${lease.lease_id}`);
  if (offer.state === "offered") {
    offer = await input.protocol.withdrawUnacceptedOffer(offer.worker_id, offer.offer_id);
    if (offer.state === "expired") {
      input.emit?.({ type: "lease.expired", lease_id: lease.lease_id, lease_epoch: lease.epoch, worker_id: lease.worker_id });
      await releaseExecutionLease({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch });
      input.emit?.({ type: "eval.lease.recovered", lease_id: lease.lease_id, lease_epoch: lease.epoch, state: "not-started" });
      input.emit?.({ type: "lease.recovered", lease_id: lease.lease_id, lease_epoch: lease.epoch, state: "not-started" });
      return;
    }
  }
  if (!acceptedOrLater(offer)) throw ambiguous(`remote provider classified ${lease.lease_id} as ${offer.state}`);
  let current = lease;
  if (current.state === "offered") current = await acceptExecutionLease({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch });
  if (current.state === "accepted") current = await markExecutionLeaseRunning({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch });
  input.emit?.({ type: "eval.lease.recovery-probed", lease_id: lease.lease_id, lease_epoch: lease.epoch, state: offer.state });
  if (input.cancelRequested && offer.state === "accepted") offer = await input.protocol.requestCancel(offer.worker_id, offer.offer_id);
  if (offer.state === "accepted" || offer.state === "cancel-requested") offer = await waitForTerminal(input, offer, current, reconnectTimeoutMs);
  if (offer.state !== "completed" && offer.state !== "release-requested" && offer.state !== "released") {
    throw ambiguous(`remote work did not reach collectable terminal state: ${offer.state}`);
  }
  if (offer.terminal?.status === "succeeded") await collectRemoteResult(input, current, offer);
  else if (!input.cancelRequested) throw new HitchError(`recovered remote work ended as ${offer.terminal?.status ?? "unknown"}`, { code: "remote_work_failed", exitCode: 13 });
  await finishRelease(input, current, offer);
  input.emit?.({ type: "eval.lease.recovered", lease_id: lease.lease_id, lease_epoch: lease.epoch, state: "released" });
  input.emit?.({ type: "lease.recovered", lease_id: lease.lease_id, lease_epoch: lease.epoch, state: "released" });
}

async function waitForTerminal(
  input: Parameters<typeof recoverRemoteWorkerEvalLeases>[0],
  initial: RemoteWorkOfferV1,
  lease: ExecutionLeaseV1,
  reconnectTimeoutMs: number,
): Promise<RemoteWorkOfferV1> {
  let offer = initial;
  let heartbeatFailure: unknown;
  let unavailableSince: number | undefined;
  let reportedUnavailable = false;
  let tail = Promise.resolve();
  const timer = setInterval(() => {
    tail = tail.then(() => heartbeatExecutionLease({
      evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch,
    }).then(() => undefined)).catch((error) => { heartbeatFailure ??= error; });
  }, DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS);
  timer.unref();
  try {
    while (offer.state === "accepted" || offer.state === "cancel-requested") {
      const worker = await input.registry.get(offer.worker_id);
      if (worker?.revoked_at) throw ambiguous(`remote worker was revoked during recovery: ${offer.worker_id}`);
      if (workerProvesLease(worker, lease)) {
        if (reportedUnavailable) input.emit?.({ type: "worker.reconnected", worker_id: offer.worker_id, lease_id: lease.lease_id, lease_epoch: lease.epoch });
        unavailableSince = undefined;
        reportedUnavailable = false;
      } else {
        unavailableSince ??= Date.now();
        if (!reportedUnavailable) input.emit?.({ type: "worker.heartbeat_missed", worker_id: offer.worker_id, lease_id: lease.lease_id, lease_epoch: lease.epoch });
        reportedUnavailable = true;
        if (Date.now() - unavailableSince >= reconnectTimeoutMs) throw ambiguous(`remote worker did not reconnect with active lease: ${offer.worker_id}`);
      }
      await delay(input.pollIntervalMs);
      offer = await input.protocol.getOffer(offer.worker_id, offer.offer_id) ?? (() => { throw ambiguous("remote work offer disappeared during recovery"); })();
    }
    await tail;
    if (heartbeatFailure !== undefined) throw heartbeatFailure;
    return offer;
  } finally {
    clearInterval(timer);
    await tail;
  }
}

async function collectRemoteResult(input: Parameters<typeof recoverRemoteWorkerEvalLeases>[0], lease: ExecutionLeaseV1, offer: RemoteWorkOfferV1): Promise<void> {
  const state = await loadEvalResumeState(input.evalDirectory);
  const work = state.executionPlan.work_items.find((entry) => entry.work_id === lease.work_id);
  if (!work || work.logical_attempt === null || work.task_ids.length !== 1) throw ambiguous("recovered remote lease does not match one planned task slot");
  const existing = state.progress.trials.find((trial) => trial.task_id === work.task_ids[0] && trial.attempt === work.logical_attempt);
  if (existing) return;
  const artifacts = offer.terminal?.artifacts.filter((artifact) => artifact.kind === "result-bundle") ?? [];
  if (artifacts.length !== 1) throw ambiguous("recovered remote success requires exactly one result bundle");
  const request = await readJSON<EvalRequest>(path.join(input.evalDirectory, "request.json"));
  const resolution = await readJSON<ResolvedRevision>(path.join(input.evalDirectory, "resolution.json"));
  const runtime = state.plan.controller_runtime as Record<string, unknown> | undefined;
  const environmentImages = await loadTrialEnvironmentImages({
    taskId: work.task_ids[0] as string,
    uses: work.image_refs ?? [],
    loader: (imageId) => loadEnvironmentImageManifest(input.root, imageId),
  });
  const artifact = artifacts[0] as typeof artifacts[number];
  const imported = await importRemoteResultEnvelope({
    root: input.root, evalDirectory: input.evalDirectory, request, resolvedRevision: resolution,
    work, lease, artifactPath: input.protocol.artifactPath(offer.worker_id, lease.lease_id, artifact.digest),
    ...(typeof runtime?.runtime_id === "string" ? { runtimeId: runtime.runtime_id } : {}),
    ...(environmentImages ? { environmentImages } : {}),
    ...(state.executionPlan.model_capture ? { modelCapturePlan: state.executionPlan.model_capture } : {}),
  });
  const progress = mergeEvalProgressTrial(state.progress, imported.ref);
  await writeEvalProgress(input.evalDirectory, progress);
  input.emit?.({ type: "eval.work-item.recovered", work_id: work.work_id, lease_id: lease.lease_id, trials: 1 });
}

async function finishRelease(input: Parameters<typeof recoverRemoteWorkerEvalLeases>[0], lease: ExecutionLeaseV1, terminal: RemoteWorkOfferV1): Promise<void> {
  input.emit?.({ type: "sandbox.cleanup.started", work_id: lease.work_id, lease_id: lease.lease_id, worker_id: lease.worker_id });
  let offer = terminal.state === "released" ? terminal : await input.protocol.requestRelease(terminal.worker_id, terminal.offer_id);
  const deadline = Date.now() + input.releaseTimeoutMs;
  while (offer.state !== "released" && Date.now() < deadline) {
    await delay(input.pollIntervalMs);
    offer = await input.protocol.getOffer(offer.worker_id, offer.offer_id) ?? offer;
  }
  if (offer.state === "released") {
    await releaseExecutionLease({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch });
    input.emit?.({ type: "lease.released", work_id: lease.work_id, lease_id: lease.lease_id, lease_epoch: lease.epoch, worker_id: lease.worker_id });
    input.emit?.({ type: "sandbox.cleanup.completed", work_id: lease.work_id, lease_id: lease.lease_id, worker_id: lease.worker_id, residual_resources: 0 });
    return;
  }
  await markExecutionLeaseLost({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch });
  input.emit?.({ type: "sandbox.cleanup.failed", work_id: lease.work_id, lease_id: lease.lease_id, worker_id: lease.worker_id, code: "worker_release_timeout" });
}

function activeRemoteLease(lease: ExecutionLeaseV1): boolean {
  return lease.provider !== "local-docker" && new Set(["offered", "accepted", "running", "releasing"]).has(lease.state);
}
function acceptedOrLater(offer: RemoteWorkOfferV1): boolean {
  return new Set(["accepted", "cancel-requested", "completed", "release-requested", "released"]).has(offer.state)
    && typeof offer.accepted_at === "string" && typeof offer.accept_receipt_digest === "string";
}
function sameLease(offer: RemoteWorkOfferV1, lease: ExecutionLeaseV1): boolean {
  return offer.lease.lease_id === lease.lease_id && offer.lease.epoch === lease.epoch && offer.worker_id === lease.worker_id
    && offer.lease.eval_id === lease.eval_id && offer.lease.work_id === lease.work_id;
}
function workerProvesLease(worker: Awaited<ReturnType<RemoteWorkerRegistry["get"]>>, lease: ExecutionLeaseV1): boolean {
  return worker?.worker.status === "ready"
    && worker.active_leases.some((active) => active.lease_id === lease.lease_id && active.epoch === lease.epoch);
}
function boundedReconnectTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5 * 60_000) throw new TypeError("remote worker reconnect timeout is invalid");
  return value;
}
function ambiguous(message: string): HitchError { return new HitchError(message, { code: "execution_state_ambiguous", exitCode: 12 }); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
