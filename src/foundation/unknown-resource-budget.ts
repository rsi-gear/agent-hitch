import type { WorkResourceProfilingV1 } from "../domain/index.js";

/** Additional admission constraint; it never substitutes for CPU/memory accounting. */
export class UnknownResourceBudget {
  private readonly active = new Map<symbol, WorkResourceProfilingV1>();
  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new TypeError("unknown resource capacity must be positive");
  }
  canEverFit(profile?: WorkResourceProfilingV1): boolean {
    if (!profile?.unknown) return true;
    if (!Number.isSafeInteger(profile.unknown_slots) || profile.unknown_slots < 1
      || !Number.isSafeInteger(profile.unknown_max_parallelism) || profile.unknown_max_parallelism < profile.unknown_slots) throw new TypeError("invalid unknown resource profiling slots");
    return profile.unknown_slots <= this.capacity;
  }
  tryAcquire(profile?: WorkResourceProfilingV1): (() => void) | null {
    if (!this.canEverFit(profile)) return null;
    if (!profile?.unknown) return () => {};
    const limit = Math.min(this.capacity, profile.unknown_max_parallelism, ...[...this.active.values()].map(value => value.unknown_max_parallelism));
    if (this.used() + profile.unknown_slots > limit) return null;
    const key = Symbol();
    this.active.set(key, structuredClone(profile));
    return () => { this.active.delete(key); };
  }
  snapshot(): { unknown_max_parallelism: number; active_unknown_slots: number; effective_limit: number } {
    return { unknown_max_parallelism: this.capacity, active_unknown_slots: this.used(),
      effective_limit: Math.min(this.capacity, ...[...this.active.values()].map(value => value.unknown_max_parallelism)) };
  }
  private used(): number { return [...this.active.values()].reduce((sum, value) => sum + value.unknown_slots, 0); }
}
