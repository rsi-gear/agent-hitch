import { performance } from "node:perf_hooks";
import type { EvalSchedulerSummaryV1 } from "../domain/index.js";

export class EvalSchedulerMetrics {
  private readonly startedAt = performance.now();
  private lastTransitionAt = this.startedAt;
  private active = 0;
  private weightedActiveMs = 0;
  private maxActive = 0;
  private finalSingleTailStartedAt: number | undefined;
  private finalSingleTailMs = 0;
  private initialWorkMs = 0;
  private retryWorkMs = 0;
  private verifierWorkMs = 0;
  private resourceBlockedMs = 0;
  private collisionBlockedMs = 0;
  private backoffBlockedMs = 0;
  private readonly running = new Map<string, { kind: "initial" | "retry"; startedAt: number }>();

  startWork(workId: string, kind: "initial" | "retry"): void {
    if (this.running.has(workId)) return;
    const now = performance.now();
    this.transition(now);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (this.active === 1) this.finalSingleTailStartedAt = now;
    else this.finalSingleTailStartedAt = undefined;
    this.running.set(workId, { kind, startedAt: now });
  }

  finishWork(workId: string): number {
    const entry = this.running.get(workId);
    if (!entry) return 0;
    const now = performance.now();
    this.transition(now);
    const duration = Math.max(0, now - entry.startedAt);
    if (entry.kind === "initial") this.initialWorkMs += duration;
    else this.retryWorkMs += duration;
    this.running.delete(workId);
    this.active = Math.max(0, this.active - 1);
    if (this.active === 1) this.finalSingleTailStartedAt = now;
    else if (this.active === 0 && this.finalSingleTailStartedAt !== undefined) {
      this.finalSingleTailMs = now - this.finalSingleTailStartedAt;
    }
    return Math.max(1, Math.round(duration));
  }

  addVerifier(durationMs: number): void {
    if (Number.isFinite(durationMs) && durationMs >= 0) this.verifierWorkMs += durationMs;
  }

  addBlocked(kind: "resource" | "collision" | "backoff", durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    if (kind === "resource") this.resourceBlockedMs += durationMs;
    else if (kind === "collision") this.collisionBlockedMs += durationMs;
    else this.backoffBlockedMs += durationMs;
  }

  summary(input: { maxParallelism: number; verifierSkipped: number; prioritized: boolean }): EvalSchedulerSummaryV1 {
    const now = performance.now();
    this.transition(now);
    const makespan = Math.max(1, now - this.startedAt);
    const physical = this.initialWorkMs + this.retryWorkMs;
    return {
      policy: input.prioritized ? "critical-path-lpt-v1" : "fifo-compat",
      makespan_ms: Math.round(makespan),
      physical_work_ms: Math.round(physical),
      initial_work_ms: Math.round(this.initialWorkMs),
      retry_work_ms: Math.round(this.retryWorkMs),
      verifier_work_ms: Math.round(this.verifierWorkMs),
      max_active: this.maxActive,
      effective_parallelism: rounded(this.weightedActiveMs / makespan),
      slot_utilization: rounded(this.weightedActiveMs / (makespan * Math.max(1, input.maxParallelism))),
      single_active_tail_ms: Math.round(this.active === 1 && this.finalSingleTailStartedAt !== undefined
        ? now - this.finalSingleTailStartedAt : this.finalSingleTailMs),
      resource_blocked_ms: Math.round(this.resourceBlockedMs),
      collision_blocked_ms: Math.round(this.collisionBlockedMs),
      backoff_blocked_ms: Math.round(this.backoffBlockedMs),
      verifier_skipped: input.verifierSkipped,
    };
  }

  private transition(now: number): void {
    this.weightedActiveMs += Math.max(0, now - this.lastTransitionAt) * this.active;
    this.lastTransitionAt = now;
  }
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
