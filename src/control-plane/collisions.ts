export interface CollisionLease {
  ownerId: string;
  keys: string[];
  release(): void;
}

export class CollisionLockManager {
  private readonly owners = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  tryAcquire(ownerId: string, keys: readonly string[]): CollisionLease | null {
    if (!ownerId) throw new TypeError("collision owner must be non-empty");
    const normalized = [...new Set(keys)].sort();
    if (normalized.some((key) => !key)) throw new TypeError("collision key must be non-empty");
    if (normalized.some((key) => this.owners.has(key))) return null;
    for (const key of normalized) this.owners.set(key, ownerId);
    let released = false;
    return {
      ownerId,
      keys: normalized,
      release: () => {
        if (released) return;
        released = true;
        for (const key of normalized) {
          if (this.owners.get(key) === ownerId) this.owners.delete(key);
        }
        for (const listener of this.listeners) queueMicrotask(listener);
      },
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): Array<{ key: string; owner_id: string }> {
    return [...this.owners.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([key, owner_id]) => ({ key, owner_id }));
  }
}

