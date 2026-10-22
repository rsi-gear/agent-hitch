import type { WorkItemAdmissionController } from "../evals/index.js";
import type { WorkItemDispatcher } from "./work-dispatcher.js";

/** The outer rerun operation holds task collision keys but no Docker budget.
 * Each physical work retains its own allocation through confirmed cleanup. */
export function localRerunWorkAdmission(dispatcher: WorkItemDispatcher, collisionKeys: string[], maxParallelism: number): WorkItemAdmissionController {
  return { acquire: async ({ evalId, workItem, signal }) => {
    const permit = await dispatcher.acquire({ evalId, workId: workItem.work_id, maxParallelism,
      reservation: workItem.reservation, ...(workItem.resource_profiling ? { resourceProfiling: workItem.resource_profiling } : {}),
      collisionKeys: [`rerun-work:${workItem.work_id}`], ...(signal ? { signal } : {}) });
    return { allocationId: permit.allocation.allocation_id, collisionKeys, release: permit.release };
  } };
}
