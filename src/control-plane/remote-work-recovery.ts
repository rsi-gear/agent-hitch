import path from "node:path";
import type { EvalId, EvalRequest, ExecutionLeaseV1, RemoteWorkOfferV1, ResolvedRevision, RemoteWorkerCleanupReceipt } from "../domain/index.js";
import { HitchError, readJSON } from "../foundation/index.js";
import { loadEnvironmentImageManifest } from "../images/index.js";
import {
  DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS,
  acceptExecutionLease,
  assertRemoteLeaseRelease,
  confirmRemoteExecutionLeaseReleased,
  classifyTrialFailure,
  ensurePhysicalRetryDecision,
  heartbeatExecutionLease,
  loadEvalResumeState,
  loadTrialEnvironmentImages,
  markExecutionLeaseLost,
  markExecutionLeaseRunning,
  mergeEvalProgressTrial,
  readEvalRetryState,
  replaceInvalidEvalProgressTrial,
  resolveRetryWork,
  physicalRetryAllowed,
  physicalRetryWorkItem,
  releaseExecutionLease,
  writeEvalProgress,
  transitionRetryDecision,
  retryBackoffMs,
} from "../evals/index.js";
import type { EvalLeaseRecoveryResult } from "../evals/index.js";
import { importRemoteResultEnvelope } from "./remote-result-transport.js";
import { importRemoteVerifierResultEnvelope } from "./remote-verifier-import.js";
import { verifierSourceRequested } from "./remote-verifier-source-transport.js";
import type { RemoteWorkerProtocol } from "./remote-worker-protocol.js";
import type { RemoteWorkerRegistry } from "./remote-workers.js";
import { collectRemoteRerunJournal, completeRemoteRerunJournal, loadRemoteRerunJournal, remoteRerunSpec, withdrawRemoteRerunJournal } from "./remote-rerun-journal.js";
import type { RemoteRerunJournal } from "./remote-rerun-journal.js";
import { remoteBackendResult } from "./remote-backend-result.js";

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
  for (const lease of input.leases.filter(lease => lease.provider !== "local-docker")) {
    try {
      if (lease.state === "released") {
        const offer = await input.protocol.findOfferForLease(lease.worker_id, lease.lease_id);
        if (!offer || !await input.protocol.generationCleanup.read(offer) && !await remoteRerunSpec(input.root, offer)) continue;
        if (["expired", "rejected"].includes(offer.state) && !offer.accepted_at && sameLease(offer, lease)) continue;
      } else if (!activeRemoteLease(lease)) {
        const offer = await input.protocol.findOfferForLease(lease.worker_id, lease.lease_id);
        if (!offer) throw ambiguous(`remote lease is fenced without confirmed release: ${lease.lease_id}`);
        assertRemoteLeaseRelease(lease, offer, await input.protocol.generationCleanup.read(offer) ?? undefined);
      }
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
  let cleanup = offer ? await input.protocol.generationCleanup.read(offer) : null;
  if (!offer || !sameLease(offer, lease, cleanup ?? undefined)) throw ambiguous(`remote provider has no matching durable offer for ${lease.lease_id}`);
  if (offer.state === "offered") {
    offer = await input.protocol.withdrawUnacceptedOffer(offer.worker_id, offer.offer_id);
  }
  if (["expired", "rejected"].includes(offer.state) && !offer.accepted_at) {
      if (await remoteRerunSpec(input.root, offer)) {
        const state = await loadEvalResumeState(input.evalDirectory);
        const journal = await loadRemoteRerunJournal({ root: input.root, evalDirectory: input.evalDirectory, plan: state.executionPlan,
          request: await readJSON<EvalRequest>(path.join(input.evalDirectory, "request.json")), offer });
        if (journal) await withdrawRemoteRerunJournal(journal, lease.lease_id);
      }
      input.emit?.({ type: "lease.expired", lease_id: lease.lease_id, lease_epoch: lease.epoch, worker_id: lease.worker_id });
      await releaseExecutionLease({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch });
      input.emit?.({ type: "eval.lease.recovered", lease_id: lease.lease_id, lease_epoch: lease.epoch, state: "not-started" });
      input.emit?.({ type: "lease.recovered", lease_id: lease.lease_id, lease_epoch: lease.epoch, state: "not-started" });
      return;
  }
  if (!acceptedOrLater(offer)) throw ambiguous(`remote provider classified ${lease.lease_id} as ${offer.state}`);
  let current = lease;
  if (!cleanup && current.state === "offered") current = await acceptExecutionLease({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch });
  if (!cleanup && current.state === "accepted") current = await markExecutionLeaseRunning({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch });
  input.emit?.({ type: "eval.lease.recovery-probed", lease_id: lease.lease_id, lease_epoch: lease.epoch, state: offer.state });
  if (!cleanup && input.cancelRequested && offer.state === "accepted") offer = await input.protocol.requestCancel(offer.worker_id, offer.offer_id);
  if (!cleanup && (offer.state === "accepted" || offer.state === "cancel-requested")) offer = await waitForTerminal(input, offer, current, reconnectTimeoutMs);
  cleanup ??= await input.protocol.generationCleanup.read(offer);
  if (!cleanup && offer.state !== "completed" && offer.state !== "release-requested" && offer.state !== "released") {
    throw ambiguous(`remote work did not reach collectable terminal state: ${offer.state}`);
  }
  let journal: RemoteRerunJournal | null = null;
  if (offer.terminal?.status === "succeeded") journal = await collectRemoteResult(input, current, offer);
  else {
    if (await remoteRerunSpec(input.root, offer)) {
      const state = await loadEvalResumeState(input.evalDirectory);
      journal = await loadRemoteRerunJournal({ root: input.root, evalDirectory: input.evalDirectory, plan: state.executionPlan,
        request: await readJSON<EvalRequest>(path.join(input.evalDirectory, "request.json")), offer });
      if (journal) await collectRemoteRerunJournal(journal, { leaseId: lease.lease_id, refs: [],
        run: remoteBackendResult(offer, offer, null, null, journal.record.result?.run.backend.version) });
    }
    if (!journal && !input.cancelRequested) {
      await finishRelease(input, current, offer);
      throw new HitchError(`recovered remote work ended as ${offer.terminal?.status ?? "unknown"}`, { code: "remote_work_failed", exitCode: 13 });
    }
  }
  await finishRelease(input, current, offer);
  if (journal) await completeRemoteRerunJournal(journal, lease.lease_id);
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
      if (await input.protocol.generationCleanup.read(offer)) return offer;
      const worker = await input.registry.get(offer.worker_id);
      if (worker?.revoked_at) throw ambiguous(`remote worker was revoked during recovery: ${offer.worker_id}`);
      if (worker && worker.generation !== offer.generation) throw new HitchError("remote worker generation changed during recovery", { code: "worker_generation_mismatch", exitCode: 12 });
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

async function collectRemoteResult(input: Parameters<typeof recoverRemoteWorkerEvalLeases>[0], lease: ExecutionLeaseV1, offer: RemoteWorkOfferV1): Promise<RemoteRerunJournal | null> {
  const state = await loadEvalResumeState(input.evalDirectory);
  const request = await readJSON<EvalRequest>(path.join(input.evalDirectory, "request.json"));
  const journal = await loadRemoteRerunJournal({ root: input.root, evalDirectory: input.evalDirectory, plan: state.executionPlan, request, offer });
  // Later reruns may already own this logical slot. A released, completed
  // journal is an immutable receipt, not a request to republish its old trial.
  if (lease.state === "released" && journal?.record.state === "completed") return journal;
  const retryState = await readEvalRetryState(input.evalDirectory, input.evalId);
  const dynamic = resolveRetryWork(state.executionPlan, retryState, lease.work_id);
  const work = state.executionPlan.work_items.find((entry) => entry.work_id === lease.work_id) ?? dynamic?.item ?? (journal ? offer.work : undefined);
  if (!work || work.logical_attempt === null || work.task_ids.length !== 1) throw ambiguous("recovered remote lease does not match one planned task slot");
  const existing = state.progress.trials.find((trial) => trial.task_id === work.task_ids[0] && trial.attempt === work.logical_attempt);
  if (existing?.observation_status === "valid" && !journal) {
    if (dynamic) for (const decision of dynamic.decisions) await settleRemoteRetryDecision(input.evalDirectory, input.evalId, decision.decision_id, decision.state, "repaired");
    return null;
  }
  if (existing && !dynamic && !journal) return null;
  const artifacts = offer.terminal?.artifacts.filter((artifact) => artifact.kind === "result-bundle") ?? [];
  if (artifacts.length !== 1) throw ambiguous("recovered remote success requires exactly one result bundle");
  const resolution = journal?.verifier ? undefined : await readJSON<ResolvedRevision>(path.join(input.evalDirectory, "resolution.json"));
  const runtime = state.plan.controller_runtime as Record<string, unknown> | undefined;
  const environmentImages = journal?.verifier ? undefined : await loadTrialEnvironmentImages({
    taskId: work.task_ids[0] as string,
    uses: work.image_refs ?? [],
    loader: (imageId) => loadEnvironmentImageManifest(input.root, imageId),
  });
  const artifact = artifacts[0] as typeof artifacts[number];
  let grading: Awaited<ReturnType<typeof importRemoteVerifierResultEnvelope>> | undefined;
  const imported = journal?.verifier ? grading = await importRemoteVerifierResultEnvelope({
    root: input.root, evalDirectory: input.evalDirectory, verifier: journal.verifier, plan: state.executionPlan, work, physical: journal.physical,
    lease: lease.epoch === offer.lease.epoch ? lease : offer.lease,
    artifactPath: input.protocol.artifactPath(offer.worker_id, lease.lease_id, artifact.digest),
  }) : await importRemoteResultEnvelope({
    root: input.root, evalDirectory: input.evalDirectory, request, resolvedRevision: resolution!,
    work, lease: lease.epoch === offer.lease.epoch ? lease : offer.lease,
    artifactPath: input.protocol.artifactPath(offer.worker_id, lease.lease_id, artifact.digest),
    verifierSourceExpected: await verifierSourceRequested(input.root, offer),
    ...(request.training_binding || request.local_inference ? { modelProof: await input.protocol.modelRoutes.boundRun(offer) } : {}),
    ...(dynamic || journal ? { publicationMode: "replace-invalid" as const } : {}),
    ...(typeof runtime?.runtime_id === "string" ? { runtimeId: runtime.runtime_id } : {}),
    ...(environmentImages ? { environmentImages } : {}),
    ...(state.executionPlan.model_capture ? { modelCapturePlan: state.executionPlan.model_capture } : {}),
  });
  const progress = dynamic || journal
    ? imported.ref.observation_status === "valid" ? replaceInvalidEvalProgressTrial(state.progress, imported.ref) : state.progress
    : mergeEvalProgressTrial(state.progress, imported.ref);
  if (progress.generation !== state.progress.generation) await writeEvalProgress(input.evalDirectory, progress);
  if (journal) await collectRemoteRerunJournal(journal, { leaseId: lease.lease_id, refs: [imported.ref],
    ...(grading ? { assessments: [grading.assessment] } : {}),
    run: remoteBackendResult(offer, offer, imported.trial, imported.backendDirectory, journal.record.result?.run.backend.version,
      grading?.outcome) });
  if (dynamic) {
    const retryIndex = dynamic.decisions[0]?.retry_index ?? 0;
    if (imported.ref.observation_status === "invalid" && physicalRetryAllowed(classifyTrialFailure(imported.ref))
      && retryIndex < state.executionPlan.retry_policy.infrastructure_retries) {
      const origin = state.executionPlan.work_items.find((item) => item.slots.includes(dynamic.decisions[0]!.slot_id));
      if (!origin) throw ambiguous("recovered retry origin is absent from execution plan");
      const nextWork = physicalRetryWorkItem(origin, retryIndex + 1, [imported.ref]);
      await ensurePhysicalRetryDecision({
        evalDirectory: input.evalDirectory, evalId: input.evalId, item: origin, retryIndex: retryIndex + 1, trigger: imported.ref,
        notBefore: new Date(Date.now() + retryBackoffMs(state.executionPlan.retry_policy.infrastructure_retry_backoff_ms, retryIndex + 1, nextWork.work_id)).toISOString(),
      });
    }
    const target = imported.ref.observation_status === "valid" ? "repaired"
      : retryIndex >= state.executionPlan.retry_policy.infrastructure_retries ? "exhausted" : "invalid";
    for (const decision of dynamic.decisions) await settleRemoteRetryDecision(input.evalDirectory, input.evalId, decision.decision_id, decision.state, target);
  }
  input.emit?.({ type: "eval.work-item.recovered", work_id: work.work_id, lease_id: lease.lease_id, trials: 1 });
  return journal;
}

async function settleRemoteRetryDecision(
  evalDirectory: string,
  evalId: string,
  decisionId: string,
  current: "planned" | "running" | "repaired" | "invalid" | "skipped" | "exhausted",
  target: "repaired" | "invalid" | "exhausted",
): Promise<void> {
  if (current === target) return;
  if (current === "planned") {
    await transitionRetryDecision({ evalDirectory, evalId, decisionId, state: "running" });
    current = "running";
  }
  if (current === "running") await transitionRetryDecision({ evalDirectory, evalId, decisionId, state: target });
}

async function finishRelease(input: Parameters<typeof recoverRemoteWorkerEvalLeases>[0], lease: ExecutionLeaseV1, terminal: RemoteWorkOfferV1): Promise<void> {
  input.emit?.({ type: "sandbox.cleanup.started", work_id: lease.work_id, lease_id: lease.lease_id, worker_id: lease.worker_id });
  let cleanup = await input.protocol.generationCleanup.read(terminal);
  let offer = cleanup || terminal.state === "released" ? terminal : await input.protocol.requestRelease(terminal.worker_id, terminal.offer_id);
  const deadline = Date.now() + input.releaseTimeoutMs;
  while (!cleanup && offer.state !== "released" && Date.now() < deadline) {
    await delay(input.pollIntervalMs);
    offer = await input.protocol.getOffer(offer.worker_id, offer.offer_id) ?? offer;
    cleanup = await input.protocol.generationCleanup.read(offer);
  }
  if (cleanup || offer.state === "released") {
    if (cleanup) await input.protocol.generationCleanup.reconcile(offer, cleanup);
    else await confirmRemoteExecutionLeaseReleased({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch, offer });
    input.emit?.({ type: "lease.released", work_id: lease.work_id, lease_id: lease.lease_id, lease_epoch: lease.epoch, worker_id: lease.worker_id });
    input.emit?.({ type: "sandbox.cleanup.completed", work_id: lease.work_id, lease_id: lease.lease_id, worker_id: lease.worker_id, residual_resources: 0 });
    return;
  }
  await markExecutionLeaseLost({ evalDirectory: input.evalDirectory, leaseId: lease.lease_id, expectedEpoch: lease.epoch });
  input.emit?.({ type: "sandbox.cleanup.failed", work_id: lease.work_id, lease_id: lease.lease_id, worker_id: lease.worker_id, code: "worker_release_timeout" });
  throw new HitchError("remote worker release was not acknowledged; resources remain unresolved", { code: "worker_release_timeout", exitCode: 12 });
}

function activeRemoteLease(lease: ExecutionLeaseV1): boolean {
  return lease.provider !== "local-docker" && new Set(["offered", "accepted", "running", "releasing"]).has(lease.state);
}
function acceptedOrLater(offer: RemoteWorkOfferV1): boolean {
  return new Set(["accepted", "cancel-requested", "completed", "release-requested", "released"]).has(offer.state)
    && typeof offer.accepted_at === "string" && typeof offer.accept_receipt_digest === "string";
}
function sameLease(offer: RemoteWorkOfferV1, lease: ExecutionLeaseV1, cleanup?: RemoteWorkerCleanupReceipt): boolean {
  if (cleanup) { try { assertRemoteLeaseRelease(lease, offer, cleanup); return true; } catch { return false; } }
  if (offer.lease.epoch !== lease.epoch) {
    try { assertRemoteLeaseRelease(lease, offer); return true; } catch { return false; }
  }
  return offer.lease.lease_id === lease.lease_id && offer.lease.epoch === lease.epoch && offer.worker_id === lease.worker_id
    && offer.lease.eval_id === lease.eval_id && offer.lease.work_id === lease.work_id
    && offer.lease.provider === lease.provider && offer.lease.collision_domain_id === lease.collision_domain_id;
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
