import { readdir } from "node:fs/promises";
import path from "node:path";
import type { AcquireManagedInferenceInputV1, InferenceLockV1, InferenceServiceRecordV1, RemoteWorkOfferV1 } from "../domain/index.js";
import { parseExecutionLease, parsePhysicalExecution, readExecutionLeases } from "../evals/index.js";
import { HitchError, readJSON, sha256JSON, statePaths } from "../foundation/index.js";
import { validateInferenceLockShape } from "../inference/index.js";
import { remoteModelBinding } from "../model-access/index.js";
import type { RemoteModelTargetV2 } from "../model-access/index.js";
import { parseEvalControl } from "./eval-records.js";
import type { RemoteWorkerRegistry } from "./remote-workers.js";
import type { RemoteWorkerProtocol } from "./remote-worker-protocol.js";
import { RemoteWorkInputStore } from "./remote-work-inputs.js";
import { verifyManagedGateway } from "./managed-gateway-receipt.js";

type Target = Extract<RemoteModelTargetV2, { kind: "managed-inference" }>;
type State = "active" | "waiting" | "finished";
export interface ManagedServiceRecoveryPlan {
  record: InferenceServiceRecordV1;
  ownerId: string;
  lock: InferenceLockV1;
  cacheScopeOwner: string;
  evidenceOwner: NonNullable<AcquireManagedInferenceInputV1["evidence_owner"]>;
  target: Target;
  port: number;
  state(): Promise<State>;
}

/** Private routes already seal the original gateway credentials before dispatch. */
export class ManagedServiceRecovery {
  constructor(readonly root: string, readonly registry: RemoteWorkerRegistry, readonly protocol: RemoteWorkerProtocol) {}

