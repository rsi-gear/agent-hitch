const MAX_EVENT_TYPES = 128;
const MAX_TRACKED_OPERATIONS = 4_096;

interface DurationSummary {
  count: number;
  total_ms: number;
  max_ms: number;
  last_ms: number;
}

export class DaemonTelemetry {
  private readonly eventCounts = new Map<string, number>();
  private readonly durations = new Map<string, DurationSummary>();
  private readonly phaseDurations = new Map<string, DurationSummary>();
  private readonly queuedAt = new Map<string, number>();
  private readonly workStartedAt = new Map<string, number>();
  private readonly backendStartedAt = new Map<string, number>();
  private readonly rerunsByType = new Map<string, number>();
  private buildHits = 0;
  private buildMisses = 0;
  private buildWaits = 0;
  private leaseRecoveries = 0;
  private validTrials = 0;
  private invalidTrials = 0;
  private physicalRetries = 0;
  private candidateReruns = 0;
  private sealedBundles = 0;
  private captureDegradations = 0;
  private cleanupFailures = 0;
  private residualResources = 0;
  private lastEventAt: string | null = null;

  observe(event: Record<string, unknown>): void {
    const type = typeof event.type === "string" ? event.type.slice(0, 256) : "unknown";
    if (this.eventCounts.has(type) || this.eventCounts.size < MAX_EVENT_TYPES) {
      this.eventCounts.set(type, (this.eventCounts.get(type) ?? 0) + 1);
    }
    const duration = Number(event.duration_ms);
    if (Number.isSafeInteger(duration) && duration >= 0) {
      observeDuration(this.durations, type, duration);
    }
    this.observePhases(type, event, Number.isSafeInteger(duration) && duration >= 0 ? duration : undefined);
    if (type === "build.cache_hit") this.buildHits += 1;
    if (type === "build.started") this.buildMisses += 1;
    if (type === "build.wait") this.buildWaits += 1;
    if (type === "lease.recovered") this.leaseRecoveries += 1;
    if (type === "eval.trial.published") event.observation_status === "valid" ? this.validTrials += 1 : this.invalidTrials += 1;
    if (type === "eval.physical-retry.started") this.physicalRetries += 1;
    if (type === "eval.rerun.started") {
      const rerunType = typeof event.rerun_type === "string" ? event.rerun_type.slice(0, 64) : "unknown";
      this.rerunsByType.set(rerunType, (this.rerunsByType.get(rerunType) ?? 0) + 1);
      if (rerunType === "candidate-restart") this.candidateReruns += 1;
    }
    if (type === "result.bundle.sealed") this.sealedBundles += 1;
    if (type === "interaction.capture.degraded") this.captureDegradations += 1;
    if (type === "sandbox.cleanup.failed") this.cleanupFailures += 1;
    if (type === "sandbox.cleanup.completed") this.residualResources = safeAdd(this.residualResources, nonNegative(event.residual_resources));
    this.lastEventAt = new Date().toISOString();
  }

  snapshot(): Record<string, unknown> {
    return {
      event_counts: Object.fromEntries([...this.eventCounts].sort(([left], [right]) => left.localeCompare(right))),
      durations_ms: Object.fromEntries([...this.durations].sort(([left], [right]) => left.localeCompare(right)).map(([type, value]) => [type, { ...value }])),
      phase_durations_ms: Object.fromEntries([...this.phaseDurations].sort(([left], [right]) => left.localeCompare(right)).map(([type, value]) => [type, { ...value }])),
      phase_resolution: { agent: "harbor-agent-wrapper", verifier: "harbor-verifier-wrapper", fallback_metric: "backend_agent_verifier" },
      build_cache: { hits: this.buildHits, misses: this.buildMisses, waits: this.buildWaits },
      lease_recoveries: this.leaseRecoveries,
      trials: {
        valid: this.validTrials,
        invalid: this.invalidTrials,
        physical_retries: this.physicalRetries,
        candidate_reruns: this.candidateReruns,
        reruns_by_type: Object.fromEntries([...this.rerunsByType].sort(([left], [right]) => left.localeCompare(right))),
      },
      bundles: { sealed: this.sealedBundles },
      capture: { degraded: this.captureDegradations },
      cleanup: { failures: this.cleanupFailures, residual_resources: this.residualResources },
      last_event_at: this.lastEventAt,
    };
  }

