import { randomBytes, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { BackendWorkItemV1, ExecutionLeaseV1, RemoteCredentialEnvelopeV1, RemoteWorkArtifactRefV1, RemoteWorkInputRefV1, RemoteWorkOfferV1, RemoteWorkerEventV1, RemoteWorkerHeartbeatV1, ResourceVectorV1, Sha256 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, ensureDir, readJSON, sha256JSON, statePaths, withFileLock } from "../foundation/index.js";
import { parseExecutionLease } from "../evals/index.js";
import { maxResourceVectors, resourceValue, subtractResourceVectors, sumResourceVectors } from "./resources.js";
import { RemoteWorkerArtifactStore } from "./remote-worker-artifacts.js";
import type { RemoteWorkerRegistry } from "./remote-workers.js";
import { RemoteWorkInputStore } from "./remote-work-inputs.js";
import { RemoteCredentialEnvelopeIssuer } from "./remote-worker-credentials.js";
import { parseRemoteWorkItem } from "./remote-work-item.js";
import { RemoteModelRoutes } from "./remote-model-routes.js";
import type { RemoteModelTargetV2 } from "./remote-model-routes.js";
import { validateRemoteOfferContract } from "./remote-offer-contract.js";
import { readRemoteExecutionLease } from "./remote-execution-lease.js";
import { RemoteWorkerOwnershipStore, parseRemoteExecutionOwnership } from "./remote-worker-ownership.js";
import type { RemoteWorkerExecutionAdmissionV2, RemoteWorkerExecutionOwnership } from "../domain/index.js";
import { RemoteWorkerGenerationCleanup } from "./remote-worker-cleanup.js";

import { parseRemoteWorkOffer, parseRemoteWorkerEvent, parseAcceptReceipt, parseTerminalReceipt, parseReleaseReceipt, parseInputRef } from "./remote-worker-codecs.js";
export { parseRemoteWorkOffer, parseRemoteWorkerEvent } from "./remote-worker-codecs.js";

const OFFER_ID = /^offer_[a-f0-9]{32}$/;
const LEASE_ID = /^lease_[a-f0-9]{32}$/;
const DEFAULT_OFFER_TTL_MS = 30_000;

export class RemoteWorkerProtocol {
  private readonly root: string;
  private readonly registry: RemoteWorkerRegistry;
  private readonly directory: string;
  private readonly locks: string;
  private readonly offerTtlMs: number;
  private readonly credentials: RemoteCredentialEnvelopeIssuer;
  private readonly artifacts: RemoteWorkerArtifactStore;
  private readonly inputs: RemoteWorkInputStore;
  private readonly ownership: RemoteWorkerOwnershipStore;
  readonly modelRoutes: RemoteModelRoutes;
  readonly generationCleanup: RemoteWorkerGenerationCleanup;

  constructor(input: { root: string; registry: RemoteWorkerRegistry; offerTtlMs?: number; credentialEnvelopeTtlMs?: number; credentialEnv?: NodeJS.ProcessEnv }) {
    const ttl = input.offerTtlMs ?? DEFAULT_OFFER_TTL_MS;
    if (!input.root || !Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 5 * 60_000) throw new TypeError("remote worker protocol configuration is invalid");
    const paths = statePaths(input.root);
    this.root = input.root;
    this.generationCleanup = new RemoteWorkerGenerationCleanup(input.root, input.registry, (workerId, offerId) => this.getOffer(workerId, offerId));
    this.modelRoutes = new RemoteModelRoutes(input.root);
    this.registry = input.registry;
    this.directory = paths.workerProtocol;
    this.locks = paths.workerProtocolLocks;
    this.offerTtlMs = ttl;
    this.credentials = new RemoteCredentialEnvelopeIssuer({
      ...(input.credentialEnv ? { env: input.credentialEnv } : {}),
      ...(input.credentialEnvelopeTtlMs === undefined ? {} : { ttlMs: input.credentialEnvelopeTtlMs }),
    });
    this.artifacts = new RemoteWorkerArtifactStore({ root: input.root });
    this.inputs = new RemoteWorkInputStore(input.root);
    this.ownership = new RemoteWorkerOwnershipStore(input.root);
  }

  async initialize(): Promise<void> {
    await Promise.all([ensureDir(this.directory), ensureDir(this.locks), this.artifacts.initialize(), this.inputs.initialize()]);
  }

  credentialNamesFor(explicitNames: readonly string[]): string[] {
    return this.credentials.namesFor(explicitNames);
  }

  async createOffer(workerId: string, leaseValue: ExecutionLeaseV1, workValue: BackendWorkItemV1, inputRefs: RemoteWorkInputRefV1[] = [], credentialNames: readonly string[] = [], modelTarget?: RemoteModelTargetV2): Promise<RemoteWorkOfferV1> {
    return withFileLock(this.locks, `offers-${workerId}`, async () => {
      const worker = await this.requireReadyWorker(workerId);
      const lease = parseExecutionLease(leaseValue);
      const work = parseRemoteWorkItem(workValue);
      const inputs = inputRefs.map(parseInputRef);
      const credentials = this.credentials.requireAvailable(credentialNames);
      if (new Set(inputs.map((entry) => entry.kind)).size !== inputs.length) throw protocolError("remote work inputs are duplicated");
      if (lease.state !== "offered" || lease.worker_id !== workerId || lease.provider !== worker.worker.provider
        || lease.collision_domain_id !== worker.worker.collision_domain_id || lease.work_id !== work.work_id
        || lease.eval_id !== work.eval_id || work.provider !== worker.worker.provider
        || JSON.stringify(lease.reservation) !== JSON.stringify(work.reservation)) throw protocolError("remote work offer identity is invalid");
      const outstanding = sumReservations(await this.listOffers(workerId, worker.generation));
      const used = maxResources(worker.worker.capacity.allocated, outstanding);
      assertFits(lease.reservation, available(worker.worker.capacity.allocatable, used));
      const now = new Date();
      const offer: RemoteWorkOfferV1 = {
        schema_version: "1",
        offer_id: `offer_${randomUUID().replaceAll("-", "")}`,
        nonce: randomBytes(32).toString("hex"),
        generation: worker.generation,
        worker_id: workerId,
        lease,
        work,
        ...(inputs.length > 0 ? { inputs } : {}),
        ...(credentials.length > 0 ? { credential_names: credentials } : {}),
        state: "offered",
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + this.offerTtlMs).toISOString(),
      };
      await validateRemoteOfferContract(offer, worker.provider_status.features, this.inputs, modelTarget);
      return this.registry.withGeneration(workerId, worker.generation, async () => {
        if (modelTarget) await this.modelRoutes.prepare(offer, modelTarget);
        await atomicWriteJSON(this.offerPath(workerId, offer.offer_id), offer);
        return offer;
      });
    }, { timeoutCode: "worker_offer_selection_locked", timeoutExitCode: 12 });
  }

  async listOffers(workerId: string, generation: number): Promise<RemoteWorkOfferV1[]> {
    await this.requireWorkerGeneration(workerId, generation);
    const directory = this.offersDirectory(workerId);
    await ensureDir(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const offers: RemoteWorkOfferV1[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !/^offer_[a-f0-9]{32}\.json$/.test(entry.name)) continue;
      let offer = parseRemoteWorkOffer(await readJSON(path.join(directory, entry.name)));
      const cleanup = await this.generationCleanup.read(offer);
      if (cleanup) { await this.generationCleanup.reconcile(offer, cleanup); continue; }
      if (offer.state === "offered" && Date.parse(offer.expires_at) <= Date.now()) offer = await this.expireOffer(offer);
      if (offer.state === "offered" || offer.state === "accepted" || offer.state === "cancel-requested" || offer.state === "completed" || offer.state === "release-requested") offers.push(offer);
    }
    return offers;
  }

  async acceptOffer(workerId: string, value: unknown, ownership?: RemoteWorkerExecutionOwnership): Promise<RemoteWorkOfferV1> {
    const receipt = parseAcceptReceipt(value);
    await this.requireWorkerGeneration(workerId, receipt.generation);
    return this.updateOffer(workerId, receipt.offer_id, async (offer) => {
      assertOfferReceipt(offer, workerId, receipt.generation, receipt.nonce);
      const admission = await this.ownership.read(offer);
      if (ownership !== undefined) {
        parseRemoteExecutionOwnership(ownership, offer);
        if (!receipt.accepted || offer.state !== "offered" && !admission) throw protocolError("execution ownership cannot be attached after acceptance");
      } else if (admission) throw protocolError("execution ownership acceptance cannot be downgraded to v1");
      const digest = sha256JSON(receipt);
      if (offer.accept_receipt_digest) {
        if (offer.accept_receipt_digest !== digest) throw replayError("remote work offer acceptance conflicts with its receipt");
        return offer;
      }
      if (offer.state !== "offered") throw replayError(`remote work offer cannot be accepted from ${offer.state}`);
      if (Date.parse(offer.expires_at) <= Date.now()) return { ...offer, state: "expired" };
      const now = admission?.accepted_at ?? new Date().toISOString();
      if (!receipt.accepted) return {
        ...offer,
        state: "rejected",
        rejection_code: receipt.rejection_code as string,
        accept_receipt_digest: digest,
        completed_at: now,
      };
      return { ...offer, state: "accepted", accepted_at: now, accept_receipt_digest: digest };
    }, receipt.generation, ownership === undefined ? undefined : async next => {
      if (next.accepted_at) await this.ownership.admit(next, ownership);
    });
  }

  async executionAdmission(workerId: string, offerId: string): Promise<RemoteWorkerExecutionAdmissionV2 | null> {
    const offer = await this.getOffer(workerId, offerId);
    return offer ? this.ownership.read(offer) : null;
  }

  async authorizeExecutionProcess(workerId: string, offerId: string, generation: number, ownershipDigest: unknown, identity: unknown): Promise<RemoteWorkerExecutionAdmissionV2> {
    let admission!: RemoteWorkerExecutionAdmissionV2;
    await this.updateOffer(workerId, offerId, async offer => {
      if (offer.generation !== generation || offer.state !== "accepted") throw protocolError("Harbor process requires the original accepted generation");
      return offer;
    }, generation, async offer => { admission = await this.ownership.authorizeProcess(offer, ownershipDigest, identity); });
    return admission;
  }

  async recordEvent(workerId: string, value: unknown): Promise<{ event: RemoteWorkerEventV1; duplicate: boolean }> {
    const event = parseRemoteWorkerEvent(value);
    await this.requireWorkerGeneration(workerId, event.generation);
    const offer = await this.offerForLease(event.lease_id);
    if (offer.worker_id !== workerId || offer.generation !== event.generation || offer.lease.epoch !== event.epoch
      || !new Set(["accepted", "cancel-requested", "completed", "release-requested"]).has(offer.state)) throw protocolError("remote worker event lease is not active");
    return withFileLock(this.locks, `event-${event.lease_id}`, () => this.registry.withGeneration(workerId, event.generation, async () => {
      const statePath = this.eventStatePath(event.lease_id);
      const state = await readJSON<{ sequence?: unknown } | null>(statePath, null);
      const sequence = state === null ? 0 : validSequence(state.sequence, true);
      const file = this.eventPath(event.lease_id, event.sequence);
      const existing = await readJSON<unknown | null>(file, null);
      if (existing !== null) {
        const parsed = parseRemoteWorkerEvent(existing);
        if (sha256JSON(parsed) !== sha256JSON(event)) throw replayError("remote worker event sequence was replayed with different content");
        if (event.sequence === sequence + 1) await atomicWriteJSON(statePath, { schema_version: "1", sequence: event.sequence });
        else if (event.sequence > sequence) throw protocolError("remote worker event sequence has a gap");
        return { event: parsed, duplicate: true };
      }
      if (event.sequence !== sequence + 1) throw protocolError("remote worker event sequence is not contiguous");
      await atomicWriteJSON(file, event);
      await atomicWriteJSON(statePath, { schema_version: "1", sequence: event.sequence });
      return { event, duplicate: false };
    }), { timeoutCode: "worker_event_locked", timeoutExitCode: 12 });
  }

  async completeOffer(workerId: string, value: unknown): Promise<RemoteWorkOfferV1> {
    const receipt = parseTerminalReceipt(value);
    await this.requireWorkerGeneration(workerId, receipt.generation);
    return this.updateOffer(workerId, receipt.offer_id, async (offer) => {
      assertOfferReceipt(offer, workerId, receipt.generation, receipt.nonce);
      if (offer.lease.lease_id !== receipt.lease_id || offer.lease.epoch !== receipt.epoch) throw protocolError("remote work terminal receipt lease is invalid");
      const digest = sha256JSON(receipt);
      if (offer.terminal_receipt_digest) {
        if (offer.terminal_receipt_digest !== digest) throw replayError("remote work terminal receipt conflicts with the persisted receipt");
        return offer;
      }
      if (offer.state !== "accepted" && offer.state !== "cancel-requested") throw replayError(`remote work offer cannot complete from ${offer.state}`);
      for (const artifact of receipt.artifacts) await this.artifacts.verify(workerId, receipt.lease_id, artifact, receipt.epoch);
      return {
        ...offer,
        state: "completed",
        completed_at: receipt.sent_at,
        terminal: { status: receipt.status, artifacts: receipt.artifacts, sent_at: receipt.sent_at },
        terminal_receipt_digest: digest,
      };
    }, receipt.generation);
  }

  async requestCancel(workerId: string, offerId: string): Promise<RemoteWorkOfferV1> {
    return this.updateOffer(workerId, offerId, async (offer) => {
      if (offer.state === "cancel-requested" || offer.state === "completed" || offer.state === "released") return offer;
      if (offer.state !== "offered" && offer.state !== "accepted") throw protocolError(`remote work offer cannot be cancelled from ${offer.state}`);
      return { ...offer, state: "cancel-requested" };
    });
  }

  async withdrawUnacceptedOffer(workerId: string, offerId: string): Promise<RemoteWorkOfferV1> {
    return this.updateOffer(workerId, offerId, async (offer) => {
      if (offer.state !== "offered") return offer;
      return { ...offer, state: "expired", completed_at: new Date().toISOString() };
    });
  }

  async requestRelease(workerId: string, offerId: string): Promise<RemoteWorkOfferV1> {
    return this.updateOffer(workerId, offerId, async (offer) => {
      if (offer.state === "release-requested" || offer.state === "released") return offer;
      if (offer.state !== "completed") throw protocolError(`remote work offer cannot request release from ${offer.state}`);
      return { ...offer, state: "release-requested" };
    });
  }

  async releaseOffer(workerId: string, value: unknown): Promise<RemoteWorkOfferV1> {
    const receipt = parseReleaseReceipt(value);
    await this.requireWorkerGeneration(workerId, receipt.generation);
    return this.updateOffer(workerId, receipt.offer_id, async (offer) => {
      assertOfferReceipt(offer, workerId, receipt.generation, receipt.nonce);
      if (offer.lease.lease_id !== receipt.lease_id || offer.lease.epoch !== receipt.epoch) throw protocolError("remote work release receipt lease is invalid");
      const digest = sha256JSON(receipt);
      if (offer.release_receipt_digest) {
        if (offer.release_receipt_digest !== digest) throw replayError("remote work release receipt conflicts with the persisted receipt");
        return offer;
      }
      if (offer.state !== "completed" && offer.state !== "release-requested" && offer.state !== "cancel-requested") throw protocolError(`remote work offer cannot be released from ${offer.state}`);
      return {
        ...offer,
        state: "released",
        ...(offer.terminal ? {} : {
          completed_at: receipt.sent_at,
          terminal: { status: "cancelled" as const, artifacts: [], sent_at: receipt.sent_at },
        }),
        released_at: receipt.sent_at,
        release_receipt_digest: digest,
      };
    }, receipt.generation);
  }

  async getOffer(workerId: string, offerId: string): Promise<RemoteWorkOfferV1 | null> {
    validateOfferIdentity(workerId, offerId);
    const value = await readJSON<unknown | null>(this.offerPath(workerId, offerId), null);
    return value === null ? null : parseRemoteWorkOffer(value);
  }

  async getOfferForLease(leaseId: string): Promise<RemoteWorkOfferV1 | null> {
    if (!LEASE_ID.test(leaseId)) throw protocolError("remote work lease id is invalid");
    try { return await this.offerForLease(leaseId); }
    catch (error) {
      if ((error as { code?: string }).code === "worker_offer_not_found") return null;
      throw error;
    }
  }

  async findOfferForLease(workerId: string, leaseId: string): Promise<RemoteWorkOfferV1 | null> {
    if (!/^worker_[a-z0-9][a-z0-9_-]{0,62}$/.test(workerId) || !LEASE_ID.test(leaseId)) throw protocolError("remote work lease identity is invalid");
    const directory = this.offersDirectory(workerId);
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const matches: RemoteWorkOfferV1[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^offer_[a-f0-9]{32}\.json$/.test(entry.name)) continue;
      const offer = parseRemoteWorkOffer(await readJSON(path.join(directory, entry.name)));
      if (offer.lease.lease_id === leaseId) matches.push(offer);
    }
    if (matches.length > 1) throw protocolError(`remote worker lease has multiple offers: ${leaseId}`);
    return matches[0] ?? null;
  }

  async uploadArtifact(input: {
    workerId: string;
    leaseId: string;
    generation: number;
    epoch: number;
    digest: string;
    expectedSize: number;
    body: AsyncIterable<Uint8Array>;
  }) {
    const offer = await this.activeOfferForLease(input.workerId, input.leaseId, input.generation, input.epoch);
    if (offer.state !== "accepted" && offer.state !== "cancel-requested") throw protocolError("remote worker artifact lease is not collecting evidence");
    return this.artifacts.upload({ ...input, publish: commit => this.registry.withGeneration(input.workerId, input.generation, async () => {
      const current = await this.offerForLease(input.leaseId);
      if (current.worker_id !== input.workerId || current.generation !== input.generation || current.lease.epoch !== input.epoch
        || !["accepted", "cancel-requested"].includes(current.state)) throw protocolError("remote worker artifact lease is no longer collecting evidence");
      return commit();
    }) });
  }

  async activeOfferForLease(workerId: string, leaseId: string, generation: number, epoch: number): Promise<RemoteWorkOfferV1> {
    await this.requireWorkerGeneration(workerId, generation);
    const offer = await this.offerForLease(leaseId);
    if (offer.worker_id !== workerId || offer.generation !== generation || offer.lease.epoch !== epoch) throw protocolError("remote worker lease identity is invalid");
    return offer;
  }

  async issueCredentialEnvelope(workerId: string, leaseId: string, generation: number, epoch: number): Promise<RemoteCredentialEnvelopeV1> {
    const offer = await this.activeOfferForLease(workerId, leaseId, generation, epoch);
    return this.credentials.issue(offer);
  }

  async authorizeModelRequest(workerId: string, leaseId: string, generation: number, epoch: number): Promise<RemoteWorkOfferV1> {
    return this.modelRoutes.authorize(await this.activeOfferForLease(workerId, leaseId, generation, epoch));
  }

  async executionLease(workerId: string, leaseId: string, generation: number, epoch: number) {
    const offer = await this.activeOfferForLease(workerId, leaseId, generation, epoch);
    return { schema_version: "2", offer_id: offer.offer_id, generation, lease: await readRemoteExecutionLease(this.root, offer) };
  }

  async validateHeartbeatLeases(workerId: string, heartbeat: RemoteWorkerHeartbeatV1): Promise<void> {
    await this.registry.validateHeartbeatGeneration(workerId, heartbeat.generation);
    for (const lease of heartbeat.active_leases) {
      const offer = await this.offerForLease(lease.lease_id).catch(() => null);
      if (!offer || offer.worker_id !== workerId || offer.generation !== heartbeat.generation
        || offer.lease.epoch !== lease.epoch || !acceptedOrCollecting(offer.state)) {
        throw protocolError(`remote worker heartbeat reports an unauthorized lease: ${lease.lease_id}`);
      }
    }
  }

  async resolveInput(workerId: string, leaseId: string, generation: number, digest: Sha256): Promise<{ path: string; size: number }> {
    await this.requireWorkerGeneration(workerId, generation);
    const offer = await this.findOfferForLease(workerId, leaseId);
    if (!offer || offer.generation !== generation || !new Set(["offered", "accepted", "cancel-requested"]).has(offer.state)) {
      throw protocolError("remote work input lease is not active");
    }
    const ref = offer.inputs?.find((entry) => entry.digest === digest);
    if (!ref) throw protocolError("remote work input is not authorized for this lease");
    return this.inputs.verify(ref);
  }

  artifactPath(workerId: string, leaseId: string, digest: Sha256): string {
    return this.artifacts.pathFor(workerId, leaseId, digest);
  }

  private async updateOffer(workerId: string, offerId: string, update: (offer: RemoteWorkOfferV1) => Promise<RemoteWorkOfferV1>, generation?: number,
    beforePublish?: (offer: RemoteWorkOfferV1) => Promise<void>): Promise<RemoteWorkOfferV1> {
    validateOfferIdentity(workerId, offerId);
    return withFileLock(this.locks, offerId, async () => {
      const current = await this.getOffer(workerId, offerId);
      if (!current) throw new HitchError(`remote work offer not found: ${offerId}`, { code: "worker_offer_not_found", exitCode: 3 });
      const next = parseRemoteWorkOffer(await update(current));
      const publish = async () => {
        await beforePublish?.(next);
        if (current.state === "offered" && next.state === "accepted") await atomicWriteJSON(this.leaseIndexPath(next.lease.lease_id), {
          schema_version: "1", worker_id: workerId, offer_id: next.offer_id, lease_id: next.lease.lease_id, epoch: next.lease.epoch,
        });
        if (next !== current) await atomicWriteJSON(this.offerPath(workerId, offerId), next);
        return next;
      };
      return generation === undefined ? publish() : this.registry.withGeneration(workerId, generation, publish);
    }, { timeoutCode: "worker_offer_locked", timeoutExitCode: 12 });
  }

  private async expireOffer(offer: RemoteWorkOfferV1): Promise<RemoteWorkOfferV1> {
    return this.updateOffer(offer.worker_id, offer.offer_id, async (current) => current.state === "offered" && Date.parse(current.expires_at) <= Date.now()
      ? { ...current, state: "expired" }
      : current);
  }

  private async offerForLease(leaseId: string): Promise<RemoteWorkOfferV1> {
    if (!LEASE_ID.test(leaseId)) throw protocolError("remote worker lease id is invalid");
    const index = await readJSON<Record<string, unknown> | null>(this.leaseIndexPath(leaseId), null);
    if (!index || typeof index.worker_id !== "string" || typeof index.offer_id !== "string") throw protocolError("remote worker lease has no accepted offer");
    const offer = await this.getOffer(index.worker_id, index.offer_id);
    if (!offer || index.lease_id !== leaseId || index.epoch !== offer.lease.epoch) throw protocolError("remote worker lease index is invalid");
    return offer;
  }

  private async requireReadyWorker(workerId: string): Promise<NonNullable<Awaited<ReturnType<RemoteWorkerRegistry["get"]>>>> {
    const worker = await this.registry.get(workerId);
    if (!worker || worker.worker.status !== "ready" || worker.revoked_at) throw new HitchError("remote worker is unavailable", { code: "worker_unavailable", exitCode: 10 });
    return worker;
  }

  private async requireWorkerGeneration(workerId: string, generation: number): Promise<void> {
    const worker = await this.requireReadyWorker(workerId);
    if (worker.generation !== generation) throw new HitchError("remote worker generation is stale", { code: "worker_generation_mismatch", exitCode: 12 });
  }

  private offersDirectory(workerId: string): string { return path.join(this.directory, "workers", workerId, "offers"); }
  private offerPath(workerId: string, offerId: string): string { return path.join(this.offersDirectory(workerId), `${offerId}.json`); }
  private leaseIndexPath(leaseId: string): string { return path.join(this.directory, "leases", `${leaseId}.json`); }
  private eventStatePath(leaseId: string): string { return path.join(this.directory, "events", leaseId, "state.json"); }
  private eventPath(leaseId: string, sequence: number): string { return path.join(this.directory, "events", leaseId, `${String(sequence).padStart(12, "0")}.json`); }
}