  async select(records: InferenceServiceRecordV1[]): Promise<ManagedServiceRecoveryPlan[]> {
    const groups = new Map<string, { plan: ManagedServiceRecoveryPlan; seeds: RemoteWorkOfferV1[] }>();
    const evals = await readdir(statePaths(this.root).evals, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error;
    });
    const inputs = new RemoteWorkInputStore(this.root);
    for (const directory of evals) {
      if (!directory.isDirectory() || !/^eval_[a-f0-9]{32}$/.test(directory.name)) continue;
      const evalDirectory = path.join(statePaths(this.root).evals, directory.name);
      for (const lease of await readExecutionLeases(evalDirectory)) {
        if (lease.provider === "local-docker" || !["offered", "accepted", "running"].includes(lease.state) || Date.parse(lease.expires_at) <= Date.now()) continue;
        const offer = await this.protocol.findOfferForLease(lease.worker_id, lease.lease_id);
        if (!offer || offer.state !== "accepted") continue;
        const worker = await this.registry.get(offer.worker_id);
        if (!worker || worker.revoked_at || worker.generation !== offer.generation) continue;
        const ref = offer.inputs?.find(item => item.kind === "work-spec"); if (!ref) continue;
        const spec = await readJSON<Record<string, unknown>>((await inputs.verify(ref)).path);
        if ((spec.model_binding as { kind?: unknown } | undefined)?.kind !== "managed-inference") continue;
        const target = await this.protocol.modelRoutes.recoveryTarget(offer);
        if (!target || target.kind !== "managed-inference" || target.binding.kind !== "managed-node"
          || spec.schema_version !== "2" || sha256JSON(spec.work) !== sha256JSON(offer.work)
          || sha256JSON(spec.model_binding) !== sha256JSON(remoteModelBinding(target))) throw ambiguous("managed route differs from its sealed work input");
        const url = new URL(target.binding.base_url), match = url.pathname.match(/^\/runs\/(run_[a-f0-9]{32})\/v1\/$/);
        if (!match || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash
          || !/^[a-f0-9]{64}$/.test(target.credential)) throw ambiguous("original private gateway address or credential is invalid");
        const ownerId = match[1]!;
        const physical = spec.physical_execution ? parsePhysicalExecution(spec.physical_execution) : undefined;
        if (physical?.kind === "verifier-only") throw ambiguous("verifier work cannot recover a model gateway");
        const rerunId = physical && physical.kind !== "physical-infrastructure-retry" ? physical.rerun_id : undefined;
        if (ownerId !== `run_${(rerunId ?? lease.eval_id).slice((rerunId ? "rerun_" : "eval_").length)}`) throw ambiguous("gateway owner differs from its original eval or rerun");
        const cacheScopeOwner = rerunId ? `${lease.eval_id}:${rerunId}` : lease.eval_id;
        const evidenceOwner = { kind: "eval" as const, eval_id: lease.eval_id, ...(rerunId ? { rerun_id: rerunId } : {}) };
        if (await this.cancelled(evidenceOwner)) continue;
        const candidates = records.filter(record => record.inference_id === target.binding.inference_id && record.lease_owner_ids.includes(ownerId)
          && sha256JSON(record.model_node ?? null) === sha256JSON(target.binding.model_node));
        if (candidates.length !== 1 || candidates[0]!.state !== "ready") throw ambiguous("accepted model work has no unique original ready service");
        const record = candidates[0]!;
        await verifyManagedGateway(this.root, { serviceId: record.service_id, epoch: record.epoch, inferenceId: record.inference_id,
          isolationKey: record.isolation_key, ownerId, cacheScopeOwner, evidenceOwner, binding: target.binding, credential: target.credential });
        const scopeDirectory = rerunId ? path.join(evalDirectory, "reruns", rerunId) : evalDirectory;
        const lock = validateInferenceLockShape(await readJSON(path.join(scopeDirectory, "inference", "lock.json")));
        const execution = await readJSON<Record<string, unknown>>(path.join(scopeDirectory, "inference", "execution.json"));
        if (record.inference_id !== lock.inference_id || lock.model_id !== target.modelId
          || lock.protocol.api !== target.binding.api || lock.generation.max_output_tokens !== target.maxOutputTokens
          || sha256JSON(lock.model_node ?? null) !== sha256JSON(record.model_node)
          || record.isolation_key !== sha256JSON({ inference_id: lock.inference_id, cache_scope_owner: cacheScopeOwner })
          || execution.schema_version !== "2" || execution.run_id !== ownerId || execution.eval_id !== lease.eval_id || execution.rerun_id !== rerunId
          || sha256JSON(execution.service) !== sha256JSON({ service_id: record.service_id, epoch: record.epoch, isolation_key: record.isolation_key })) {
          throw ambiguous("original inference execution evidence differs from the active gateway");
        }
        const key = `${record.service_id}:${ownerId}`;
        const prior = groups.get(key);
        if (prior) {
          if (sha256JSON(prior.plan.target) !== sha256JSON(target)) throw ambiguous("one model owner has conflicting private gateways");
          prior.seeds.push(offer);
        } else {
          const seeds = [offer];
          const plan: ManagedServiceRecoveryPlan = { record, ownerId, lock, cacheScopeOwner, evidenceOwner, target, port: Number(url.port),
            state: () => this.state(seeds, target, evidenceOwner) };
          groups.set(key, { plan, seeds });
        }
      }
    }
    const plans: ManagedServiceRecoveryPlan[] = [];
    for (const { plan } of groups.values()) if (await plan.state() !== "finished") plans.push(plan);
    return plans;
  }

  private async cancelled(owner: ManagedServiceRecoveryPlan["evidenceOwner"]): Promise<boolean> {
    const directory = path.join(statePaths(this.root).evals, owner.eval_id);
    if (owner.rerun_id) {
      const state = await readJSON<Record<string, unknown>>(path.join(directory, "reruns", owner.rerun_id, "state.json"));
      if (state.schema_version !== "1" || state.eval_id !== owner.eval_id || state.rerun_id !== owner.rerun_id
        || !["queued", "running", "completed", "failed", "cancelled"].includes(String(state.status))) throw ambiguous("rerun state identity changed");
      const marker = await readJSON<Record<string, unknown> | null>(path.join(directory, "reruns", owner.rerun_id, "cancellation.json"), null);
      if (marker && (marker.schema_version !== "1" || marker.eval_id !== owner.eval_id || marker.rerun_id !== owner.rerun_id)) throw ambiguous("rerun cancellation identity changed");
      return !!marker || ["completed", "failed", "cancelled"].includes(String(state.status));
    }
    const control = parseEvalControl(await readJSON(path.join(directory, "control.json")));
    if (control.eval_id !== owner.eval_id) throw ambiguous("eval control identity changed");
    return !!control.cancel_requested_at || ["cancelling", "cancelled", "failed", "succeeded"].includes(control.state);
  }

  private async state(seeds: RemoteWorkOfferV1[], target: Target, owner: ManagedServiceRecoveryPlan["evidenceOwner"]): Promise<State> {
    if (await this.cancelled(owner)) return "finished";
    let waiting = false;
    for (const seed of seeds) {
      const offer = await this.protocol.getOffer(seed.worker_id, seed.offer_id);
      if (!offer) throw ambiguous("accepted model offer disappeared during recovery");
      if (sha256JSON(identity(offer)) !== sha256JSON(identity(seed))) throw ambiguous("accepted model offer identity changed");
      if (offer.state !== "accepted") continue;
      const lease = parseExecutionLease(await readJSON(path.join(statePaths(this.root).evals, owner.eval_id, "leases", `${offer.lease.lease_id}.json`)));
      if (lease.epoch !== offer.lease.epoch || !["offered", "accepted", "running"].includes(lease.state) || Date.parse(lease.expires_at) <= Date.now()) continue;
      const worker = await this.registry.get(offer.worker_id);
      if (!worker || worker.revoked_at || worker.generation !== offer.generation) continue;
      await this.protocol.modelRoutes.authorize(offer);
      if (sha256JSON(await this.protocol.modelRoutes.recoveryTarget(offer)) !== sha256JSON(target)) throw ambiguous("private model route changed during recovery");
      if (worker.worker.status === "ready") return "active";
      waiting = true;
    }
    return waiting ? "waiting" : "finished";
  }
}
function identity(offer: RemoteWorkOfferV1) {
  return { worker: offer.worker_id, generation: offer.generation, offer: offer.offer_id, nonce: offer.nonce, lease: offer.lease, work: offer.work, inputs: offer.inputs };
}
function ambiguous(message: string) { return new HitchError(message, { code: "inference_recovery_ambiguous", exitCode: 12 }); }
