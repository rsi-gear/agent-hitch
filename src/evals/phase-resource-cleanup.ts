import type { BackendWorkItemV1, ExecutionLeaseV1 } from "../domain/index.js";
import { HitchError, hitchRootId } from "../foundation/index.js";
import { reapOwnedDockerResources } from "./docker-reaper.js";
import type { DockerReaperReportV1 } from "./docker-reaper.js";
import type { EvalDockerResourceReaper } from "./service-types.js";
import { confirmPhaseDockerBackend, phaseCleanupEnvironment, phaseDockerExecutionNeverStarted, readPhaseDockerBindings, recordPhaseDockerCleanup } from "./phase-docker-backend.js";

export function requiresConfirmedResourceCleanup(work: BackendWorkItemV1): boolean {
  // New profiling slots hold a scarce unknown-trial permit even when their
  // resource reservation still uses the conservative V1 sum. Protect every
  // profiled slot so mixed plans and their physical retries recover uniformly.
  return work.provider === "local-docker" && (work.schema_version === "2"
    || work.resource_profiling !== undefined && !work.opaque_membership && work.task_ids.length === 1 && work.slots.length === 1);
}

export function phaseCleanupUnconfirmed(cause?: unknown): HitchError {
  return new HitchError("phase execution cleanup is unconfirmed; its resource allocation remains held", {
    code: "phase_transition_unconfirmed", exitCode: 12, ...(cause === undefined ? {} : { cause }),
  });
}

/** Zero removals is valid when the backend already removed its resources.
 * A retained resource from another lease does not block this lease's release. */
export async function confirmPhaseResourceCleanup(input: {
  root: string; lease: ExecutionLeaseV1; trialParents: readonly string[]; env: NodeJS.ProcessEnv; reaper?: EvalDockerResourceReaper;
}): Promise<DockerReaperReportV1> {
  try {
    if (input.lease.state !== "released") throw phaseCleanupUnconfirmed();
    const bindings = await readPhaseDockerBindings({ root: input.root, leases: [input.lease], trialParents: input.trialParents });
    if (!bindings.length && await phaseDockerExecutionNeverStarted(input.root, input.lease)) {
      return { schema_version: "1", root_id: hitchRootId(input.root), scanned: 0, deleted: [], retained: [], issues: [] };
    }
    const env = await phaseCleanupEnvironment(bindings, input.env);
    await confirmPhaseDockerBackend(bindings, env);
    const report = await (input.reaper ?? reapOwnedDockerResources)({ root: input.root, leaseIds: [input.lease.lease_id], env });
    if (report.root_id !== hitchRootId(input.root) || report.issues.length
      || report.retained.some(resource => resource.reason !== "lease_not_selected")) throw phaseCleanupUnconfirmed();
    await confirmPhaseDockerBackend(bindings, env);
    await recordPhaseDockerCleanup(input.root, bindings);
    return report;
  } catch (error) { throw phaseCleanupUnconfirmed(error); }
}
