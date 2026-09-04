export interface SchedulerTraceWorkV1 {
  work_id: string;
  task_id: string;
  execution_kind: "initial" | "physical-infrastructure-retry";
  retry_index: number;
  duration_ms: number;
  queued_order: number;
}

export interface SchedulerTraceReplayV1 {
  makespan_ms: number;
  physical_work_ms: number;
  max_active: number;
  slot_utilization: number;
  runnable_idle_ms: number;
}

export function replaySchedulerTrace(
  work: readonly SchedulerTraceWorkV1[],
  options: {
    slots: number;
    policy: "fifo-v1" | "critical-path-v1";
    retryScheduling: "batch-v1" | "immediate-v1";
  },
): SchedulerTraceReplayV1 {
  if (!Number.isSafeInteger(options.slots) || options.slots < 1) throw new TypeError("trace replay slots are invalid");
  const chains = traceChains(work);
  const replay = options.retryScheduling === "batch-v1"
    ? replayBatch(chains, options.slots, options.policy)
    : replayImmediate(chains, options.slots, options.policy);
  const physicalWorkMs = work.reduce((sum, item) => sum + item.duration_ms, 0);
  return {
    makespan_ms: replay.makespanMs,
    physical_work_ms: physicalWorkMs,
    max_active: replay.maxActive,
    slot_utilization: rounded(physicalWorkMs / (Math.max(1, replay.makespanMs) * options.slots)),
    runnable_idle_ms: 0,
  };
}

interface TraceChain {
  taskId: string;
  stages: SchedulerTraceWorkV1[];
}

interface ReadyStage {
  chain: TraceChain;
  index: number;
  remainingMs: number;
}

interface ReplayResult {
  makespanMs: number;
  maxActive: number;
}

function traceChains(work: readonly SchedulerTraceWorkV1[]): TraceChain[] {
  const byTask = new Map<string, SchedulerTraceWorkV1[]>();
  const ids = new Set<string>();
  for (const item of work) {
    validateTraceWork(item);
    if (ids.has(item.work_id)) throw new TypeError(`trace work identity is duplicated: ${item.work_id}`);
    ids.add(item.work_id);
    const stages = byTask.get(item.task_id) ?? [];
    stages.push(item);
    byTask.set(item.task_id, stages);
  }
  const chains = [...byTask.entries()].map(([taskId, stages]) => ({
    taskId,
    stages: stages.sort((left, right) => left.retry_index - right.retry_index),
  }));
  for (const chain of chains) {
    if (chain.stages[0]?.execution_kind !== "initial" || chain.stages[0]?.retry_index !== 0
      || chain.stages.some((stage, index) => stage.retry_index !== index
        || (index > 0 && stage.execution_kind !== "physical-infrastructure-retry"))) {
      throw new TypeError(`trace work chain is invalid: ${chain.taskId}`);
    }
  }
  return chains.sort((left, right) => compareBytes(left.taskId, right.taskId));
}

function replayBatch(chains: readonly TraceChain[], slots: number, policy: "fifo-v1" | "critical-path-v1"): ReplayResult {
  let now = 0;
  let maxActive = 0;
  const stages = Math.max(0, ...chains.map((chain) => chain.stages.length));
  for (let index = 0; index < stages; index += 1) {
    const ready = chains.flatMap((chain) => chain.stages[index]
      ? [{ chain, index, remainingMs: remaining(chain, index) }]
      : []);
    maxActive = Math.max(maxActive, Math.min(slots, ready.length));
    now = scheduleReady(ready, slots, policy, now);
  }
  return { makespanMs: now, maxActive };
}

function replayImmediate(chains: readonly TraceChain[], slots: number, policy: "fifo-v1" | "critical-path-v1"): ReplayResult {
  const ready: ReadyStage[] = chains.map((chain) => ({ chain, index: 0, remainingMs: remaining(chain, 0) }));
  const running: Array<ReadyStage & { completedAt: number }> = [];
  let now = 0;
  let maxActive = 0;
  while (ready.length > 0 || running.length > 0) {
    ready.sort((left, right) => compareReady(left, right, policy));
    while (running.length < slots && ready.length > 0) {
      const item = ready.shift() as ReadyStage;
      running.push({ ...item, completedAt: now + (item.chain.stages[item.index]?.duration_ms ?? 0) });
    }
    maxActive = Math.max(maxActive, running.length);
    running.sort((left, right) => left.completedAt - right.completedAt || compareBytes(left.chain.taskId, right.chain.taskId));
    const completed = running.shift();
    if (!completed) break;
    now = completed.completedAt;
    const next = completed.index + 1;
    if (completed.chain.stages[next]) ready.push({ chain: completed.chain, index: next, remainingMs: remaining(completed.chain, next) });
  }
  return { makespanMs: now, maxActive };
}

function scheduleReady(ready: ReadyStage[], slots: number, policy: "fifo-v1" | "critical-path-v1", start: number): number {
  ready.sort((left, right) => compareReady(left, right, policy));
  const available = Array.from({ length: slots }, () => start);
  for (const item of ready) {
    const earliest = Math.min(...available);
    const slot = available.indexOf(earliest);
    available[slot] = earliest + (item.chain.stages[item.index]?.duration_ms ?? 0);
  }
  return Math.max(start, ...available);
}

function compareReady(left: ReadyStage, right: ReadyStage, policy: "fifo-v1" | "critical-path-v1"): number {
  if (policy === "critical-path-v1" && left.remainingMs !== right.remainingMs) return right.remainingMs - left.remainingMs;
  const leftStage = left.chain.stages[left.index] as SchedulerTraceWorkV1;
  const rightStage = right.chain.stages[right.index] as SchedulerTraceWorkV1;
  return leftStage.queued_order - rightStage.queued_order || compareBytes(leftStage.work_id, rightStage.work_id);
}

function remaining(chain: TraceChain, index: number): number {
  return chain.stages.slice(index).reduce((sum, stage) => sum + stage.duration_ms, 0);
}

function validateTraceWork(item: SchedulerTraceWorkV1): void {
  if (!item.work_id || !item.task_id || !Number.isSafeInteger(item.duration_ms) || item.duration_ms < 1
    || !Number.isSafeInteger(item.queued_order) || item.queued_order < 0
    || !Number.isSafeInteger(item.retry_index) || item.retry_index < 0
    || (item.execution_kind === "initial") !== (item.retry_index === 0)) throw new TypeError("scheduler trace work is invalid");
}

function rounded(value: number): number { return Math.round(value * 1_000) / 1_000; }
function compareBytes(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
