import type { SessionEvent } from "../domain/index.js";

export interface RequestAttempt {
  attempt: number;
  retryId?: string;
  retrySeq?: number;
}

/** Track DSH model request attempts incrementally so every projection uses the same retry boundary. */
export class IncrementalRequestAttemptTracker {
  private readonly attempts = new Map<string, RequestAttempt>();
  private readonly settled = new Set<string>();

  accept(event: SessionEvent): RequestAttempt | null {
    const identity = eventStep(event);
    if (!identity) return null;
    const key = stepKey(identity.turn, identity.step);
    if (event.type === "step/start") {
      this.attempts.set(key, { attempt: 0 });
      this.settled.delete(key);
    } else if (event.type === "llm/retry-started") {
      const current = this.current(identity.turn, identity.step);
      const data = event.data as Record<string, unknown>;
      this.attempts.set(stepKey(identity.turn, identity.step), {
        attempt: current.attempt + 1,
        retryId: data.retryId as string,
        retrySeq: event.seq,
      });
      this.settled.delete(key);
    } else if ((event.type === "assistant/attempt" || event.type === "assistant/message")
      && Array.isArray((event.data as Record<string, unknown>).stream)) {
      // A settlement is one attempt even when recovery did not emit llm/retry-started.
      if (this.settled.has(key)) this.attempts.set(key, { attempt: this.current(identity.turn, identity.step).attempt + 1 });
      this.settled.add(key);
    }
    const current = this.current(identity.turn, identity.step);
    if (event.type === "step/end") {
      this.attempts.delete(key);
      this.settled.delete(key);
    }
    return current;
  }

  current(turn: number, step: number): RequestAttempt {
    const key = stepKey(turn, step);
    const existing = this.attempts.get(key);
    if (existing) return existing;
    const initial = { attempt: 0 };
    this.attempts.set(key, initial);
    return initial;
  }
}

function eventStep(event: SessionEvent): { turn: number; step: number } | null {
  const data = event.data as Record<string, unknown>;
  return isNonNegativeInteger(data.turn) && isNonNegativeInteger(data.step)
    ? { turn: data.turn, step: data.step }
    : null;
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