function assertOfferReceipt(offer: RemoteWorkOfferV1, workerId: string, generation: number, nonce: string): void {
  if (offer.worker_id !== workerId || offer.generation !== generation || offer.nonce !== nonce) throw replayError("remote work receipt identity does not match the offer");
}

function validateOfferIdentity(workerId: string, offerId: string): void {
  if (!/^worker_[a-z0-9][a-z0-9_-]{0,62}$/.test(workerId) || !OFFER_ID.test(offerId)) throw protocolError("remote work offer lookup identity is invalid");
}

function available(allocatable: ResourceVectorV1, allocated: ResourceVectorV1): ResourceVectorV1 {
  return subtractResourceVectors(allocatable, allocated);
}

function sumReservations(offers: readonly RemoteWorkOfferV1[]): ResourceVectorV1 {
  return sumResourceVectors(offers.map((offer) => offer.lease.reservation));
}

function maxResources(left: ResourceVectorV1, right: ResourceVectorV1): ResourceVectorV1 {
  return maxResourceVectors(left, right);
}

function assertFits(requested: ResourceVectorV1, capacity: ResourceVectorV1): void {
  if (fields().some((field) => resourceValue(requested, field) > resourceValue(capacity, field))) throw new HitchError("remote worker rejected work capacity", { code: "worker_rejected", exitCode: 10 });
}

function acceptedOrCollecting(state: RemoteWorkOfferV1["state"]): boolean {
  return state === "accepted" || state === "cancel-requested" || state === "completed" || state === "release-requested";
}

function fields(): Array<keyof ResourceVectorV1> { return ["cpu_millis", "memory_bytes", "container_slots", "build_slots", "gpu_count", "ephemeral_disk_bytes"]; }
function validSequence(value: unknown, allowZero: boolean): number { if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) throw protocolError("remote worker event sequence state is invalid"); return value as number; }

function protocolError(message: string): HitchError { return new HitchError(message, { code: "worker_protocol_invalid", exitCode: 2 }); }
function replayError(message: string): HitchError { return new HitchError(message, { code: "worker_protocol_replay", exitCode: 12 }); }
