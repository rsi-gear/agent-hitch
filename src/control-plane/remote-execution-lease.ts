import path from "node:path";
import type { RemoteWorkOfferV1 } from "../domain/index.js";
import { parseExecutionLease } from "../evals/index.js";
import { HitchError, readJSON, sha256JSON, statePaths } from "../foundation/index.js";

/** A frozen offer is not a renewal. Read the current controller lease without changing its epoch or expiry. */
export async function readRemoteExecutionLease(root: string, offer: RemoteWorkOfferV1) {
  const lease = parseExecutionLease(await readJSON(path.join(statePaths(root).evals, offer.lease.eval_id, "leases", `${offer.lease.lease_id}.json`)));
  const fields = ["lease_id", "eval_id", "work_id", "worker_id", "provider", "collision_domain_id", "epoch", "reservation"] as const;
  if (offer.state !== "accepted" || !["offered", "accepted", "running"].includes(lease.state) || Date.parse(lease.expires_at) <= Date.now()
    || fields.some(field => sha256JSON(lease[field]) !== sha256JSON(offer.lease[field]))
    || sha256JSON(lease.resource_epochs ?? [lease.epoch]) !== sha256JSON(offer.lease.resource_epochs ?? [offer.lease.epoch])) {
    throw new HitchError("remote execution lease is cancelled, expired or no longer active", { code: "remote_execution_lease_fenced", exitCode: 12 });
  }
  return lease;
}
