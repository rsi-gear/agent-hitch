import { randomUUID } from "node:crypto";
import type { ResourceVectorV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import { ResourceLedger, validateResourceVector } from "./resources.js";

interface Waiter {
  ownerId: string;
  signal?: AbortSignal;
  resolve(value: { release(): void }): void;
  reject(error: unknown): void;
}

export class BuildSlotAdmission {
  private readonly ledger: ResourceLedger;
  private readonly resources: ResourceVectorV1;
  private readonly waiters: Waiter[] = [];
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(ledger: ResourceLedger, resources: ResourceVectorV1 = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 1 }) {
    this.ledger = ledger;
    this.resources = validateResourceVector(resources, "build admission resources");
    if (this.resources.build_slots < 1 || !ledger.canEverFit(this.resources)) throw new TypeError("build admission resources exceed capacity");
    this.unsubscribe = ledger.subscribe(() => this.drain());
  }

  acquire(signal?: AbortSignal): Promise<{ release(): void }> {
    if (this.closed) return Promise.reject(new HitchError("build admission is closed", { code: "build_admission_closed", exitCode: 12 }));
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { ownerId: `build_${randomUUID().replaceAll("-", "")}`, resolve, reject, ...(signal ? { signal } : {}) };
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(cancelled());
      };
      signal?.addEventListener("abort", abort, { once: true });
      const originalResolve = waiter.resolve;
      waiter.resolve = (value) => {
        signal?.removeEventListener("abort", abort);
        originalResolve(value);
      };
      this.waiters.push(waiter);
      this.drain();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const waiter of this.waiters.splice(0)) waiter.reject(new HitchError("build admission is closed", { code: "build_admission_closed", exitCode: 12 }));
  }

  private drain(): void {
    if (this.closed) return;
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0] as Waiter;
      if (waiter.signal?.aborted) {
        this.waiters.shift();
        waiter.reject(cancelled());
        continue;
      }
      const lease = this.ledger.tryAcquire(waiter.ownerId, "build", this.resources);
      if (!lease) return;
      this.waiters.shift();
      waiter.resolve({ release: lease.release });
    }
  }
}

function cancelled(): HitchError {
  return new HitchError("image build admission was cancelled", { code: "cancelled", exitCode: 9 });
}