  private observePhases(type: string, event: Record<string, unknown>, duration: number | undefined): void {
    const now = Date.now();
    const evalId = identifier(event.eval_id);
    const runId = identifier(event.run_id);
    const workId = identifier(event.work_id);
    if (type === "eval.queued" && evalId) track(this.queuedAt, `eval:${evalId}`, now);
    if (type === "run.queued" && runId) track(this.queuedAt, `run:${runId}`, now);
    if (type === "eval.started" && evalId) observeElapsed(this.phaseDurations, "queue_wait", this.queuedAt, `eval:${evalId}`, now);
    if (type === "run.started" && runId) observeElapsed(this.phaseDurations, "queue_wait", this.queuedAt, `run:${runId}`, now);
    if (type === "eval.dispatch.started" && duration !== undefined) {
      observeDuration(this.phaseDurations, "queue_wait", duration);
      if (evalId) this.queuedAt.delete(`eval:${evalId}`);
    }
    if (type === "eval.plan.created" && duration !== undefined) observeDuration(this.phaseDurations, "planning", duration);
    if ((type === "build.completed" || type === "build.failed") && duration !== undefined) observeDuration(this.phaseDurations, "build", duration);
    if (type === "eval.setup.completed" && duration !== undefined) observeDuration(this.phaseDurations, "setup", duration);
    if (type === "eval.agent.completed" && duration !== undefined) observeDuration(this.phaseDurations, "agent", duration);
    if (type === "eval.verifier.completed" && duration !== undefined) observeDuration(this.phaseDurations, "verifier", duration);
    if (type === "eval.collection.completed" && duration !== undefined) observeDuration(this.phaseDurations, "collection", duration);
    if (type === "eval.work.started" && workId) track(this.workStartedAt, workId, now);
    if (type === "eval.backend.started" && workId) {
      observeElapsed(this.phaseDurations, "controller_setup", this.workStartedAt, workId, now);
      track(this.backendStartedAt, workId, now);
    }
    if (type === "eval.backend.completed" && workId) {
      observeElapsed(this.phaseDurations, "backend_agent_verifier", this.backendStartedAt, workId, now, false);
      track(this.backendStartedAt, `collection:${workId}`, now);
    }
    if (type === "result.bundle.sealed" && workId) observeElapsed(this.phaseDurations, "collection", this.backendStartedAt, `collection:${workId}`, now, false);
    if ((type === "eval.work.completed" || type === "eval.work.lost") && workId) {
      this.workStartedAt.delete(workId);
      this.backendStartedAt.delete(workId);
      this.backendStartedAt.delete(`collection:${workId}`);
    }
  }
}

function observeDuration(target: Map<string, DurationSummary>, key: string, duration: number): void {
  const current = target.get(key) ?? { count: 0, total_ms: 0, max_ms: 0, last_ms: 0 };
  current.count += 1;
  current.total_ms = safeAdd(current.total_ms, duration);
  current.max_ms = Math.max(current.max_ms, duration);
  current.last_ms = duration;
  target.set(key, current);
}

function observeElapsed(target: Map<string, DurationSummary>, key: string, starts: Map<string, number>, identity: string, now: number, remove = true): void {
  const started = starts.get(identity);
  if (started === undefined) return;
  observeDuration(target, key, Math.max(0, now - started));
  if (remove) starts.delete(identity);
}

function track(target: Map<string, number>, identity: string, now: number): void {
  if (target.has(identity) || target.size < MAX_TRACKED_OPERATIONS) target.set(identity, now);
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && value.length <= 256 ? value : null;
}

function nonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}
