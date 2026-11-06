import path from "node:path";
import type { BackendWorkItemV1 } from "../domain/index.js";
import { configuredResourceStore, reclaimResourceExecution } from "../resources/index.js";
import type { ExecutionLeaseHandle } from "./execution-leases.js";
import { releaseLocalDockerProcessRecord } from "./local-docker-provider.js";
import { confirmPhaseResourceCleanup, phaseCleanupUnconfirmed, requiresConfirmedResourceCleanup } from "./phase-resource-cleanup.js";
import type { ExecutePlannedHarborOptions } from "./planned-execution.js";
import { emitWorkLeaseRelease } from "./resource-eval-lifecycle.js";

export async function finishPlannedLocalWork(input: {
  options: ExecutePlannedHarborOptions; item: BackendWorkItemV1; lease: ExecutionLeaseHandle;
  epoch: number; processRecorded: boolean; allocation: { held: boolean };
}): Promise<void> {
  const { options, item, lease, epoch, allocation } = input;
  const confirmedRequired = requiresConfirmedResourceCleanup(item);
  try {
    if (input.processRecorded) await releaseLocalDockerProcessRecord({ root: options.root, leaseId: lease.leaseId, epoch });
    const released = await lease.release(epoch);
    emitWorkLeaseRelease(options.sink, item.work_id, lease.leaseId, released.epoch, options.worker.workerId, released.state);
    if (options.dockerResourceReaper || confirmedRequired) {
      options.sink.emit({ type: "sandbox.cleanup.started", work_id: item.work_id, lease_id: lease.leaseId });
      try {
        const report = confirmedRequired
          ? await confirmPhaseResourceCleanup({ root: options.root, lease: lease.current(), env: options.env,
            trialParents: [path.join(options.evalDirectory, "harbor", "work-items", item.work_id, `epoch-${String(epoch).padStart(6, "0")}`, "job")],
            ...(options.dockerResourceReaper ? { reaper: options.dockerResourceReaper } : {}) })
          : await options.dockerResourceReaper!({ root: options.root, leaseIds: [lease.leaseId], env: options.env });
        allocation.held = false;
        options.sink.emit({ type: "eval.work-item.resources-reaped", work_id: item.work_id, lease_id: lease.leaseId, scanned: report.scanned, deleted: report.deleted.length, issues: report.issues.length });
        if (report.issues.length === 0) await reclaimResourceExecution((await configuredResourceStore(options.root)).store,
          path.join(options.evalDirectory, "harbor", "work-items", item.work_id, `epoch-${String(epoch).padStart(6, "0")}`, "resource-evidence.json"), true);
        options.sink.emit({ type: "sandbox.cleanup.completed", work_id: item.work_id, lease_id: lease.leaseId, scanned: report.scanned, deleted: report.deleted.length, residual_resources: report.issues.length });
      } catch (error) {
        options.sink.emit({ type: "eval.work-item.reaper-failed", work_id: item.work_id, lease_id: lease.leaseId, code: (error as { code?: string }).code || "docker_reaper_failed" });
        options.sink.emit({ type: "sandbox.cleanup.failed", work_id: item.work_id, lease_id: lease.leaseId, code: (error as { code?: string }).code || "docker_reaper_failed" });
        if (confirmedRequired && allocation.held) throw error;
      }
    }
  } catch (error) {
    if (confirmedRequired && allocation.held) throw phaseCleanupUnconfirmed(error);
    throw error;
  }
  await options.onWorkItemState?.(item.work_id, lease.leaseId, "terminal");
}
