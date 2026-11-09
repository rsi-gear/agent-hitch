import type { EvalRequest } from "../domain/index.js";
import type { WorkItemAdmissionController } from "../evals/index.js";
import { evalTaskCollisionKey, evalWorkCollisionKey } from "./eval-records.js";
import type { WorkItemDispatcher } from "./work-dispatcher.js";
import { workSchedulingPriority } from "../evals/index.js";

export function workItemAdmission(input: {
  dispatcher: WorkItemDispatcher;
  request: EvalRequest;
  collisionDomainId: string;
  /** True only for an execution path that enforces per-work environment isolation. */
  isolatedSameTaskAttempts?: boolean;
}): WorkItemAdmissionController {
  return {
    isolatedSameTaskAttempts: input.isolatedSameTaskAttempts === true,
    acquire: async ({ evalId, workItem, maxParallelism, isolatedSameTaskAttempts, signal }) => {
      const permit = await input.dispatcher.acquire({
        evalId,
        workId: workItem.work_id,
        maxParallelism,
        reservation: workItem.reservation,
        collisionKeys: workItem.task_ids.map((taskId) => input.isolatedSameTaskAttempts === true && isolatedSameTaskAttempts === true
          ? evalWorkCollisionKey(input.request, taskId, input.collisionDomainId, evalId, workItem.work_id)
          : evalTaskCollisionKey(input.request, taskId, input.collisionDomainId)),
        priority: workSchedulingPriority(workItem),
        ...(signal ? { signal } : {}),
      });
      return {
        allocationId: permit.allocation.allocation_id,
        collisionKeys: permit.collision_keys,
        release: permit.release,
      };
    },
  };
}
