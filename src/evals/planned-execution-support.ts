import type { BackendWorkItemV1, EvalExecutionPlanV1 } from "../domain/index.js";
import type { EvalTrialRefV1 } from "../domain/index.js";
import type { HarborBackendResult } from "../backends/index.js";

export interface PlannedBackendRun {
  attempt: number;
  workId: string;
  tasks: string[];
  refs: EvalTrialRefV1[];
  leaseId: string;
  run: HarborBackendResult;
  environmentImages?: import("./trial-environment-evidence.js").TrialEnvironmentImagesV1;
  durationMs?: number;
}

export class PrioritySemaphore {
  private available: number;
  private readonly waiters: Array<{ priority: number; sequence: number; ready: () => void }> = [];
  private sequence = 0;

  constructor(capacity: number) {
    this.available = capacity;
  }

  async acquire(signal?: AbortSignal, priority = 0): Promise<() => void> {
    if (signal?.aborted) throw new Error("eval work item scheduling was cancelled");
    if (!Number.isFinite(priority) || priority < 0) throw new TypeError("eval work item scheduling priority is invalid");
    if (this.available > 0) {
      this.available -= 1;
      return this.releaseFunction();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = { priority, sequence: this.sequence++, ready: () => {
        signal?.removeEventListener("abort", aborted);
        resolve();
      } };
      const aborted = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("eval work item scheduling was cancelled"));
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", aborted, { once: true });
    });
    return this.releaseFunction();
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.sort(compareWaiters).shift();
      if (next) next.ready();
      else this.available += 1;
    };
  }
}

/** Compatibility name for callers that do not supply priorities. */
export class FairSemaphore extends PrioritySemaphore {}

export function workSchedulingPriority(item: BackendWorkItemV1): number {
  return item.scheduling?.remaining_path_ms ?? 0;
}

function compareWaiters(left: { priority: number; sequence: number }, right: { priority: number; sequence: number }): number {
  return right.priority - left.priority || left.sequence - right.sequence;
}

export function assertTaskSlotPlan(plan: EvalExecutionPlanV1): void {
  if (plan.membership !== "known" || plan.work_items.length === 0
    || plan.work_items.some((item) => item.opaque_membership || item.task_ids.length !== 1 || item.slots.length !== 1
      || item.logical_attempt === null || item.requested_parallelism !== 1)) {
    throw new TypeError("planned Harbor execution requires one known trial slot per work item");
  }
}

export function workOrder(plan: EvalExecutionPlanV1, workId: string): number {
  return plan.work_items.findIndex((item) => item.work_id === workId);
}
