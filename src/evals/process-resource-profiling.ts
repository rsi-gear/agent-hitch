import { randomUUID } from "node:crypto";
import type { WorkResourceProfilingV1 } from "../domain/index.js";
import { UnknownResourceBudget } from "../foundation/index.js";
import type { WorkItemAdmissionController } from "./service-types.js";
import { PrioritySemaphore, workSchedulingPriority } from "./planned-execution-support.js";

const budget = new UnknownResourceBudget(10_000);
const pending: Array<{ profile: WorkResourceProfilingV1; signal?: AbortSignal; abort: () => void; resolve: (release: () => void) => void }> = [];

/** Shared by all direct evals/reruns in this process. No cross-process guarantee. */
export function acquireProcessResourceProfiling(profile?: WorkResourceProfilingV1, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(new Error("resource profiling admission cancelled"));
  if (!profile?.unknown) return Promise.resolve(() => {});
  if (!budget.canEverFit(profile)) return Promise.reject(new TypeError("unknown resource request exceeds process profiling capacity"));
  return new Promise((resolve, reject) => {
    const entry = { profile, ...(signal ? { signal } : {}), resolve, abort: () => {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
      reject(new Error("resource profiling admission cancelled"));
      drain();
    } };
    pending.push(entry);
    signal?.addEventListener("abort", entry.abort, { once: true });
    drain();
  });
}

function drain(): void {
  for (const entry of [...pending]) {
    const release = budget.tryAcquire(entry.profile);
    if (!release) continue;
    pending.splice(pending.indexOf(entry), 1);
    entry.signal?.removeEventListener("abort", entry.abort);
    let released = false;
    entry.resolve(() => { if (!released) { released = true; release(); drain(); } });
  }
}

export function processWorkItemAdmission(maxParallelism: number): WorkItemAdmissionController {
  const semaphore = new PrioritySemaphore(maxParallelism);
  return { acquire: async ({ workItem, signal }) => {
    const releaseUnknown = await acquireProcessResourceProfiling(workItem.resource_profiling, signal);
    let releaseParallelism: () => void;
    try { releaseParallelism = await semaphore.acquire(signal, workSchedulingPriority(workItem)); }
    catch (error) { releaseUnknown(); throw error; }
    return { allocationId: `allocation_${randomUUID().replaceAll("-", "")}`, collisionKeys: [],
      release: () => { releaseParallelism(); releaseUnknown(); } };
  } };
}
