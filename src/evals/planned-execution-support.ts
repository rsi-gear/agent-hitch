import type { EvalExecutionPlanV1 } from "../domain/index.js";
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
}

export class FairSemaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.available = capacity;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("eval work item scheduling was cancelled");
    if (this.available > 0) {
      this.available -= 1;
      return this.releaseFunction();
    }
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal?.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = () => {
        const index = this.waiters.indexOf(ready);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("eval work item scheduling was cancelled"));
      };
      this.waiters.push(ready);
      signal?.addEventListener("abort", aborted, { once: true });
    });
    return this.releaseFunction();
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.available += 1;
    };
  }
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
