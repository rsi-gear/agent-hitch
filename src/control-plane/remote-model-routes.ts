import path from "node:path";
import type { RemoteWorkOfferV1 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, readJSON, sha256JSON, statePaths, withFileLock } from "../foundation/index.js";
import { callRemoteModel, remoteModelBinding } from "../model-access/index.js";
import type { RemoteModelTargetV2 } from "../model-access/index.js";
import { parseExecutionLease } from "../evals/index.js";

export { parseRemoteModelBinding, remoteModelBinding } from "../model-access/index.js";
export type { RemoteModelTargetV2 } from "../model-access/index.js";

/** Private controller state, never part of an input artifact or worker credential envelope. */
export class RemoteModelRoutes {
  private managedReady: { promise: Promise<void>; resolve(): void } | undefined;
  constructor(private readonly root: string) {}
  deferManagedRecovery(): void {
    if (this.managedReady) throw new TypeError("managed model recovery is already pending");
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    this.managedReady = { promise, resolve };
  }
  finishManagedRecovery(): void { this.managedReady?.resolve(); this.managedReady = undefined; }
  async authorize(offer: RemoteWorkOfferV1): Promise<RemoteWorkOfferV1> {
    const lease = parseExecutionLease(await readJSON(path.join(statePaths(this.root).evals, offer.lease.eval_id, "leases", `${offer.lease.lease_id}.json`)));
    if (offer.state !== "accepted" || !["offered", "accepted", "running"].includes(lease.state)
      || lease.worker_id !== offer.worker_id || lease.epoch !== offer.lease.epoch || lease.work_id !== offer.work.work_id
      || lease.eval_id !== offer.lease.eval_id || lease.provider !== offer.lease.provider
      || lease.collision_domain_id !== offer.lease.collision_domain_id || Date.parse(lease.expires_at) <= Date.now()) {
      throw fenced("remote model lease is cancelled, expired or no longer active");
    }
    return offer;
  }
  private directory(offer: RemoteWorkOfferV1): string {
    return path.join(statePaths(this.root).workerProtocol, "model-routes", offer.lease.lease_id);
  }
  private identity(offer: RemoteWorkOfferV1) {
    return { worker_id: offer.worker_id, generation: offer.generation, offer_id: offer.offer_id,
      lease_id: offer.lease.lease_id, epoch: offer.lease.epoch, work_id: offer.work.work_id, eval_id: offer.lease.eval_id };
  }
  async prepare(offer: RemoteWorkOfferV1, target: RemoteModelTargetV2): Promise<void> {
    const value = { schema_version: "2", identity: this.identity(offer), model_binding: remoteModelBinding(target), target };
    await withFileLock(path.join(this.directory(offer), "locks"), "route", async () => {
      const file = path.join(this.directory(offer), "route.json");
      const old = await readJSON<unknown | null>(file, null);
      if (old && sha256JSON(old) !== sha256JSON(value)) throw fenced("remote model route identity changed");
      if (!old) await atomicWriteJSON(file, value);
    });
  }
  private async route(offer: RemoteWorkOfferV1) {
    const value = await readJSON<{ identity: unknown; model_binding: unknown; target: RemoteModelTargetV2 }>(path.join(this.directory(offer), "route.json"));
    if (sha256JSON(value.identity) !== sha256JSON(this.identity(offer))
      || sha256JSON(value.model_binding) !== sha256JSON(remoteModelBinding(value.target))) throw fenced("remote model route differs from its worker lease");
    return value;
  }
  async recoveryTarget(offer: RemoteWorkOfferV1): Promise<RemoteModelTargetV2 | null> {
    if (!await readJSON(path.join(this.directory(offer), "route.json"), null)) return null;
    return structuredClone((await this.route(offer)).target);
  }
  async boundRun(offer: RemoteWorkOfferV1) {
    const route = await this.route(offer);
    const bound = await readJSON<{ run_id: string; model_binding_digest: string } | null>(path.join(this.directory(offer), "run.json"), null);
    if (!bound || !/^run_[a-f0-9]{32}$/.test(bound.run_id) || bound.model_binding_digest !== sha256JSON(route.model_binding)) throw fenced("remote model has no matching canonical run binding");
    const ack = await readJSON<unknown | null>(path.join(this.directory(offer), "bound.json"), null);
    if (!ack || sha256JSON(ack) !== sha256JSON(bound)) throw fenced("remote model run binding has not been acknowledged");
    return { runId: bound.run_id, binding: remoteModelBinding(route.target) };
  }
  async call(offer: RemoteWorkOfferV1, runId: string, operation: "bind" | "generate", body: unknown, signal: AbortSignal): Promise<Response> {
    if (!/^run_[a-f0-9]{32}$/.test(runId)) throw fenced("invalid remote canonical run ID");
    const route = await this.route(offer);
    if (route.target.kind === "managed-inference" && this.managedReady) {
      await waitForRecovery(this.managedReady.promise, signal);
      await this.authorize(offer);
    }
    await withFileLock(path.join(this.directory(offer), "locks"), "binding", async () => {
      const file = path.join(this.directory(offer), "run.json"), next = { run_id: runId, model_binding_digest: sha256JSON(route.model_binding) };
      const old = await readJSON<unknown | null>(file, null);
      if (old && sha256JSON(old) !== sha256JSON(next) || !old && operation !== "bind") throw fenced("remote lease cannot change its canonical run or generate before binding");
      if (!old) await atomicWriteJSON(file, next);
    });
    if (operation === "generate") await this.boundRun(offer);
    const result = await callRemoteModel(route.target, runId, operation, body, signal);
    if (operation === "bind") {
      signal.throwIfAborted();
      await atomicWriteJSON(path.join(this.directory(offer), "bound.json"), { run_id: runId, model_binding_digest: sha256JSON(route.model_binding) });
    }
    return result;
  }
}
async function waitForRecovery(ready: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    ready.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => {});
  });
  signal.throwIfAborted();
}
function fenced(message: string) { return new HitchError(message, { code: "remote_model_fenced", exitCode: 12 }); }
