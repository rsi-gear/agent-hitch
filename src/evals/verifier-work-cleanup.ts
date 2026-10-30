import path from "node:path";
import type { BackendWorkItemV1 } from "../domain/index.js";
import { atomicWriteJSON } from "../foundation/index.js";
import { reapOwnedDockerResources } from "./docker-reaper.js";
import type { ExecutionLeaseHandle } from "./execution-leases.js";
import { confirmPhaseResourceCleanup, requiresConfirmedResourceCleanup } from "./phase-resource-cleanup.js";
import type { EvalDockerResourceReaper } from "./service-types.js";

/** Every local V2 allocation needs confirmed cleanup, including conservative
 * tasks in a mixed plan which have no mutually exclusive phase contract. */
export async function finishVerifierOnlyWork(input: {
  root: string; env: NodeJS.ProcessEnv; work: BackendWorkItemV1; lease: ExecutionLeaseHandle;
  evidence: string; reaper?: EvalDockerResourceReaper; permit?: { release(): void };
}): Promise<void> {
  // Releasing the persisted lease authorizes the reaper, but keeps the global
  // allocation until its resources have been confirmed absent.
  await input.lease.release();
  const cleanup = requiresConfirmedResourceCleanup(input.work)
    ? await confirmPhaseResourceCleanup({ root: input.root, env: input.env, lease: input.lease.current(),
      trialParents: [path.join(input.evidence, "trials")], ...(input.reaper ? { reaper: input.reaper } : {}) })
    : await (input.reaper ?? reapOwnedDockerResources)({ root: input.root, env: input.env, leaseIds: [input.lease.leaseId] });
  await atomicWriteJSON(path.join(input.evidence, "cleanup.json"), cleanup);
  input.permit?.release();
}
